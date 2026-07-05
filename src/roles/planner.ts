import { OpencodeClient } from "@opencode-ai/sdk"
import { sendPrompt } from "../opencode.js"
import { Contract, ContractItem, AgentConfig } from "../types.js"
import { appendLog, ensureDir, loadPrinciplesFile } from "../state.js"
import { parseLLMJson, saveParseDebug } from "../json-parser.js"

const PLANNER_SYSTEM_PROMPT = `You are a Technical Architect specializing in requirement decomposition.
Your sole job is to transform vague requirements into a precise, testable contract.

RULES:
1. You NEVER write code. You only produce contracts.
2. Every item in the contract MUST have a testable assertion - a specific condition that an evaluator can verify as true or false.
3. Categorize items: ui, logic, validation, integration, testing.
4. Target around 15-25 items for a small project. Too few (<8) means undertesting; too many (>35) means over-engineering.
5. Think about: what does "done" really mean? What edges cases could break? What minimum functionality is required?
6. Consider boundary conditions, error states, and user experience.

OUTPUT FORMAT (JSON):
\`\`\`json
{
  "overview": "Brief description of the project",
  "items": [
    {
      "id": "ITEM-001",
      "description": "Human-readable description",
      "category": "ui|logic|validation|integration|testing",
      "testableAssertion": "A specific, verifiable statement that proves this requirement is met"
    }
  ]
}
\`\`\`

Respond ONLY with the JSON contract. No markdown wrappers, no explanations.`

const PLANNER_REPLAN_SYSTEM_PROMPT = `You are a Technical Architect.
The previous implementation attempt FAILED. Analyze the failure, adjust the contract.

RULES:
1. Review the original contract and the evaluation failures.
2. Decide if the contract was wrong (remove/modify impossible items) or if the implementation was wrong (keep items, adjust descriptions).
3. Add any missing items that became apparent from the failures.
4. Keep items you decide to re-attempt.

OUTPUT FORMAT (JSON):
\`\`\`json
{
  "overview": "Brief description of the project (updated)",
  "replanReason": "Why the previous plan failed and what changed",
  "items": [...same format as original contract...]
}
\`\`\`

Respond ONLY with the JSON contract. No markdown wrappers, no explanations.`

function parseContractFromText(text: string): Contract {
  const parseResult = parseLLMJson<Record<string, unknown>>(text)

  if (!parseResult.data) {
    throw new Error(`Failed to parse contract JSON: ${parseResult.error}\n\nRaw text:\n${text.substring(0, 500)}...`)
  }

  const parsed = parseResult.data

  const items: ContractItem[] = ((parsed.items as Record<string, unknown>[]) || []).map(
    (item, index: number) => ({
      id: (item.id as string) || `ITEM-${String(index + 1).padStart(3, "0")}`,
      description: (item.description as string) || "",
      category: (item.category as ContractItem["category"]) || "logic",
      status: "pending" as const,
      testableAssertion: (item.testableAssertion as string) || (item.description as string) || "",
    }),
  )

  return {
    overview: (parsed.overview as string) || "No overview provided",
    items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export async function runPlanner(
  client: OpencodeClient,
  sessionId: string,
  requirements: string,
  config: AgentConfig,
  failures?: string,
): Promise<Contract> {
  const model = {
    providerID: config.model.split("/")[0],
    modelID: config.model.split("/").slice(1).join("/"),
  }

  let userPrompt: string
  let systemPrompt: string

  if (failures) {
    systemPrompt = PLANNER_REPLAN_SYSTEM_PROMPT
    userPrompt = `ORIGINAL REQUIREMENTS:\n${requirements}\n\nEVALUATION FAILURES (why the previous implementation failed):\n${failures}\n\nProduce an updated contract addressing these failures.`
  } else {
    systemPrompt = PLANNER_SYSTEM_PROMPT
    userPrompt = `REQUIREMENTS:\n${requirements}\n\nProduce a testable contract for this project.`
  }

  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md")
  if (loopPrinciples) {
    systemPrompt += `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  }

  const result = await sendPrompt(client, sessionId, systemPrompt, userPrompt, model, config.workspacePath)

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: failures ? "replanning" : "planning",
    role: "planner",
    action: failures ? "replan" : "plan",
    detail: `Generated contract with ${result.text.length} chars response`,
  })

  let contract: Contract
  try {
    contract = parseContractFromText(result.text)
  } catch (parseError) {
    const errorMsg = (parseError as Error).message
    saveParseDebug(
      config.stateDir,
      { data: null, error: errorMsg, rawText: result.text },
      "planner",
    )
    appendLog(config.stateDir, {
      timestamp: new Date().toISOString(),
      phase: failures ? "replanning" : "planning",
      role: "planner",
      action: "parse_error",
      detail: `JSON parse failed: ${errorMsg.substring(0, 300)}`,
    })
    throw parseError
  }

  return contract
}
