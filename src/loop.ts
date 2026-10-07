import { OpencodeClient } from "@opencode-ai/sdk"
import {
  AgentConfig,
  AgentPhase,
  AgentReport,
  Checkpoint,
  Contract,
  EvaluationResult,
} from "./types.js"
import {
  loadCheckpoint,
  loadContract,
  loadEvaluation,
  saveCheckpoint,
  saveContractJson,
  saveProgress,
  saveEvaluation,
  appendLog,
  appendError,
  ensureDir,
} from "./state.js"
import {
  createSession,
  describeError,
  EmptyResponseError,
  OpencodeRequestError,
  ProviderError,
  sleep,
} from "./opencode.js"
import { runPlanner, PlannerOutputError } from "./roles/planner.js"
import { runGenerator } from "./roles/generator.js"
import { runEvaluator } from "./roles/evaluator.js"
import { generateReport, printProgress } from "./reporter.js"
import * as fs from "fs"

export interface LoopLimits {
  maxRetries: number
  maxReplans: number
  maxInfraErrors: number
  maxTotalIterations: number
}

export type PhaseDecision =
  | { phase: "done" }
  | { phase: "stuck"; reason: string }
  | { phase: "fixing" }
  | { phase: "replanning" }

const INFRA_BACKOFF_MS = 5000
const PARSE_BACKOFF_MS = 2000
const MAX_PARSE_ERRORS = 3

/**
 * The whole phase transition policy, with no IO in it.
 *
 * replanCount is incremented by the caller at the moment of transition, so it
 * counts actual replans. Deriving the replan decision from the counter itself is
 * what previously made the loop unbounded: a counter that is only incremented
 * behind an `if (counter > 0)` guard can never leave 0.
 */
export function decideNextPhase(
  checkpoint: Checkpoint,
  allPass: boolean,
  limits: LoopLimits,
): PhaseDecision {
  if (allPass) return { phase: "done" }

  if (checkpoint.retries < limits.maxRetries) {
    return { phase: "fixing" }
  }

  if (checkpoint.replanCount < limits.maxReplans) {
    return { phase: "replanning" }
  }

  return {
    phase: "stuck",
    reason:
      `Max retries (${limits.maxRetries}) and replans (${limits.maxReplans}) exhausted.`,
  }
}

type FailureKind = "parse" | "infra"

interface RoleFailure {
  kind: FailureKind
  message: string
  hint?: string
}

/**
 * Separates "the harness/model could not run" from "the generated code is bad".
 * Infra and parse failures must never be charged against the code retry budget,
 * otherwise a bad API key or a malformed response looks like a stubborn bug.
 */
function classifyFailure(err: unknown): RoleFailure {
  if (
    err instanceof OpencodeRequestError ||
    err instanceof ProviderError ||
    err instanceof EmptyResponseError
  ) {
    return { kind: "infra", message: describeError(err) }
  }

  if (err instanceof PlannerOutputError) {
    return {
      kind: "parse",
      message: describeError(err),
      hint: "Raw planner output is in state/debug/",
    }
  }

  return { kind: "infra", message: describeError(err) }
}

async function guardRoleCall<T>(
  config: AgentConfig,
  role: string,
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; failure: RoleFailure }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err: unknown) {
    const failure = classifyFailure(err)
    appendError(config.stateDir, {
      timestamp: new Date().toISOString(),
      role,
      kind: failure.kind,
      message: failure.message,
      hint: failure.hint,
    })
    appendLog(config.stateDir, {
      timestamp: new Date().toISOString(),
      phase: "idle",
      role: role as "planner" | "generator" | "evaluator",
      action: failure.kind === "infra" ? "infra_error" : "parse_error",
      detail: `[${label}] ${failure.message}`,
    })
    return { ok: false, failure }
  }
}

interface FailureOutcome {
  /** Phase to continue in. Stays the same on a retryable failure. */
  retryPhase: AgentPhase
  retry: boolean
  blocked: string | null
}

/**
 * Applies a role failure to the checkpoint. Returns whether the loop should
 * retry the same phase, and the reason to stop when it should not.
 */
function applyFailure(
  checkpoint: Checkpoint,
  failure: RoleFailure,
  currentPhase: AgentPhase,
  limits: LoopLimits,
): FailureOutcome {
  checkpoint.errors = [failure.message]
  checkpoint.lastError = failure.message

  if (failure.kind === "infra") {
    checkpoint.infraErrors++
    if (checkpoint.infraErrors >= limits.maxInfraErrors) {
      const hint = failure.hint ? ` ${failure.hint}` : ""
      printProgress(
        currentPhase,
        `Model/provider unavailable ${checkpoint.infraErrors} times in a row. Marking as stuck.`,
      )
      return {
        retryPhase: "stuck",
        retry: false,
        blocked: `Model/provider unavailable: ${failure.message}.${hint}`,
      }
    }
    printProgress(
      currentPhase,
      `Model/provider error (${checkpoint.infraErrors}/${limits.maxInfraErrors}): ${failure.message}`,
    )
    return { retryPhase: currentPhase, retry: true, blocked: null }
  }

  checkpoint.parseErrors++
  if (checkpoint.parseErrors >= MAX_PARSE_ERRORS) {
    printProgress(
      currentPhase,
      `Malformed model output ${checkpoint.parseErrors} times in a row. Marking as stuck.`,
    )
    return {
      retryPhase: "stuck",
      retry: false,
      blocked: `Model output could not be parsed: ${failure.message}`,
    }
  }
  printProgress(currentPhase, `Malformed model output, retrying (${checkpoint.parseErrors}/${MAX_PARSE_ERRORS})`)
  return { retryPhase: currentPhase, retry: true, blocked: null }
}

export async function runAgentLoop(
  client: OpencodeClient,
  config: AgentConfig,
): Promise<AgentReport> {
  ensureDir(config.stateDir)
  ensureDir(config.workspacePath)
  ensureDir(config.outputDir)

  const limits: LoopLimits = {
    maxRetries: config.maxRetries,
    maxReplans: config.maxReplans,
    maxInfraErrors: config.maxInfraErrors,
    maxTotalIterations: config.maxTotalIterations,
  }

  const checkpoint = loadCheckpoint(config.stateDir)

  // Resume context, not just the phase: without these a crash during "fixing"
  // would restart generation from scratch.
  let contract: Contract | null = loadContract(config.stateDir)
  let evaluation: EvaluationResult | null = loadEvaluation(config.stateDir)

  if (checkpoint.phase === "fixing" && !evaluation) {
    printProgress("fixing", "No previous evaluation on disk; re-evaluating before fixing.")
    checkpoint.phase = "evaluating"
    saveCheckpoint(config.stateDir, checkpoint)
  }

  const requirements = fs.readFileSync(config.requirementsPath, "utf-8")

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: checkpoint.phase,
    role: "system",
    action: "start",
    detail:
      `Starting agent loop from phase: ${checkpoint.phase}` +
      (contract ? ` (contract restored: ${contract.items.length} items)` : "") +
      (evaluation ? ` (evaluation restored: ${evaluation.passedCount}/${evaluation.totalCount})` : ""),
  })

  printProgress(checkpoint.phase, "Starting agent system...")

  let blocked: string | null = null

  while (checkpoint.phase !== "done" && checkpoint.phase !== "stuck") {
    // Checked before incrementing so `iterations` can never exceed the budget.
    if (checkpoint.iterations >= limits.maxTotalIterations) {
      blocked = `Iteration budget exhausted after ${checkpoint.iterations} iterations.`
      printProgress(checkpoint.phase, blocked)
      checkpoint.phase = "stuck"
      checkpoint.errors = [blocked]
      checkpoint.lastError = blocked
      saveCheckpoint(config.stateDir, checkpoint)
      break
    }
    checkpoint.iterations++

    switch (checkpoint.phase) {
      case "idle":
      case "replanning":
      case "planning": {
        // A plain retry of a failed planning attempt keeps phase "planning";
        // only a real replan comes from "replanning".
        const isReplan = checkpoint.errors.length > 0
        checkpoint.phase = "planning"
        saveCheckpoint(config.stateDir, checkpoint)

        printProgress("planning", "Analyzing requirements and creating contract...")

        const plannerSessionId =
          checkpoint.plannerSessionId ||
          (await createSession(client, "Planner Session", config.workspacePath))
        checkpoint.plannerSessionId = plannerSessionId

        const outcome = await guardRoleCall(config, "planner", "runPlanner", () =>
          runPlanner(
            client,
            plannerSessionId,
            requirements,
            config,
            isReplan ? checkpoint.errors.join("\n---\n") : undefined,
          ),
        )

        if (!outcome.ok) {
          const failure = applyFailure(checkpoint, outcome.failure, "planning", limits)
          if (!failure.retry) blocked = failure.blocked
          checkpoint.phase = failure.retryPhase
          saveCheckpoint(config.stateDir, checkpoint)
          if (failure.retry) await sleep(infraOrParseDelay(outcome.failure.kind))
          break
        }

        contract = outcome.value
        checkpoint.infraErrors = 0
        checkpoint.parseErrors = 0

        saveContractJson(config.stateDir, contract)
        saveProgress(
          config.stateDir,
          "planning",
          `Contract created: ${contract.overview}\n${contract.items.length} items defined`,
        )

        printProgress("planning", `Contract created with ${contract.items.length} items`)

        checkpoint.phase = "generating"
        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      case "generating":
      case "fixing": {
        const fixing = checkpoint.phase === "fixing"
        printProgress(
          checkpoint.phase,
          fixing
            ? `Fixing ${evaluation?.failures.length || 0} issues... (attempt ${checkpoint.retries + 1})`
            : "Generating implementation...",
        )

        if (!contract) {
          printProgress(checkpoint.phase, "No contract available, replanning.")
          checkpoint.phase = "planning"
          saveCheckpoint(config.stateDir, checkpoint)
          break
        }

        const generatorSessionId =
          checkpoint.generatorSessionId ||
          (await createSession(client, "Generator Session", config.workspacePath))
        checkpoint.generatorSessionId = generatorSessionId

        const outcome = await guardRoleCall(config, "generator", "runGenerator", () =>
          runGenerator(
            client,
            generatorSessionId,
            contract!,
            config,
            fixing ? evaluation || undefined : undefined,
          ),
        )

        if (!outcome.ok) {
          const failure = applyFailure(checkpoint, outcome.failure, checkpoint.phase, limits)
          if (!failure.retry) blocked = failure.blocked
          checkpoint.phase = failure.retryPhase
          saveCheckpoint(config.stateDir, checkpoint)
          if (failure.retry) await sleep(infraOrParseDelay(outcome.failure.kind))
          break
        }

        checkpoint.infraErrors = 0
        checkpoint.parseErrors = 0

        saveProgress(
          config.stateDir,
          checkpoint.phase,
          fixing
            ? `Fixing ${evaluation?.failures.length || 0} issues, attempt ${checkpoint.retries + 1}`
            : "Implementation generated",
        )

        checkpoint.phase = "evaluating"
        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      case "evaluating": {
        printProgress("evaluating", "Evaluating implementation...")

        if (!contract) {
          printProgress("evaluating", "No contract available, replanning.")
          checkpoint.phase = "planning"
          saveCheckpoint(config.stateDir, checkpoint)
          break
        }

        const evaluatorSessionId =
          checkpoint.evaluatorSessionId ||
          (await createSession(client, "Evaluator Session", config.workspacePath))
        checkpoint.evaluatorSessionId = evaluatorSessionId

        const outcome = await guardRoleCall(config, "evaluator", "runEvaluator", () =>
          runEvaluator(client, evaluatorSessionId, contract!, config),
        )

        if (!outcome.ok) {
          const failure = applyFailure(checkpoint, outcome.failure, "evaluating", limits)
          if (!failure.retry) blocked = failure.blocked
          checkpoint.phase = failure.retryPhase
          saveCheckpoint(config.stateDir, checkpoint)
          if (failure.retry) await sleep(infraOrParseDelay(outcome.failure.kind))
          break
        }

        evaluation = outcome.value
        checkpoint.infraErrors = 0
        checkpoint.parseErrors = 0
        saveEvaluation(config.stateDir, evaluation)

        const decision = decideNextPhase(checkpoint, evaluation.allPass, limits)

        if (decision.phase === "done") {
          printProgress(
            "evaluating",
            `All ${evaluation.passedCount}/${evaluation.totalCount} items passed!`,
          )
          checkpoint.phase = "done"
        } else {
          checkpoint.errors = evaluation.failures.map(
            (f) => `[${f.severity}] ${f.itemId}: ${f.errorDetail}`,
          )
          checkpoint.lastError = checkpoint.errors.join("\n")

          if (decision.phase === "fixing") {
            printProgress(
              "evaluating",
              `${evaluation.failedCount}/${evaluation.totalCount} items failed`,
            )
            checkpoint.phase = "fixing"
            checkpoint.retries++
          } else if (decision.phase === "replanning") {
            printProgress(
              "evaluating",
              `Max retries (${limits.maxRetries}) reached. Replanning (${checkpoint.replanCount + 1}/${limits.maxReplans})...`,
            )
            checkpoint.phase = "replanning"
            checkpoint.replanCount++
            checkpoint.retries = 0
          } else {
            printProgress("evaluating", decision.reason)
            blocked = decision.reason
            checkpoint.phase = "stuck"
          }
        }

        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      default:
        blocked = `Unknown phase "${checkpoint.phase}"`
        printProgress(checkpoint.phase, `${blocked} - marking as stuck`)
        checkpoint.phase = "stuck"
        saveCheckpoint(config.stateDir, checkpoint)
        break
    }
  }

  if (blocked && !checkpoint.lastError) {
    checkpoint.lastError = blocked
  }

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: checkpoint.phase,
    role: "system",
    action: "finish",
    detail:
      `Agent loop finished. Phase: ${checkpoint.phase}. ` +
      `Iterations: ${checkpoint.iterations}, retries: ${checkpoint.retries}, replans: ${checkpoint.replanCount}.`,
  })

  const report = generateReport(
    checkpoint,
    contract || undefined,
    evaluation || undefined,
    config,
    blocked,
  )

  return report
}

function infraOrParseDelay(kind: FailureKind): number {
  return kind === "infra" ? INFRA_BACKOFF_MS : PARSE_BACKOFF_MS
}
