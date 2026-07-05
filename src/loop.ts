import { OpencodeClient } from "@opencode-ai/sdk"
import {
  AgentConfig,
  AgentPhase,
  Checkpoint,
  Contract,
  EvaluationResult,
  AgentReport,
} from "./types.js"
import {
  loadCheckpoint,
  saveCheckpoint,
  saveContractJson,
  saveProgress,
  saveEvaluation,
  appendLog,
  ensureDir,
} from "./state.js"
import { createSession } from "./opencode.js"
import { runPlanner } from "./roles/planner.js"
import { runGenerator } from "./roles/generator.js"
import { runEvaluator } from "./roles/evaluator.js"
import { generateReport, printProgress } from "./reporter.js"
import * as fs from "fs"

export async function runAgentLoop(
  client: OpencodeClient,
  config: AgentConfig,
): Promise<AgentReport> {
  ensureDir(config.stateDir)
  ensureDir(config.workspacePath)
  ensureDir(config.outputDir)

  let checkpoint = loadCheckpoint(config.stateDir)
  let contract: Contract | null = null
  let evaluation: EvaluationResult | null = null

  const requirements = fs.readFileSync(config.requirementsPath, "utf-8")

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: checkpoint.phase,
    role: "system",
    action: "start",
    detail: `Starting agent loop from phase: ${checkpoint.phase}`,
  })

  printProgress(checkpoint.phase, "Starting agent system...")

  while (checkpoint.phase !== "done" && checkpoint.phase !== "stuck") {
    switch (checkpoint.phase) {
      case "idle":
      case "replanning": {
        checkpoint.phase = "planning"
        saveCheckpoint(config.stateDir, checkpoint)

        printProgress("planning", "Analyzing requirements and creating contract...")

        const plannerSessionId = checkpoint.plannerSessionId ||
          await createSession(client, "Planner Session", config.workspacePath)

        checkpoint.plannerSessionId = plannerSessionId

        const isReplan = checkpoint.replanCount > 0
        const failuresText = checkpoint.errors.length > 0
          ? checkpoint.errors.join("\n---\n")
          : undefined

        contract = await runPlanner(
          client,
          plannerSessionId,
          requirements,
          config,
          failuresText,
        )

        saveContractJson(config.stateDir, contract)
        saveProgress(config.stateDir, "planning", `Contract created: ${contract.overview}\n${contract.items.length} items defined`)

        if (isReplan) {
          checkpoint.replanCount++
          checkpoint.retries = 0
        }

        printProgress("planning", `Contract created with ${contract.items.length} items`)

        checkpoint.phase = "generating"
        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      case "generating":
      case "fixing": {
        printProgress(
          checkpoint.phase,
          checkpoint.phase === "fixing"
            ? `Fixing ${evaluation?.failures.length || 0} issues... (attempt ${checkpoint.retries + 1})`
            : "Generating implementation...",
        )

        const generatorSessionId = checkpoint.generatorSessionId ||
          await createSession(client, "Generator Session", config.workspacePath)

        checkpoint.generatorSessionId = generatorSessionId

        if (!contract) {
          checkpoint.phase = "planning"
          saveCheckpoint(config.stateDir, checkpoint)
          break
        }

        await runGenerator(
          client,
          generatorSessionId,
          contract,
          config,
          checkpoint.phase === "fixing" ? evaluation || undefined : undefined,
        )

        saveProgress(
          config.stateDir,
          checkpoint.phase,
          checkpoint.phase === "fixing"
            ? `Fixing ${evaluation?.failures.length || 0} issues, attempt ${checkpoint.retries + 1}`
            : "Implementation generated",
        )

        checkpoint.phase = "evaluating"
        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      case "evaluating": {
        printProgress("evaluating", "Evaluating implementation...")

        const evaluatorSessionId = checkpoint.evaluatorSessionId ||
          await createSession(client, "Evaluator Session", config.workspacePath)

        checkpoint.evaluatorSessionId = evaluatorSessionId

        if (!contract) {
          checkpoint.phase = "planning"
          saveCheckpoint(config.stateDir, checkpoint)
          break
        }

        evaluation = await runEvaluator(client, evaluatorSessionId, contract, config)
        saveEvaluation(config.stateDir, evaluation)

        if (evaluation.allPass) {
          printProgress(
            "evaluating",
            `All ${evaluation.passedCount}/${evaluation.totalCount} items passed!`,
          )
          checkpoint.phase = "done"
        } else {
          printProgress(
            "evaluating",
            `${evaluation.failedCount}/${evaluation.totalCount} items failed`,
          )

          checkpoint.errors = evaluation.failures.map(
            (f) => `[${f.severity}] ${f.itemId}: ${f.errorDetail}`,
          )
          checkpoint.lastError = checkpoint.errors.join("\n")

          const shouldReplan =
            checkpoint.retries >= config.maxRetries &&
            checkpoint.replanCount < config.maxReplans

          if (shouldReplan) {
            printProgress(
              "evaluating",
              `Max retries (${config.maxRetries}) reached. Replanning...`,
            )
            checkpoint.phase = "replanning"
            checkpoint.retries = 0
          } else if (checkpoint.retries >= config.maxRetries) {
            printProgress(
              "evaluating",
              `Max retries and replans exhausted. Marking as stuck.`,
            )
            checkpoint.phase = "stuck"
          } else {
            checkpoint.phase = "fixing"
            checkpoint.retries++
          }
        }

        saveCheckpoint(config.stateDir, checkpoint)
        break
      }

      default:
        printProgress(
          checkpoint.phase,
          `Unknown phase "${checkpoint.phase}" - marking as stuck`,
        )
        checkpoint.phase = "stuck"
        saveCheckpoint(config.stateDir, checkpoint)
        break
    }
  }

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: checkpoint.phase,
    role: "system",
    action: "finish",
    detail: `Agent loop finished. Phase: ${checkpoint.phase}`,
  })

  const report = generateReport(
    checkpoint,
    contract || undefined,
    evaluation || undefined,
    config,
  )

  return report
}
