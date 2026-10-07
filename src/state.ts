import * as fs from "fs"
import * as path from "path"
import {
  Checkpoint,
  AgentPhase,
  Contract,
  ErrorEntry,
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

export function createEmptyCheckpoint(): Checkpoint {
  return {
    phase: "idle",
    retries: 0,
    replanCount: 0,
    iterations: 0,
    infraErrors: 0,
    parseErrors: 0,
    errors: [],
    lastError: null,
    plannerSessionId: null,
    generatorSessionId: null,
    evaluatorSessionId: null,
    updatedAt: new Date().toISOString(),
  }
}

export function loadCheckpoint(stateDir: string): Checkpoint {
  const checkpointPath = path.join(stateDir, "checkpoint.json")
  if (fs.existsSync(checkpointPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as Partial<Checkpoint>
      const base = createEmptyCheckpoint()
      return {
        ...base,
        ...raw,
        // Fields added after v1.0 may be missing from an older checkpoint file.
        iterations: raw.iterations ?? base.iterations,
        infraErrors: raw.infraErrors ?? base.infraErrors,
        parseErrors: raw.parseErrors ?? base.parseErrors,
        retries: raw.retries ?? base.retries,
        replanCount: raw.replanCount ?? base.replanCount,
        errors: Array.isArray(raw.errors) ? raw.errors : [],
      }
    } catch {
      return createEmptyCheckpoint()
    }
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
  if (!fs.existsSync(jsonPath)) return null
  try {
    const contract = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Contract
    if (!contract || !Array.isArray(contract.items)) return null
    return contract
  } catch {
    return null
  }
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

/** Append-only record of failures that were NOT caused by the generated code. */
export function appendError(stateDir: string, entry: ErrorEntry): void {
  ensureDir(stateDir)
  fs.appendFileSync(
    path.join(stateDir, "errors.jsonl"),
    JSON.stringify(entry) + "\n",
  )
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
  if (!fs.existsSync(evalPath)) return null
  try {
    const evaluation = JSON.parse(fs.readFileSync(evalPath, "utf-8")) as EvaluationResult
    if (!evaluation || !Array.isArray(evaluation.failures)) return null
    return evaluation
  } catch {
    return null
  }
}

export interface UsageTotals {
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

function emptyUsage(): UsageTotals {
  return {
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
  }
}

/** Accumulates cost/tokens across the whole run into state/usage.json. */
export function recordUsage(
  stateDir: string,
  usage: UsageTotals,
): UsageTotals {
  ensureDir(stateDir)
  const usagePath = path.join(stateDir, "usage.json")

  let totals = emptyUsage()
  if (fs.existsSync(usagePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(usagePath, "utf-8")) as Partial<UsageTotals>
      totals = { ...emptyUsage(), ...raw }
    } catch {
      totals = emptyUsage()
    }
  }

  totals.cost += usage.cost
  totals.input += usage.input
  totals.output += usage.output
  totals.reasoning += usage.reasoning
  totals.cacheRead += usage.cacheRead
  totals.cacheWrite += usage.cacheWrite
  totals.requests += usage.requests

  fs.writeFileSync(usagePath, JSON.stringify(totals, null, 2))
  return totals
}

export function loadUsage(stateDir: string): UsageTotals {
  const usagePath = path.join(stateDir, "usage.json")
  if (!fs.existsSync(usagePath)) return emptyUsage()
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath, "utf-8")) as Partial<UsageTotals>
    return { ...emptyUsage(), ...raw }
  } catch {
    return emptyUsage()
  }
}

export function resetUsage(stateDir: string): void {
  const usagePath = path.join(stateDir, "usage.json")
  try {
    if (fs.existsSync(usagePath)) fs.unlinkSync(usagePath)
  } catch {
    // ignore
  }
}

const principlesCache = new Map<string, string>()

/**
 * Principle documents are injected into role system prompts. Resolve them against
 * the project root (not process.cwd()) so they are never silently missing, and
 * cache them because they are read on every prompt.
 */
export function loadPrinciplesFile(filename: string, rootDir: string): string {
  const cacheKey = path.join(rootDir, filename)
  const cached = principlesCache.get(cacheKey)
  if (cached !== undefined) return cached

  let content = ""
  const filePath = path.join(rootDir, "doc", filename)
  try {
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, "utf-8")
    }
  } catch {
    content = ""
  }

  principlesCache.set(cacheKey, content)
  return content
}

export function clearSessionIds(stateDir: string): Checkpoint {
  const checkpoint = loadCheckpoint(stateDir)
  const oldPhase = checkpoint.phase
  checkpoint.plannerSessionId = null
  checkpoint.generatorSessionId = null
  checkpoint.evaluatorSessionId = null

  // Sessions live on the opencode server. After a restart the code on disk was
  // never regenerated in the new context, so anything that assumed an evaluation
  // exists must be re-run.
  if (oldPhase === "evaluating" || oldPhase === "fixing") {
    checkpoint.phase = "evaluating"
  }
  if (oldPhase === "planning" || oldPhase === "replanning") {
    checkpoint.phase = "planning"
  }

  saveCheckpoint(stateDir, checkpoint)
  console.log(`  [INFO] Cleared session IDs for server restart (phase: ${oldPhase} -> ${checkpoint.phase})`)
  return checkpoint
}

export { ensureDir }
