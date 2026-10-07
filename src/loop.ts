import {
  AgentConfig,
  AgentPhase,
  AgentReport,
  Checkpoint,
  Contract,
  EvaluationResult,
  RoleName,
  RoleSpec,
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
  InterruptedError,
  isShutdownRequested,
  OpencodeClient,
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
/** Malformed output is retried this many times before the run is declared stuck. */
const MAX_PARSE_RETRIES = 2
const MAX_PARSE_ERRORS = MAX_PARSE_RETRIES + 1

/**
 * Backoff multiplier for the retrying-failure paths, overridable so tests do not
 * spend five seconds per provider error.
 */
let backoffScale = 1

export function setBackoffScale(scale: number): void {
  backoffScale = scale
}

function backoffFor(kind: FailureKind): Promise<void> {
  const base = kind === "infra" ? INFRA_BACKOFF_MS : PARSE_BACKOFF_MS
  return sleep(Math.round(base * backoffScale))
}

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
function classifyFailure(err: unknown): RoleFailure | null {
  // A shutdown is neither a code bug nor a provider problem; the loop should
  // just stop.
  if (err instanceof InterruptedError) return null

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
  role: RoleName,
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; failure: RoleFailure } | { ok: false; interrupted: true }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err: unknown) {
    const failure = classifyFailure(err)
    if (!failure) {
      return { ok: false, interrupted: true }
    }
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
      role,
      action: failure.kind === "infra" ? "infra_error" : "parse_error",
      detail: `[${label}] ${failure.message}`,
    })
    return { ok: false, failure }
  }
}

interface FailureOutcome {
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
        retry: false,
        blocked: `Model/provider unavailable: ${failure.message}.${hint}`,
      }
    }
    printProgress(
      currentPhase,
      `Model/provider error (${checkpoint.infraErrors}/${limits.maxInfraErrors}): ${failure.message}`,
    )
    return { retry: true, blocked: null }
  }

  checkpoint.parseErrors++
  if (checkpoint.parseErrors >= MAX_PARSE_ERRORS) {
    printProgress(
      currentPhase,
      `Malformed model output ${checkpoint.parseErrors} times in a row. Marking as stuck.`,
    )
    return {
      retry: false,
      blocked: `Model output could not be parsed: ${failure.message}`,
    }
  }
  printProgress(
    currentPhase,
    `Malformed model output, retrying (${checkpoint.parseErrors}/${MAX_PARSE_ERRORS})`,
  )
  return { retry: true, blocked: null }
}

export interface RoleRegistry {
  planner: RoleSpec
  generator: RoleSpec
  evaluator: RoleSpec
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

  const model = {
    id: config.model.includes("/") ? config.model.slice(config.model.indexOf("/") + 1) : config.model,
    providerID: config.model.includes("/") ? config.model.slice(0, config.model.indexOf("/")) : "opencode",
  }

  /**
   * A role bound to a lazily created session.
   *
   * Session ids are not persisted across processes: v2 sessions live inside one
   * host, so a stored id from a previous run cannot be reused. The replan path
   * clears the id to force a fresh session, which is why it is writable.
   */
  const makeRole = (name: RoleName): RoleSpec => {
    const spec: RoleSpec = {
      name,
      client,
      sessionId: "",
      newSession: async (title: string) =>
        createSession(client, title, config.workspacePath, model, name),
    }
    return spec
  }

  const roles: RoleRegistry = {
    planner: makeRole("planner"),
    generator: makeRole("generator"),
    evaluator: makeRole("evaluator"),
  }

  const ensureSession = async (spec: RoleSpec, title: string): Promise<void> => {
    if (!spec.sessionId) {
      spec.sessionId = await spec.newSession(title)
    }
  }

  checkpoint.plannerSessionId = null
  checkpoint.generatorSessionId = null
  checkpoint.evaluatorSessionId = null

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

        await ensureSession(roles.planner, "Planner Session")
        checkpoint.plannerSessionId = roles.planner.sessionId

        const outcome = await guardRoleCall(config, "planner", "runPlanner", () =>
          runPlanner(
            roles.planner,
            contract,
            requirements,
            config,
            isReplan ? checkpoint.errors.join("\n---\n") : undefined,
          ),
        )

        if (!outcome.ok) {
          if ("interrupted" in outcome) {
            blocked = "Interrupted by shutdown."
            checkpoint.phase = "stuck"
            break
          }
          const failure = applyFailure(checkpoint, outcome.failure, "planning", limits)
          if (!failure.retry) {
            blocked = failure.blocked
            checkpoint.phase = "stuck"
          } else {
            await backoffFor(outcome.failure.kind)
          }
          saveCheckpoint(config.stateDir, checkpoint)
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

        await ensureSession(roles.generator, "Generator Session")
        checkpoint.generatorSessionId = roles.generator.sessionId

        const outcome = await guardRoleCall(config, "generator", "runGenerator", () =>
          runGenerator(
            roles.generator,
            contract!,
            config,
            fixing ? evaluation || undefined : undefined,
          ),
        )

        if (!outcome.ok) {
          if ("interrupted" in outcome) {
            blocked = "Interrupted by shutdown."
            checkpoint.phase = "stuck"
            break
          }
          const failure = applyFailure(checkpoint, outcome.failure, checkpoint.phase, limits)
          if (!failure.retry) {
            blocked = failure.blocked
            checkpoint.phase = "stuck"
          } else {
            await backoffFor(outcome.failure.kind)
          }
          saveCheckpoint(config.stateDir, checkpoint)
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

        await ensureSession(roles.evaluator, "Evaluator Session")
        checkpoint.evaluatorSessionId = roles.evaluator.sessionId

        const outcome = await guardRoleCall(config, "evaluator", "runEvaluator", () =>
          runEvaluator(roles.evaluator, contract!, config),
        )

        if (!outcome.ok) {
          if ("interrupted" in outcome) {
            blocked = "Interrupted by shutdown."
            checkpoint.phase = "stuck"
            break
          }
          const failure = applyFailure(checkpoint, outcome.failure, "evaluating", limits)
          if (!failure.retry) {
            blocked = failure.blocked
            checkpoint.phase = "stuck"
          } else {
            await backoffFor(outcome.failure.kind)
          }
          saveCheckpoint(config.stateDir, checkpoint)
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
            // runPlanner rotates its own session on a replan; clearing it here
            // too would just allocate a throwaway session.
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

  return generateReport(
    checkpoint,
    contract || undefined,
    evaluation || undefined,
    config,
    blocked,
  )
}
