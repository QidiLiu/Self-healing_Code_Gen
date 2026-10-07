import * as fs from "fs"
import * as path from "path"
import { AgentConfig } from "./types.js"
import { parseIniFile } from "./ini-parser.js"

export interface ApiKeyResolution {
  apiKey: string
  source: string
  error?: string
}

export function parseModel(model: string): { providerID: string; modelID: string } {
  const slashIdx = model.indexOf("/")
  if (slashIdx === -1) {
    throw new Error(`Invalid model format: "${model}". Expected "provider/model"`)
  }
  const providerID = model.substring(0, slashIdx)
  const modelID = model.substring(slashIdx + 1)
  if (!providerID || !modelID) {
    throw new Error(`Invalid model format: "${model}". Expected "provider/model"`)
  }
  return { providerID, modelID }
}

/**
 * API keys are usually pasted into a Markdown file, so the file may contain
 * code fences, comments or prose around the key. Take the first line that looks
 * like a key: no whitespace, not a comment.
 */
export function readKeyFile(keyPath: string): { key: string; error?: string } {
  const raw = fs.readFileSync(keyPath, "utf-8")

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue
    line = line.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim()
    if (!line) continue
    if (line.startsWith("#") || line.startsWith(">")) continue
    if (/\s/.test(line)) continue
    return { key: line }
  }

  return { key: "", error: `no API key found in ${keyPath}` }
}

function loadIniConfig(root: string): Record<string, Record<string, string>> {
  const iniPath = path.join(root, "meta", "config.ini")
  if (fs.existsSync(iniPath)) {
    try {
      return parseIniFile(iniPath)
    } catch {
      return {}
    }
  }
  return {}
}

function iniInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function resolveApiKey(args: {
  apiKey?: string
  apiKeyEnv?: string
  keyFile?: string
}, ini: Record<string, Record<string, string>>, model: { providerID: string }): ApiKeyResolution {
  const root = process.cwd()

  if (args.apiKey) {
    return { apiKey: args.apiKey, source: "--api-key" }
  }

  if (args.apiKeyEnv) {
    const value = process.env[args.apiKeyEnv]
    if (value) return { apiKey: value, source: `env ${args.apiKeyEnv}` }
    return { apiKey: "", source: "", error: `--api-key-env ${args.apiKeyEnv} is not set` }
  }

  const iniKey = (ini.model?.api_key || "").trim()
  if (iniKey) {
    return { apiKey: iniKey, source: "meta/config.ini [model] api_key" }
  }

  const derivedEnv = `${model.providerID.toUpperCase()}_API_KEY`
  const envValue = process.env[derivedEnv]
  if (envValue) {
    return { apiKey: envValue, source: `env ${derivedEnv}` }
  }

  const keyFile = args.keyFile || path.join(root, "doc", "DEEPSEEK_KEY.md")
  if (fs.existsSync(keyFile)) {
    try {
      const { key, error } = readKeyFile(keyFile)
      if (key) return { apiKey: key, source: keyFile }
      return { apiKey: "", source: "", error: error || `no API key found in ${keyFile}` }
    } catch {
      return { apiKey: "", source: "", error: `could not read ${keyFile}` }
    }
  }

  return { apiKey: "", source: "", error: "" }
}

/**
 * The API key is optional here: credentials registered through
 * `opencode auth login` live in the shared SQLite database and are picked up by
 * the host without the project ever holding the secret.
 */
export function loadConfig(args: {
  requirements?: string
  workspace?: string
  stateDir?: string
  outputDir?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  keyFile?: string
  baseUrl?: string
  maxRetries?: number
  maxReplans?: number
  maxInfraErrors?: number
  maxTotalIterations?: number
}): AgentConfig {
  const root = process.cwd()
  const ini = loadIniConfig(root)

  const model = args.model || ini.model?.provider_model || "deepseek/deepseek-flash"
  const parsedModel = parseModel(model)

  const keyFile = args.keyFile || path.join(root, "doc", "DEEPSEEK_KEY.md")
  const resolution = resolveApiKey(
    { apiKey: args.apiKey, apiKeyEnv: args.apiKeyEnv, keyFile },
    ini,
    parsedModel,
  )

  const maxRetries =
    args.maxRetries || iniInt(ini.model?.max_retries) || 4
  const maxReplans =
    args.maxReplans || iniInt(ini.model?.max_replans) || 2
  const maxInfraErrors =
    args.maxInfraErrors || iniInt(ini.model?.max_infra_errors) || 3
  const maxTotalIterations =
    args.maxTotalIterations ||
    iniInt(ini.model?.max_total_iterations) ||
    (maxRetries + 1) * (maxReplans + 1) + 2

  return {
    rootDir: root,
    requirementsPath: args.requirements
      ? path.resolve(args.requirements)
      : path.join(root, "requirements", "current.md"),
    workspacePath: args.workspace
      ? path.resolve(args.workspace)
      : path.join(root, "workspace"),
    stateDir: args.stateDir
      ? path.resolve(args.stateDir)
      : path.join(root, "state"),
    outputDir: args.outputDir
      ? path.resolve(args.outputDir)
      : path.join(root, "output"),
    model,
    apiKey: resolution.apiKey,
    apiKeySource: resolution.source,
    apiKeyError: resolution.error || null,
    baseUrl: args.baseUrl || ini.model?.base_url || null,
    maxRetries,
    maxReplans,
    maxInfraErrors,
    maxTotalIterations,
  }
}
