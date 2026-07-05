import { OpencodeClient } from "@opencode-ai/sdk"
import { sendPrompt } from "../opencode.js"
import { Contract, ContractItem, EvaluationResult, EvaluationFailure, AgentConfig } from "../types.js"
import { appendLog, loadPrinciplesFile } from "../state.js"
import { parseLLMJson, saveParseDebug } from "../json-parser.js"

const EVALUATOR_SYSTEM_PROMPT = `You are an Evaluator. Your job is to PROVE that the code is BROKEN.

CRITICAL RULES:
1. The code IS broken. Your job is to find where and how.
2. Review the contract. For each contract item, determine if the implementation actually satisfies it.
3. Be ruthless. Do not give the benefit of the doubt. If something is questionable, flag it.
4. Check the actual files in the workspace/ directory. Read them, try to run them if applicable.
5. Check edge cases, error handling, UX issues, correctness.
6. For each item, mark it as pass or fail with detailed reasoning.

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

Respond ONLY with the JSON. No markdown wrappers, no explanations.`

function parseEvaluationFromText(text: string): EvaluationResult {
  const parseResult = parseLLMJson<Record<string, unknown>>(text)

  if (parseResult.data) {
    const parsed = parseResult.data
    const failures: EvaluationFailure[] = (parsed.failures as Record<string, unknown>[] || []).map(
      (f) => ({
        itemId: (f.itemId as string) || "",
        description: (f.description as string) || "",
        errorDetail: (f.errorDetail as string) || "",
        severity: (f.severity as EvaluationFailure["severity"]) || "medium",
      }),
    )

    return {
      phase: "evaluation",
      allPass: parsed.allPass === true,
      passedCount: (parsed.passedCount as number) || 0,
      failedCount: (parsed.failedCount as number) || failures.length,
      totalCount: (parsed.totalCount as number) || 0,
      failures,
      summary: (parsed.summary as string) || "No summary provided",
    }
  }

  throw new Error(`Failed to parse evaluation JSON: ${parseResult.error}\n\nRaw text:\n${text.substring(0, 500)}...`)
}

function createFallbackEvaluation(
  contract: Contract,
  rawText: string,
  error: string,
): EvaluationResult {
  const failures: EvaluationFailure[] = [
    {
      itemId: "PARSE-ERROR",
      description: "Failed to parse evaluator response",
      errorDetail: `JSON parse error: ${error}. Raw response saved to debug directory.`,
      severity: "high",
    },
  ]

  const allItems = contract.items.map((item) => ({
    itemId: item.id,
    description: "Could not evaluate due to parse failure",
    errorDetail: "Evaluator response was malformed JSON",
    severity: "medium" as const,
  }))

  return {
    phase: "evaluation",
    allPass: false,
    passedCount: 0,
    failedCount: contract.items.length + 1,
    totalCount: contract.items.length,
    failures: [...failures, ...allItems],
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
        `[${item.id}] (${item.category}) Status: ${item.status}\n  Description: ${item.description}\n  Test: ${item.testableAssertion}`,
    )
    .join("\n\n")

  const userPrompt = `CONTRACT:\n${contract.overview}\n\nITEMS TO VERIFY:\n${contractText}\n\nEvaluate the implementation in the workspace/ directory against every contract item. Be thorough and ruthless.`

  let systemPrompt = EVALUATOR_SYSTEM_PROMPT
  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md")
  if (loopPrinciples) {
    systemPrompt += `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  }

  const result = await sendPrompt(client, sessionId, systemPrompt, userPrompt, model, config.workspacePath)

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: "evaluating",
    role: "evaluator",
    action: "evaluate",
    detail: `Evaluated implementation`,
  })

  let evaluation: EvaluationResult
  try {
    evaluation = parseEvaluationFromText(result.text)
  } catch (parseError) {
    const errorMsg = (parseError as Error).message
    saveParseDebug(
      config.stateDir,
      { data: null, error: errorMsg, rawText: result.text },
      "evaluator",
    )
    appendLog(config.stateDir, {
      timestamp: new Date().toISOString(),
      phase: "evaluating",
      role: "evaluator",
      action: "parse_error",
      detail: `JSON parse failed: ${errorMsg.substring(0, 300)}`,
    })
    evaluation = createFallbackEvaluation(contract, result.text, errorMsg)
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
