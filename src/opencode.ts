import { createOpencode, OpencodeClient, Config } from "@opencode-ai/sdk"
import { AgentConfig } from "./types.js"

export interface OpencodeContext {
  client: OpencodeClient
  server: { url: string; close(): void }
}

let lastConfig: Config | null = null
let lastPort: number = 4096

export async function startOpencode(
  agentConfig: AgentConfig,
  workspacePath: string,
): Promise<OpencodeContext> {
  const modelParts = agentConfig.model.split("/")
  const providerID = modelParts[0]

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
  lastPort = 4096

  const { client, server } = await createOpencode({
    port: 4096,
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
    config: lastConfig,
  })

  return { client, server }
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
    const sessionId = result.data!.id
    return sessionId
  }, "createSession")
}

export interface PromptResult {
  text: string
  sessionId: string
  messageId: string
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

    const data = result.data!
    let text = ""
    if (data.parts) {
      for (const part of data.parts) {
        if (part.type === "text") {
          text += (part as { text: string }).text
        }
      }
    }

    return {
      text,
      sessionId,
      messageId: data.info.id,
    }
  }, "sendPrompt")
}

export async function waitForSessionIdle(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs: number = 300000,
  pollIntervalMs: number = 2000,
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const statusResult = await client.session.status()
    const statuses = statusResult.data!

    if (statuses[sessionId] && statuses[sessionId].type === "idle") {
      return true
    }

    await sleep(pollIntervalMs)
  }

  return false
}

const MAX_API_RETRIES = 3
const BASE_RETRY_DELAY = 2000

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

      const isNetworkError =
        err instanceof TypeError &&
        (err.message.includes("fetch failed") ||
         err.message.includes("network") ||
         err.message.includes("ECONNREFUSED") ||
         err.message.includes("ECONNRESET"))

      const delay = BASE_RETRY_DELAY * Math.pow(2, attempt)
      const errMsg = err instanceof Error ? err.message : String(err)

      if (isNetworkError) {
        console.error(
          `  [RETRY] ${label} attempt ${attempt + 1}/${MAX_API_RETRIES} failed: ${errMsg}. ` +
          `Retrying in ${delay / 1000}s...`
        )
      } else {
        console.error(
          `  [RETRY] ${label} attempt ${attempt + 1}/${MAX_API_RETRIES} failed: ${errMsg}. ` +
          `Retrying in ${delay / 1000}s...`
        )
      }

      await sleep(delay)
    }
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
