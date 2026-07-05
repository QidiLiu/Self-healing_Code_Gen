import * as fs from "fs"
import * as path from "path"
import {
  Checkpoint,
  AgentPhase,
  Contract,
  LogEntry,
  EvaluationResult,
} from "./types.js"

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function initState(stateDir: string): void {
  ensureDir(stateDir)
}

export function loadCheckpoint(stateDir: string): Checkpoint {
  const checkpointPath = path.join(stateDir, "checkpoint.json")
  if (fs.existsSync(checkpointPath)) {
    return JSON.parse(fs.readFileSync(checkpointPath, "utf-8"))
  }
  return createEmptyCheckpoint()
}

export function saveCheckpoint(stateDir: string, checkpoint: Checkpoint): void {
  ensureDir(stateDir)
  checkpoint.updatedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(stateDir, "checkpoint.json"),
    JSON.stringify(checkpoint, null, 2),
  )
}

export function createEmptyCheckpoint(): Checkpoint {
  return {
    phase: "idle",
    retries: 0,
    replanCount: 0,
    errors: [],
    lastError: null,
    plannerSessionId: null,
    generatorSessionId: null,
    evaluatorSessionId: null,
    updatedAt: new Date().toISOString(),
  }
}

export function saveContract(stateDir: string, contract: Contract): void {
  ensureDir(stateDir)
  contract.updatedAt = new Date().toISOString()
  let md = `# Contract: ${contract.overview}\n\n`
  md += `Created: ${contract.createdAt}\n`
  md += `Updated: ${contract.updatedAt}\n\n`
  md += `## Items\n\n`
  for (const item of contract.items) {
    const statusIcon =
      item.status === "passed"
        ? "[PASS]"
        : item.status === "failed"
          ? "[FAIL]"
          : item.status === "in_progress"
            ? "[BUSY]"
            : "[TODO]"
    md += `- ${statusIcon} **${item.id}** [${item.category}] ${item.description}\n`
    md += `  - Assertion: ${item.testableAssertion}\n`
  }
  fs.writeFileSync(path.join(stateDir, "contract.md"), md)
}

export function loadContract(stateDir: string): Contract | null {
  const jsonPath = path.join(stateDir, "contract.json")
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
  }
  return null
}

export function saveContractJson(stateDir: string, contract: Contract): void {
  ensureDir(stateDir)
  contract.updatedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(stateDir, "contract.json"),
    JSON.stringify(contract, null, 2),
  )
  saveContract(stateDir, contract)
}

export function saveProgress(
  stateDir: string,
  phase: AgentPhase,
  summary: string,
): void {
  ensureDir(stateDir)
  const progressPath = path.join(stateDir, "progress.md")
  const content = `# Progress\n\n` +
    `Phase: ${phase}\n` +
    `Updated: ${new Date().toISOString()}\n\n` +
    `## Summary\n\n${summary}\n`

  fs.writeFileSync(progressPath, content)
}

export function appendLog(stateDir: string, entry: LogEntry): void {
  ensureDir(stateDir)
  const logPath = path.join(stateDir, "log.md")
  const line = `## [${entry.timestamp}] ${entry.role} | ${entry.phase} | ${entry.action}\n` +
    `${entry.detail}\n\n`
  fs.appendFileSync(logPath, line)
}

export function saveEvaluation(
  stateDir: string,
  evaluation: EvaluationResult,
): void {
  ensureDir(stateDir)
  fs.writeFileSync(
    path.join(stateDir, "evaluation.json"),
    JSON.stringify(evaluation, null, 2),
  )
}

export function loadEvaluation(
  stateDir: string,
): EvaluationResult | null {
  const evalPath = path.join(stateDir, "evaluation.json")
  if (fs.existsSync(evalPath)) {
    return JSON.parse(fs.readFileSync(evalPath, "utf-8"))
  }
  return null
}

export function getStateFilePath(stateDir: string, file: string): string {
  return path.join(stateDir, file)
}

export function loadPrinciplesFile(filename: string): string {
  const filePath = path.join(process.cwd(), "doc", filename)
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8")
  }
  return ""
}

export function clearSessionIds(stateDir: string): void {
  const checkpoint = loadCheckpoint(stateDir)
  checkpoint.plannerSessionId = null
  checkpoint.generatorSessionId = null
  checkpoint.evaluatorSessionId = null
  const oldPhase = checkpoint.phase
  if (oldPhase === "generating") {
    checkpoint.phase = "generating"
  }
  saveCheckpoint(stateDir, checkpoint)
  console.log(`  [INFO] Cleared session IDs for server restart (phase: ${oldPhase})`)
}

export { ensureDir }
