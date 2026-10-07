import { Contract, ContractItem, AgentConfig, RoleSpec } from "../types.js"
import { sendPrompt, PromptResult, OpencodeClient } from "../opencode.js"
import { appendLog, loadPrinciplesFile, recordUsage } from "../state.js"
import { traceSinkFor } from "../trace.js"
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
4. Keep items you decide to re-attempt, keeping their original ids stable so
   previous evaluation results still refer to the same requirement.

OUTPUT FORMAT (JSON):
\`\`\`json
{
  "overview": "Brief description of the project (updated)",
  "replanReason": "Why the previous plan failed and what changed",
  "items": [...same format as original contract...]
}
\`\`\`

Respond ONLY with the JSON contract. No markdown wrappers, no explanations.`

const VALID_CATEGORIES: ContractItem["category"][] = [
  "ui",
  "logic",
  "validation",
  "integration",
  "testing",
]

const MIN_ITEMS = 1
const RECOMMENDED_MIN_ITEMS = 8
const RECOMMENDED_MAX_ITEMS = 35
const MAX_REPAIR_ATTEMPTS = 2

/** Raised when the planner cannot produce a usable contract. Never a code bug. */
export class PlannerOutputError extends Error {
  readonly rawText: string

  constructor(message: string, rawText: string) {
    super(message)
    this.name = "PlannerOutputError"
    this.rawText = rawText
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Strict validation. Filling in defaults for missing fields would turn a
 * malformed response into a silently wrong contract, which is worse than
 * failing: the generator would implement requirements nobody asked for.
 */
function validateContractData(parsed: Record<string, unknown>): {
  contract: Contract | null
  error: string | null
  warning?: string
} {
  if (!isNonEmptyString(parsed.overview)) {
    return { contract: null, error: 'missing non-empty "overview"' }
  }

  const rawItems = parsed.items
  if (!Array.isArray(rawItems) || rawItems.length < MIN_ITEMS) {
    return { contract: null, error: '"items" must be a non-empty array' }
  }

  const items: ContractItem[] = []
  const seenIds = new Set<string>()

  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index] as Record<string, unknown>
    const where = `items[${index}]`

    if (!raw || typeof raw !== "object") {
      return { contract: null, error: `${where} is not an object` }
    }

    const id = isNonEmptyString(raw.id) ? raw.id.trim() : ""
    if (!id) {
      return { contract: null, error: `${where} is missing a non-empty "id"` }
    }
    if (seenIds.has(id)) {
      return { contract: null, error: `duplicate item id "${id}"` }
    }
    seenIds.add(id)

    if (!isNonEmptyString(raw.description)) {
      return { contract: null, error: `${where} (${id}) is missing "description"` }
    }
    if (!isNonEmptyString(raw.testableAssertion)) {
      return { contract: null, error: `${where} (${id}) is missing "testableAssertion"` }
    }
    if (!VALID_CATEGORIES.includes(raw.category as ContractItem["category"])) {
      return {
        contract: null,
        error: `${where} (${id}) has invalid category "${String(raw.category)}" (expected ${VALID_CATEGORIES.join("|")})`,
      }
    }

    items.push({
      id,
      description: raw.description.trim(),
      category: raw.category as ContractItem["category"],
      status: "pending",
      testableAssertion: raw.testableAssertion.trim(),
    })
  }

  let warning: string | undefined
  if (items.length < RECOMMENDED_MIN_ITEMS || items.length > RECOMMENDED_MAX_ITEMS) {
    warning = `contract has ${items.length} items, outside the recommended ${RECOMMENDED_MIN_ITEMS}-${RECOMMENDED_MAX_ITEMS} range`
  }

  return {
    contract: {
      overview: parsed.overview.trim(),
      items,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    error: null,
    warning,
  }
}

function parseContractFromText(text: string): {
  contract: Contract | null
  error: string | null
  warning?: string
} {
  const parseResult = parseLLMJson<Record<string, unknown>>(text)
  if (!parseResult.data) {
    return { contract: null, error: parseResult.error || "no JSON object found" }
  }
  return validateContractData(parseResult.data)
}

/**
 * The system prompt for the planner role. Declared as an opencode agent so the
 * role identity lives in opencode.json rather than being prepended to every
 * user turn (v2's sessions.prompt has no system field).
 */
export function plannerSystemPrompt(config: AgentConfig): string {
  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md", config.rootDir)
  if (!loopPrinciples) return PLANNER_SYSTEM_PROMPT
  return (
    PLANNER_SYSTEM_PROMPT +
    `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  )
}

export function plannerReplanSystemPrompt(config: AgentConfig): string {
  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md", config.rootDir)
  if (!loopPrinciples) return PLANNER_REPLAN_SYSTEM_PROMPT
  return (
    PLANNER_REPLAN_SYSTEM_PROMPT +
    `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  )
}

export async function runPlanner(
  spec: RoleSpec,
  contract: Contract | null,
  requirements: string,
  config: AgentConfig,
  failures?: string,
): Promise<Contract> {
  const isReplan = failures !== undefined
  const phase: "planning" | "replanning" = isReplan ? "replanning" : "planning"
  const action = isReplan ? "replan" : "plan"

  const userPrompt = isReplan
    ? `ORIGINAL REQUIREMENTS:\n${requirements}\n\nEVALUATION FAILURES (why the previous implementation failed):\n${failures}\n\nProduce an updated contract addressing these failures.`
    : `REQUIREMENTS:\n${requirements}\n\nProduce a testable contract for this project.`

  const ask = async (prompt: string): Promise<PromptResult> => {
    const result = await sendPrompt({
      client: spec.client,
      sessionId: spec.sessionId,
      text: prompt,
      directory: config.workspacePath,
      label: "planner",
      onTrace: traceSinkFor(config, "planner"),
    })
    recordUsage(config.stateDir, { ...result.usage, requests: 1 })
    return result
  }

  // A replan runs on a fresh session so the previous plan's context does not
  // anchor the model into repeating it.
  if (isReplan) {
    spec.sessionId = await spec.newSession("Planner (replan)")
  }

  let result = await ask(userPrompt)
  let parsed = parseContractFromText(result.text)
  let attempts = 0
  let lastRawText = result.text
  let lastError = parsed.error

  while (!parsed.contract && attempts < MAX_REPAIR_ATTEMPTS) {
    attempts++

    saveParseDebug(
      config.stateDir,
      { data: null, error: parsed.error || "invalid contract", rawText: lastRawText },
      "planner",
    )
    appendLog(config.stateDir, {
      timestamp: new Date().toISOString(),
      phase,
      role: "planner",
      action: "parse_error",
      detail: `Contract unusable (attempt ${attempts}): ${(parsed.error || "").slice(0, 300)}`,
    })

    const repairPrompt =
      `Your previous response could not be used: ${parsed.error}\n\n` +
      `First 1500 characters of your previous response:\n${lastRawText.slice(0, 1500)}\n\n` +
      `Return ONLY a JSON object of exactly this shape, with no prose and no markdown fences:\n` +
      `{"overview": "...", "items": [{"id": "ITEM-001", "description": "...", ` +
      `"category": "ui|logic|validation|integration|testing", "testableAssertion": "..."}]}`

    result = await ask(repairPrompt)
    lastRawText = result.text
    parsed = parseContractFromText(result.text)
    lastError = parsed.error
  }

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase,
    role: "planner",
    action,
    detail: parsed.contract
      ? `Generated contract with ${parsed.contract.items.length} items${parsed.warning ? ` (warning: ${parsed.warning})` : ""}`
      : `Failed to produce a usable contract: ${(lastError || "").slice(0, 200)}`,
  })

  if (!parsed.contract) {
    throw new PlannerOutputError(
      `Planner produced no usable contract after ${attempts} repair attempts: ${lastError}`,
      lastRawText,
    )
  }

  void contract
  return parsed.contract
}
