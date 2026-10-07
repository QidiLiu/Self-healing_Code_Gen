import { createOpencode, OpencodeClient, Config } from "@opencode-ai/sdk"
import { AgentConfig } from "./types.js"
import { parseModel } from "./config.js"

export interface OpencodeContext {
  client: OpencodeClient
  server: { url: string; close(): void }
}

/** Infrastructure failure: the harness could not talk to the model at all. */
export class OpencodeRequestError extends Error {
  readonly kind = "infra" as const

  constructor(label: string, message: string) {
    super(`${label}: ${message}`)
    this.name = "OpencodeRequestError"
  }
}

/** The provider answered, but with an error (auth, rate limit, model not found...). */
export class ProviderError extends Error {
  readonly kind = "infra" as const

  constructor(errorName: string, message: string) {
    super(`provider error ${errorName}: ${message}`)
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

let lastConfig: Config | null = null
let lastPort = 4096

/**
 * The SDK defaults to a 5s server start timeout, which is not enough for a cold
 * opencode boot (config load, provider auth, formatter and LSP plugins).
 */
const SERVER_START_TIMEOUT_MS = 60000

export async function startOpencode(
  agentConfig: AgentConfig,
  workspacePath: string,
): Promise<OpencodeContext> {
  const { providerID } = parseModel(agentConfig.model)

  const apiKeyEnvVar = `${providerID.toUpperCase()}_API_KEY`
  if (agentConfig.apiKey && !process.env[apiKeyEnvVar]) {
    process.env[apiKeyEnvVar] = agentConfig.apiKey
  }

  const config: Config = {
    model: agentConfig.model,
  }

  if (agentConfig.apiKey) {
    config.provider = {
      [providerID]: {
        options: {
          apiKey: agentConfig.apiKey,
        },
      },
    }
  }

  if (agentConfig.baseUrl) {
    if (!config.provider) config.provider = {}
    if (!config.provider[providerID]) {
      config.provider[providerID] = {}
    }
    config.provider[providerID].options = {
      ...config.provider[providerID].options,
      baseURL: agentConfig.baseUrl,
    }
  }

  lastConfig = config
  lastPort = agentConfig.serverPort

  const { client, server } = await createOpencode({
    port: agentConfig.serverPort,
    timeout: SERVER_START_TIMEOUT_MS,
    config,
  })

  return { client, server }
}

export async function restartOpencode(): Promise<OpencodeContext> {
  if (!lastConfig) {
    throw new Error("Cannot restart: no previous opencode configuration found")
  }

  const { client, server } = await createOpencode({
    port: lastPort,
    timeout: SERVER_START_TIMEOUT_MS,
    config: lastConfig,
  })

  return { client, server }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * Verifies before the loop starts that the configured provider is loaded, that a
 * key was resolved for it, and that the model id exists. Turns a 10 minute
 * "planner returned malformed JSON" failure into a 3 second diagnosis.
 */
export interface PreflightResult {
  ok: boolean
  error?: string
  hint?: string
  warning?: string
}

// Structural access only: keeps this compiling against SDK versions where
// config.providers() is absent, in which case the check is skipped.
interface ProvidersClient {
  config?: {
    providers?: () => Promise<{ data?: unknown }>
  }
}

interface ProviderShape {
  id?: string
  key?: string
  env?: string[]
  models?: Record<string, unknown>
}

export async function preflightProvider(
  client: OpencodeClient,
  config: AgentConfig,
): Promise<PreflightResult> {
  const { providerID, modelID } = parseModel(config.model)

  const providersFn = (client as unknown as ProvidersClient).config?.providers
  if (typeof providersFn !== "function") {
    return { ok: true, warning: "provider preflight unavailable in this opencode SDK version" }
  }

  let data: { providers?: ProviderShape[] }
  try {
    const result = await providersFn.call((client as unknown as ProvidersClient).config)
    if (!result || !result.data) {
      return { ok: false, error: "opencode returned no provider list." }
    }
    data = result.data as { providers?: ProviderShape[] }
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not query opencode providers: ${describeError(err)}`,
      hint: "Is the opencode server healthy?",
    }
  }

  const providers = Array.isArray(data.providers) ? data.providers : []
  if (providers.length === 0) {
    return { ok: false, error: "opencode reported zero configured providers." }
  }

  const provider = providers.find((p) => p.id === providerID)
  if (!provider) {
    return {
      ok: false,
      error: `Provider "${providerID}" is not available to opencode.`,
      hint: `Available providers: ${providers.map((p) => p.id).filter(Boolean).join(", ")}`,
    }
  }

  if (!provider.key) {
    return {
      ok: false,
      error: `No API key resolved for provider "${providerID}".`,
      hint:
        `Set ${provider.env?.[0] || `${providerID.toUpperCase()}_API_KEY`}, ` +
        "pass --api-key, or fill meta/config.ini [model] api_key.",
    }
  }

  const models = Object.keys(provider.models || {})
  if (models.length > 0 && !models.includes(modelID)) {
    return {
      ok: false,
      error: `Model "${config.model}" does not exist on provider "${providerID}".`,
      hint: `Available models include: ${models.slice(0, 25).join(", ")}`,
    }
  }

  return { ok: true }
}

export async function createSession(
  client: OpencodeClient,
  title: string,
  directory?: string,
): Promise<string> {
  return withRetry(async () => {
    const result = await client.session.create({
      body: { title },
      query: directory ? { directory } : undefined,
    })
    if (result.error || !result.data) {
      throw new OpencodeRequestError("createSession", describeError(result.error) || "no session returned")
    }
    return result.data.id
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

export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  systemPrompt: string,
  userPrompt: string,
  model?: { providerID: string; modelID: string },
  directory?: string,
): Promise<PromptResult> {
  return withRetry(async () => {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
        parts: [{ type: "text", text: userPrompt }],
        model,
      },
      query: directory ? { directory } : undefined,
    })

    if (result.error || !result.data) {
      throw new OpencodeRequestError(
        "sendPrompt",
        describeError(result.error) || "empty response envelope",
      )
    }

    const info = result.data.info
    if (info.error) {
      const message =
        typeof info.error.data === "object" && info.error.data && "message" in info.error.data
          ? String((info.error.data as { message: string }).message)
          : describeError(info.error)
      throw new ProviderError(info.error.name, message)
    }

    let text = ""
    for (const part of result.data.parts) {
      if (part.type === "text" && !part.synthetic) {
        text += part.text
      }
    }

    if (!text.trim()) {
      throw new EmptyResponseError("sendPrompt")
    }

    return {
      text,
      sessionId,
      messageId: info.id,
      usage: {
        cost: info.cost ?? 0,
        input: info.tokens?.input ?? 0,
        output: info.tokens?.output ?? 0,
        reasoning: info.tokens?.reasoning ?? 0,
        cacheRead: info.tokens?.cache?.read ?? 0,
        cacheWrite: info.tokens?.cache?.write ?? 0,
      },
    }
  }, "sendPrompt")
}

const MAX_API_RETRIES = 3
const BASE_RETRY_DELAY = 2000

/** Only failures that can plausibly succeed on a second identical attempt. */
function isTransient(err: unknown): boolean {
  const message = describeError(err)

  if (err instanceof TypeError) {
    return /fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      message,
    )
  }

  if (err instanceof ProviderError) {
    return /rate|429|overload|quota|temporar|timeout|5\d\d|timeout_error/i.test(message)
  }

  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|429|503|502|504/i.test(
    message,
  )
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (attempt === MAX_API_RETRIES) break
      if (!isTransient(err)) {
        throw err
      }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { sleep }
