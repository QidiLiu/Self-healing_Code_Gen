import * as fs from "fs"
import * as path from "path"
import { AgentConfig, EmailConfig } from "./types.js"
import { parseIniFile } from "./ini-parser.js"

function readKeyFile(keyPath: string): string {
  const content = fs.readFileSync(keyPath, "utf-8").trim()
  return content
}

function parseModel(model: string): { providerID: string; modelID: string } {
  const slashIdx = model.indexOf("/")
  if (slashIdx === -1) {
    throw new Error(`Invalid model format: ${model}. Expected "provider/model"`)
  }
  return {
    providerID: model.substring(0, slashIdx),
    modelID: model.substring(slashIdx + 1),
  }
}

const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  recipient: "",
  progressIntervalMinutes: 30,
}

function loadIniConfig(root: string): Record<string, Record<string, string>> {
  const iniPath = path.join(root, "meta", "config.ini")
  if (fs.existsSync(iniPath)) {
    return parseIniFile(iniPath)
  }
  return {}
}

export function loadConfig(args: {
  requirements?: string
  workspace?: string
  stateDir?: string
  outputDir?: string
  model?: string
  apiKey?: string
  keyFile?: string
  baseUrl?: string
  maxRetries?: number
  maxReplans?: number
}): AgentConfig {
  const root = process.cwd()
  const ini = loadIniConfig(root)

  const keyFile = args.keyFile || path.join(root, "doc", "DEEPSEEK_KEY.md")
  let apiKey = args.apiKey || ""

  if (!apiKey) {
    if (fs.existsSync(keyFile)) {
      apiKey = readKeyFile(keyFile)
    }
  }

  const model = args.model || ini.model?.provider_model || "deepseek/deepseek-v4-pro"
  parseModel(model)

  const emailConfig: EmailConfig = {
    enabled: ini.email?.enabled === "true" || DEFAULT_EMAIL_CONFIG.enabled,
    recipient: ini.email?.recipient || DEFAULT_EMAIL_CONFIG.recipient,
    progressIntervalMinutes: ini.email?.progress_interval_minutes
      ? parseInt(ini.email.progress_interval_minutes, 10)
      : DEFAULT_EMAIL_CONFIG.progressIntervalMinutes,
  }

  return {
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
    apiKey,
    baseUrl: args.baseUrl || ini.model?.base_url || null,
    maxRetries: args.maxRetries
      || (ini.model?.max_retries ? parseInt(ini.model.max_retries, 10) : undefined)
      || 4,
    maxReplans: args.maxReplans
      || (ini.model?.max_replans ? parseInt(ini.model.max_replans, 10) : undefined)
      || 2,
    email: emailConfig,
  }
}

export { parseModel }
