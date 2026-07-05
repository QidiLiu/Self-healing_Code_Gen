import { OpencodeClient } from "@opencode-ai/sdk"
import { sendPrompt } from "../opencode.js"
import { Contract, AgentConfig, EvaluationResult } from "../types.js"
import { appendLog, loadPrinciplesFile } from "../state.js"

const GENERATOR_SYSTEM_PROMPT = `You are a Code Generator. Your sole job is to IMPLEMENT software according to a contract.

CRITICAL RULES:
1. You write code. You do NOT evaluate your own code. That is a different person's job.
2. Follow the CODING_PRINCIPLES you have been given as instructions.
3. Write the MINIMUM code that solves the problem. No premature abstraction.
4. Read before you write. Check what files exist in the workspace before editing them.
5. Keep your diffs SMALL and SURGICAL. Don't reformat or restructure.
6. Every task needs a success criterion. Think about what "working" means.
7. When something breaks, INVESTIGATE before guessing. Read the full error.
8. DO NOT add unused dependencies. Use what the standard library or existing deps provide.
9. After writing code, ALWAYS try to build and run it to verify basic functionality.
10. If the build or tests fail, fix the code based on the error messages.

WORKSPACE: The workspace is at the "workspace/" directory. This is where you create the user's project.
Write ALL code inside that directory. Create subdirectories as needed.

IMPORTANT: For web applications, create a self-contained HTML file (or minimal project) that can be opened directly in a browser. Use plain HTML/CSS/JS unless the contract specifies otherwise.

For a Fibonacci calculator GUI:
- Create an index.html file in the workspace
- Use clean, functional design
- Include input field, calculate button, result display
- Handle edge cases (negative numbers, non-numeric input, very large numbers)
- Make sure it looks presentable

START by reading any existing files in the workspace, then implement or fix the code.`

const GENERATOR_FIX_SYSTEM_PROMPT = `You are a Code Generator. Your previous implementation has FAILURES that need fixing.

CRITICAL RULES:
1. Read the evaluation failures carefully.
2. Make ONLY the changes needed to fix these specific failures.
3. Do NOT refactor or restructure unrelated code.
4. After each fix, verify it compiles/runs.
5. If a failure is unclear, write the most defensive fix possible (handle edge cases, add validation).
6. SURGICAL CHANGES only. Your diff should be as small as possible.

The evaluation failures are provided below. Fix them one at a time.`

export async function runGenerator(
  client: OpencodeClient,
  sessionId: string,
  contract: Contract,
  config: AgentConfig,
  evaluation?: EvaluationResult,
): Promise<string> {
  const model = {
    providerID: config.model.split("/")[0],
    modelID: config.model.split("/").slice(1).join("/"),
  }

  let systemPrompt: string
  let userPrompt: string

  if (evaluation && evaluation.failures.length > 0) {
    const failureList = evaluation.failures
      .map(
        (f) =>
          `[${f.severity.toUpperCase()}] ${f.itemId}: ${f.description}\n  Error: ${f.errorDetail}`,
      )
      .join("\n\n")

    systemPrompt = GENERATOR_FIX_SYSTEM_PROMPT
    userPrompt = `CONTRACT:\nThe contract has ${contract.items.length} items to implement.\n\nFAILURES TO FIX:\n${failureList}\n\nFix these specific failures. Do NOT modify code that is not related to these failures.`
  } else {
    const contractText = contract.items
      .map(
        (item) =>
          `[${item.id}] (${item.category}) ${item.description}\n  Test: ${item.testableAssertion}`,
      )
      .join("\n\n")

    systemPrompt = GENERATOR_SYSTEM_PROMPT
    userPrompt = `CONTRACT - ${contract.overview}\n\nImplement the following requirements:\n\n${contractText}\n\nBuild the complete implementation in the workspace/ directory.`
  }

  const loopPrinciples = loadPrinciplesFile("LOOP_PRINCIPLES.md")
  if (loopPrinciples) {
    systemPrompt += `\n\n--- YOUR ROLE IN THIS SYSTEM (from LOOP_PRINCIPLES.md) ---\n${loopPrinciples}`
  }
  const codingPrinciples = loadPrinciplesFile("CODING_PRINCIPLES.md")
  if (codingPrinciples) {
    systemPrompt += `\n\n--- CODING PRINCIPLES (follow these strictly) ---\n${codingPrinciples}`
  }

  const result = await sendPrompt(client, sessionId, systemPrompt, userPrompt, model, config.workspacePath)

  appendLog(config.stateDir, {
    timestamp: new Date().toISOString(),
    phase: evaluation ? "fixing" : "generating",
    role: "generator",
    action: evaluation ? "fix" : "generate",
    detail: evaluation
      ? `Fixing ${evaluation.failures.length} failures`
      : `Generated code implementing contract`,
  })

  return result.text
}
