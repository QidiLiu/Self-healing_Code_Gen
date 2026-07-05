import * as fs from "fs"
import * as path from "path"
import { AgentConfig } from "./types.js"

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
  const keyFile = args.keyFile || path.join(root, "doc", "DEEPSEEK_KEY.md")
  let apiKey = args.apiKey || ""

  if (!apiKey) {
    if (fs.existsSync(keyFile)) {
      apiKey = readKeyFile(keyFile)
    }
  }

  const model = args.model || "deepseek/deepseek-v4-pro"
  parseModel(model)

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
    baseUrl: args.baseUrl || null,
    maxRetries: args.maxRetries || 4,
    maxReplans: args.maxReplans || 2,
  }
}

export { parseModel }
