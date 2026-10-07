import { OpenCode } from "@opencode/sdk"
import { AgentConfig } from "./types.js"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * opencode SDK v2 host.
 *
 * v2 is an in-process host: `OpenCode.create()` runs the server's HTTP router in
 * memory, so there is no port to bind, no child process to spawn, and no stdout
 * to parse. The whole surface is `oc.sessions.*` plus `oc.message.list()`.
 */

export interface OpencodeContext {
  client: OpencodeClient
  /** Closes the host and releases its router, database and file watchers. */
  close(): Promise<void>
  /** Absolute path of the generated opencode.json that defines the role agents. */
  configPath: string
}

export type OpencodeClient = Awaited<ReturnType<typeof OpenCode.create>>

/** Agent ids declared in the generated opencode.json, one per loop role. */
export const ROLE_AGENTS = ["planner", "generator", "evaluator"] as const

export type RoleAgent = (typeof ROLE_AGENTS)[number]

/** Infrastructure failure: the harness could not talk to the model at all. */
export class OpencodeRequestError extends Error {
  readonly kind = "infra" as const

  constructor(label: string, message: string) {
    super(`${label}: ${message}`)
    this.name = "OpencodeRequestError"
  }
}

/** The provider answered, but with an error (auth, rate limit, model not found). */
export class ProviderError extends Error {
  readonly kind = "infra" as const

  constructor(errorType: string, message: string, status?: number) {
    super(`provider error ${errorType}: ${message}${status ? ` (HTTP ${status})` : ""}`)
    this.name = "ProviderError"
  }
}

export class EmptyResponseError extends Error {
  readonly kind = "infra" as const

  constructor(label: string) {
    super(`${label}: model returned an empty response`)
    this.name = "EmptyResponseError"
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * opencode persists credentials, sessions and the models.dev catalog in one
 * SQLite database. Pointing at it means whatever the user configured through
 * `opencode auth login` is visible here without copying secrets around.
 */
export function opencodeDatabasePath(): string {
  const override = process.env.OPENCODE_DB_PATH
  if (override) return override

  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(dataHome, "opencode", "opencode.db")
}

export interface AgentDefinition {
  description: string
  mode: "primary"
  system: string
}

/**
 * Writes the role agents to an opencode.json inside the workspace.
 *
 * v2 reads agent definitions and the default model from a config *file*. A
 * `config` object passed to OpenCode.create() is ignored, which is why the roles
 * have to be materialised on disk rather than passed programmatically.
 */
export function writeAgentConfig(
  workspacePath: string,
  model: string,
  agents: Record<string, AgentDefinition>,
): string {
  const configPath = path.join(workspacePath, "opencode.json")

  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    },
    agents,
  }

  fs.mkdirSync(workspacePath, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")

  return configPath
}

export async function startOpencode(
  agentConfig: AgentConfig,
  workspacePath: string,
): Promise<OpencodeContext> {
  const apiKeyEnvVar = `${providerOf(agentConfig.model).toUpperCase()}_API_KEY`
  if (agentConfig.apiKey && !process.env[apiKeyEnvVar]) {
    process.env[apiKeyEnvVar] = agentConfig.apiKey
  }

  const client = await OpenCode.create({
    database: { path: opencodeDatabasePath() },
  })

  return {
    client,
    configPath: path.join(workspacePath, "opencode.json"),
    close: async () => {
      await client.close()
    },
  }
}

function providerOf(model: string): string {
  const slash = model.indexOf("/")
  return slash === -1 ? model : model.substring(0, slash)
}

export interface PreflightResult {
  ok: boolean
  error?: string
  hint?: string
  warning?: string
}

interface ProviderShape {
  id?: string
  activation?: string
}

interface ModelShape {
  providerID?: string
  modelID?: string
  enabled?: boolean
  status?: string
}

async function listModels(
  client: OpencodeClient,
  directory: string,
): Promise<ModelShape[]> {
  const result = await client.model
    .list({ location: { directory } })
    .catch(() => ({ data: [] as ModelShape[] }))
  return (result.data ?? []) as ModelShape[]
}

/**
 * Ensures the provider catalog is hydrated before the loop starts.
 *
 * On a fresh process `model.list()` comes back empty even when a valid
 * credential is on disk: the catalog is only populated once an integration has
 * been connected. `connect.key()` is the trigger, but it reports failure (and
 * throws) even when it succeeds, so the only trustworthy signal is whether
 * `model.list()` became non-empty afterwards.
 *
 * `location.reload()` would undo the hydration, so it is never called.
 */
export async function ensureProvidersHydrated(
  client: OpencodeClient,
  config: AgentConfig,
): Promise<void> {
  let models = await listModels(client, config.workspacePath)
  if (models.length > 0) return

  const providerID = providerOf(config.model)

  // A missing credential should surface as a clear preflight error rather than
  // as a silently empty catalog.
  const creds = await client.credential.list({}).catch(() => null)
  if (creds && creds.length === 0) {
    throw new OpencodeRequestError(
      "preflight",
      `no credentials stored. Run \`opencode auth login\` or export ${providerID.toUpperCase()}_API_KEY.`,
    )
  }

  // Best effort: the return value is unreliable, only the catalog matters.
  await client.integration.connect
    .key({ integrationID: providerID, key: process.env[`${providerID.toUpperCase()}_API_KEY`] ?? "" })
    .catch(() => {})

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    models = await listModels(client, config.workspacePath)
    if (models.length > 0) return
  }

  throw new OpencodeRequestError(
    "preflight",
    `provider catalog stayed empty after hydrating "${providerID}".`,
  )
}

/**
 * Verifies before the loop starts that the configured provider is available and
 * the model id exists, so a typo costs three seconds instead of a run that dies
 * in the planner with an unparseable response.
 */
export async function preflightProvider(
  client: OpencodeClient,
  config: AgentConfig,
): Promise<PreflightResult> {
  const providerID = providerOf(config.model)
  const modelID = config.model.includes("/")
    ? config.model.slice(config.model.indexOf("/") + 1)
    : config.model

  const providers = await client.provider
    .list({ location: { directory: config.workspacePath } })
    .catch(() => ({ data: [] as ProviderShape[] }))

  const providerIds = ((providers.data ?? []) as ProviderShape[])
    .map((p) => p.id)
    .filter((id): id is string => typeof id === "string")

  if (providerIds.length > 0 && !providerIds.includes(providerID)) {
    return {
      ok: false,
      error: `Provider "${providerID}" is not available to opencode.`,
      hint: `Available providers: ${providerIds.join(", ")}`,
    }
  }

  const models = await listModels(client, config.workspacePath)
  const modelIds = models.map((m) => m.modelID).filter((id): id is string => typeof id === "string")

  if (modelIds.length > 0 && !modelIds.includes(modelID)) {
    return {
      ok: false,
      error: `Model "${config.model}" does not exist on provider "${providerID}".`,
      hint: `Available models: ${modelIds.join(", ")}`,
    }
  }

  if (models.length === 0) {
    return {
      ok: false,
      error: `opencode reported no models at all, so "${config.model}" cannot be verified.`,
      hint: `Run \`opencode models\` to check the provider is reachable.`,
    }
  }

  return { ok: true }
}

export async function createSession(
  client: OpencodeClient,
  title: string,
  directory: string,
  model: { id: string; providerID: string },
  agent: string,
): Promise<string> {
  return withRetry(async () => {
    const session = await client.sessions.create({
      title,
      location: { directory },
      model,
      agent,
    })
    return session.id
  }, "createSession")
}

export interface PromptUsage {
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface PromptResult {
  text: string
  sessionId: string
  messageId: string
  usage: PromptUsage
}

interface MessageShape {
  id?: string
  type?: string
  outcome?: string
  content?: { type?: string; text?: string }[]
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  error?: { type?: string; message?: string; status?: number }
}

function extractText(message: MessageShape): string {
  let text = ""
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text
    }
  }
  return text
}

function extractUsage(message: MessageShape): PromptUsage {
  return {
    cost: message.cost ?? 0,
    input: message.tokens?.input ?? 0,
    output: message.tokens?.output ?? 0,
    reasoning: message.tokens?.reasoning ?? 0,
    cacheRead: message.tokens?.cache?.read ?? 0,
    cacheWrite: message.tokens?.cache?.write ?? 0,
  }
}

/**
 * The last assistant message for a session, or null when the model produced
 * none.
 *
 * In v2 `sessions.prompt()` only enqueues a user turn and returns immediately;
 * the reply has to be read back from the message list after `sessions.wait()`.
 */
export async function readLastAssistantMessage(
  client: OpencodeClient,
  sessionId: string,
): Promise<MessageShape | null> {
  const result = await client.message
    .list({ sessionID: sessionId })
    .catch(() => ({ data: [] as MessageShape[] }))

  const messages = (result.data ?? []) as MessageShape[]
  for (const message of messages) {
    if (message.type === "assistant") return message
  }
  return null
}

export interface SendPromptOptions {
  client: OpencodeClient
  sessionId: string
  text: string
  directory: string
  label: string
  /** Appended to state/log.md: which role issued this prompt. */
  role?: string
  /** Called with each line of the raw session log while the prompt runs. */
  onTrace?: (line: string) => void
}

/**
 * Streams the raw session log to a sink while a prompt runs.
 *
 * This is the trace that makes a failed run diagnosable: `state/log.md` records
 * what the harness decided, but only the session log records what the agent
 * actually did (tool calls, files written, retries).
 */
async function streamSessionLog(
  client: OpencodeClient,
  sessionId: string,
  sink: (line: string) => void,
): Promise<void> {
  const seen = new Set<number>()

  try {
    for await (const item of client.session.log({ sessionID: sessionId })) {
      const record = item as unknown as Record<string, unknown>
      const id = typeof record.id === "number" ? record.id : undefined
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }

      const type = typeof record.type === "string" ? record.type : "event"
      const properties = record.properties as Record<string, unknown> | undefined

      let detail = ""
      if (properties) {
        if (typeof properties.tool === "string") detail = properties.tool
        else if (typeof properties.file === "string") detail = properties.file
        else if (typeof properties.message === "string") {
          detail = properties.message.slice(0, 200)
        }
      }

      sink(`  ${type}${detail ? ` ${detail}` : ""}`)
    }
  } catch {
    // Tracing is best effort; a failed stream must not fail the prompt.
  }
}

export async function sendPrompt(options: SendPromptOptions): Promise<PromptResult> {
  const { client, sessionId, text, label, role, onTrace } = options

  return withRetry(async () => {
    if (onTrace) {
      // Not awaited: the prompt below is the long pole, and the stream is torn
      // down when the session goes idle.
      void streamSessionLog(client, sessionId, onTrace)
    }

    if (isShutdownRequested()) throw new InterruptedError(label)

    await client.sessions.prompt({ sessionID: sessionId, text }, requestOptions())
    await client.sessions.wait({ sessionID: sessionId }, requestOptions())

    if (isShutdownRequested()) throw new InterruptedError(label)

    const message = await readLastAssistantMessage(client, sessionId)

    if (!message) {
      throw new EmptyResponseError(label)
    }

    if (message.error) {
      throw new ProviderError(
        message.error.type ?? "unknown",
        message.error.message ?? "no detail",
        message.error.status,
      )
    }

    if (isShutdownRequested()) throw new InterruptedError(label)

    const replyText = extractText(message)
    if (!replyText.trim()) {
      throw new EmptyResponseError(label)
    }

    return {
      text: replyText,
      sessionId,
      messageId: message.id ?? "",
      usage: extractUsage(message),
    }
  }, label)
}

const MAX_API_RETRIES = 3
const BASE_RETRY_DELAY = 2000

/** Only failures that can plausibly succeed on a second identical attempt. */
function isTransient(err: unknown): boolean {
  // An interrupted request must not be retried.
  if (err instanceof InterruptedError) return false

  const message = describeError(err)

  if (err instanceof TypeError) {
    return /fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      message,
    )
  }

  if (err instanceof ProviderError) {
    return /rate|429|overload|quota|temporar|timeout|5\d\d/i.test(message)
  }

  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|429|503|502|504/i.test(
    message,
  )
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (attempt === MAX_API_RETRIES) break
      if (!isTransient(err)) throw err

      const base = BASE_RETRY_DELAY * Math.pow(2, attempt)
      const delay = Math.round(base * (0.5 + Math.random() * 0.5))
      console.error(
        `  [RETRY] ${label} attempt ${attempt + 1}/${MAX_API_RETRIES} failed: ` +
        `${describeError(err)}. Retrying in ${(delay / 1000).toFixed(1)}s...`,
      )

      await sleep(delay)
    }
  }

  throw lastError
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Process-wide abort signal, wired into every SDK request.
 *
 * Without this, Ctrl+C during an in-flight provider call leaves the loop
 * awaiting a promise that only resolves when the model finishes, so the process
 * appears hung and can only be killed (which crashes in native teardown).
 * Aborting the request instead lets the call reject, the loop unwind, and the
 * host close cleanly.
 */
let shutdownSignal: AbortSignal | undefined

export function setShutdownSignal(signal: AbortSignal): void {
  shutdownSignal = signal
}

export function isShutdownRequested(): boolean {
  return shutdownSignal?.aborted === true
}

export class InterruptedError extends Error {
  readonly kind = "infra" as const

  constructor(label: string) {
    super(`${label}: interrupted by shutdown`)
    this.name = "InterruptedError"
  }
}

function requestOptions(): { signal?: AbortSignal } {
  return shutdownSignal ? { signal: shutdownSignal } : {}
}
