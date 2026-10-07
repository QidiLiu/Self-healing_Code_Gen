import { OpencodeClient } from "@opencode-ai/sdk"
import { sendPrompt } from "../opencode.js"
import { Contract, EvaluationResult, EvaluationFailure, AgentConfig } from "../types.js"
import { appendLog, loadPrinciplesFile, recordUsage } from "../state.js"
import { parseLLMJson, saveParseDebug } from "../json-parser.js"

const EVALUATOR_SYSTEM_PROMPT = `You are an Evaluator. Your job is to PROVE that the code is BROKEN.

CRITICAL RULES:
1. The code IS broken. Your job is to find where and how.
2. Review the contract. For each contract item, determine if the implementation actually satisfies it.
3. Be ruthless. Do not give the benefit of the doubt. If something is questionable, flag it.
4. Check the actual files in the workspace/ directory. Read them, try to run them if applicable.
5. Check edge cases, error handling, UX issues, correctness.
6. For each item, mark it as pass or fail with detailed reasoning.
7. Never mark everything as passed. If you cannot verify an item, it FAILS.

EVALUATION CRITERIA:
- PASS: The implementation CLEARLY and FULLY satisfies the contract item.
- FAIL: Missing, incomplete, incorrect, or unverifiable.

OUTPUT FORMAT (JSON):
\`\`\`json
{
  "phase": "evaluation",
  "allPass": true,
  "passedCount": 0,
  "failedCount": 0,
  "totalCount": 0,
  "failures": [
    {
      "itemId": "ITEM-001",
      "description": "Why it failed",
      "errorDetail": "Specific evidence of failure",
      "severity": "critical|high|medium|low"
    }
  ],
  "summary": "Overall assessment"
}
\`\`\`

allPass must be true ONLY when totalCount equals passedCount and failures is empty.
failedCount must equal the number of entries in failures.

Respond ONLY with the JSON. No markdown wrappers, no explanations.`

const VALID_SEVERITIES: EvaluationFailure["severity"][] = ["critical", "high", "medium", "low"]

export class EvaluationOutputError extends Error {
  readonly rawText: string

  constructor(message: string, rawText: string) {
    super(message)
    this.name = "EvaluationOutputError"
    this.rawText = rawText
  }
}

/**
 * Reconciles the evaluator's self-reported counts against its own failure list
 * and against the contract. Without this, a response of
 * {"allPass": true, "totalCount": 0} would be accepted as a successful run with
 * zero items checked.
 */
export function normalizeEvaluation(
  parsed: Record<string, unknown>,
  contract: Contract,
): { evaluation: EvaluationResult; warnings: string[] } {
  const warnings: string[] = []

  const rawFailures = Array.isArray(parsed.failures) ? parsed.failures : []
  const failures: EvaluationFailure[] = rawFailures.map((f, index) => {
    const raw = (f || {}) as Record<string, unknown>
    const severity = VALID_SEVERITIES.includes(raw.severity as EvaluationFailure["severity"])
      ? (raw.severity as EvaluationFailure["severity"])
      : "medium"
    if (!VALID_SEVERITIES.includes(raw.severity as EvaluationFailure["severity"])) {
      warnings.push(`failures[${index}] had invalid severity "${String(raw.severity)}", defaulted to medium`)
    }
    return {
      itemId: typeof raw.itemId === "string" ? raw.itemId.trim() : "",
      description: typeof raw.description === "string" ? raw.description : "",
      errorDetail: typeof raw.errorDetail === "string" ? raw.errorDetail : "",
      severity,
    }
  })

  const contractIds = new Set(contract.items.map((item) => item.id))
  for (const failure of failures) {
    if (failure.itemId && !contractIds.has(failure.itemId)) {
      warnings.push(`failure references unknown contract item "${failure.itemId}"`)
    }
  }

  const totalCount = contract.items.length
  const failedCount = failures.length
  const passedCount = Math.max(0, totalCount - failedCount)

  // Trust the failure list, never the model's own allPass.
  const allPass = failedCount === 0 && passedCount === totalCount && totalCount > 0

  if (parsed.allPass === true && !allPass) {
    warnings.push(`evaluator claimed allPass=true but reported ${failedCount} failure(s); treated as failure`)
  }
  if (failedCount === 0 && totalCount === 0) {
    warnings.push("contract has no items; cannot claim success")
  }

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "No summary provided"

  return {
    evaluation: {
      phase: "evaluation",
      allPass,
      passedCount,
      failedCount,
      totalCount,
      failures,
      summary,
    },
    warnings,
  }
}

function createFallbackEvaluation(
  contract: Contract,
  error: string,
): EvaluationResult {
  const failures: EvaluationFailure[] = [
    {
      itemId: "PARSE-ERROR",
      description: "Failed to parse evaluator response",
      errorDetail: `JSON parse error: ${error}. Raw response saved to state/debug/.`,
      severity: "high",
    },
    ...contract.items.map((item) => ({
      itemId: item.id,
      description: "Could not evaluate due to parse failure",
      errorDetail: "Evaluator response was malformed JSON",
      severity: "medium" as const,
    })),
  ]

  return {
    phase: "evaluation",
    allPass: false,
    passedCount: 0,
    failedCount: failures.length,
    totalCount: contract.items.length,
    failures,
    summary: `Evaluation failed: could not parse LLM response as JSON. Error: ${error.substring(0, 200)}`,
  }
}

export async function runEvaluator(
  client: OpencodeClient,
  sessionId: string,
  contract: Contract,
  config: AgentConfig,
): Promise<EvaluationResult> {
  const model = {
    providerID: config.model.split("/")[0],
    modelID: config.model.split("/").slice(1).join("/"),
  }

  const contractText = contract.items
    .map(
      (item) =>
        `[${item.id}] (${item.category})\n  Description: ${item.description}\n  Test: ${item.testableAssertion}`,
    )
    .join("\n\n")

  const userPrompt = `CONTRACT:\n${contract.overview}\n\nITEMS TO VERIFY (${contract.items.length} items):\n${contractText}\n\nEvaluate the implementation in the workspace/ directory against every contract item. Be thorough and ruthless.`

  let systemPrompt = EVALUATOR_SYSTEM_PROMPT
  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md", config.rootDir)
  if (loopPrinciples) {
    systemPrompt += `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  }

  const result = await sendPrompt(client, sessionId, systemPrompt, userPrompt, model, config.workspacePath)
  recordUsage(config.stateDir, { ...result.usage, requests: 1 })

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: "evaluating",
    role: "evaluator",
    action: "evaluate",
    detail: `Evaluated implementation against ${contract.items.length} contract items`,
  })

  let evaluation: EvaluationResult
  try {
    const parseResult = parseLLMJson<Record<string, unknown>>(result.text)
    if (!parseResult.data) {
      throw new EvaluationOutputError(
        parseResult.error || "no JSON object found",
        result.text,
      )
    }

    const normalized = normalizeEvaluation(parseResult.data, contract)
    evaluation = normalized.evaluation

    if (normalized.warnings.length > 0) {
      appendLog(config.stateDir, {
        timestamp: new Date().toISOString(),
        phase: "evaluating",
        role: "evaluator",
        action: "normalize_warning",
        detail: normalized.warnings.join("; ").slice(0, 500),
      })
    }
  } catch (parseError) {
    const errorMsg = (parseError as Error).message
    saveParseDebug(
      config.stateDir,
      {
        data: null,
        error: errorMsg,
        rawText: parseError instanceof EvaluationOutputError
          ? parseError.rawText
          : result.text,
      },
      "evaluator",
    )
    appendLog(config.stateDir, {
      timestamp: new Date().toISOString(),
      phase: "evaluating",
      role: "evaluator",
      action: "parse_error",
      detail: `JSON parse failed: ${errorMsg.substring(0, 300)}`,
    })
    evaluation = createFallbackEvaluation(contract, errorMsg)
  }

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: "evaluating",
    role: "evaluator",
    action: "result",
    detail: `${evaluation.passedCount}/${evaluation.totalCount} passed, ${evaluation.failedCount} failed`,
  })

  return evaluation
}
