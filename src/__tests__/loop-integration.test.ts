import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { runAgentLoop, setBackoffScale } from "../loop.js"
import { loadConfig } from "../config.js"
import { AgentConfig } from "../types.js"

// Provider failures back off for 5s; the tests below deliberately trigger them.
setBackoffScale(0)

const PLANNER_ITEMS = Array.from({ length: 3 }, (_, i) => ({
  id: `ITEM-00${i + 1}`,
  description: `requirement ${i + 1}`,
  category: "logic",
  testableAssertion: `assertion ${i + 1}`,
}))

function assistantMessage(text: string, cost = 0.02) {
  return {
    id: "msg_1",
    type: "assistant",
    content: [{ type: "text", text }],
    cost,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function promptResponse(data: unknown) {
  return { data }
}

/**
 * A stub of the opencode v2 host surface used by the loop.
 *
 * v2's `sessions.prompt()` only enqueues a turn; the reply comes back from
 * `message.list()`. The stub mirrors that so the loop's read path is exercised.
 */
function makeStubClient(
  overrides: {
    planner?: () => string
    generator?: () => string
    evaluator?: () => unknown
  } = {},
) {
  let sessionCounter = 0
  const calls = { planner: 0, generator: 0, evaluator: 0, create: 0 }

  const promptTexts: string[] = []

  const client = {
    sessions: {
      create: async (input: { title?: string }) => {
        calls.create++
        sessionCounter++
        return { id: `ses_${sessionCounter}`, ...input }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        const text = input.text
        promptTexts.push(text)

        if (text.includes("ITEMS TO VERIFY")) {
          calls.evaluator++
          return promptResponse({
            id: "user_msg",
            type: "user",
            payload: { text },
          })
        }
        if (text.includes("REQUIREMENTS:") || text.includes("EVALUATION FAILURES")) {
          calls.planner++
          const body = overrides.planner
            ? overrides.planner()
            : JSON.stringify({ overview: "stub project", items: PLANNER_ITEMS })
          return promptResponse({ id: "user_msg", type: "user", payload: { text: body } })
        }

        calls.generator++
        return promptResponse({ id: "user_msg", type: "user", payload: { text } })
      },
      wait: async () => undefined,
    },
    message: {
      list: async () => {
        const text = promptTexts[promptTexts.length - 1] ?? ""

        if (text.includes("ITEMS TO VERIFY")) {
          return {
            data: overrides.evaluator ? [overrides.evaluator()] : [assistantMessage("eval")],
          }
        }

        const body =
          text.includes("REQUIREMENTS:") || text.includes("EVALUATION FAILURES")
            ? overrides.planner
              ? overrides.planner()
              : JSON.stringify({ overview: "stub project", items: PLANNER_ITEMS })
            : overrides.generator
              ? overrides.generator()
              : "wrote the code"

        return { data: [assistantMessage(body)] }
      },
    },
  }

  return { client, calls }
}

function makeConfig(rootDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...loadConfig({
      model: "test/test-model",
      apiKey: "sk-test",
      requirements: path.join(rootDir, "requirements.md"),
    }),
    requirementsPath: path.join(rootDir, "requirements.md"),
    stateDir: path.join(rootDir, "state"),
    workspacePath: path.join(rootDir, "workspace"),
    outputDir: path.join(rootDir, "output"),
    apiKey: "sk-test",
    apiKeySource: "test",
    apiKeyError: null,
    ...overrides,
  }
}

function withProject<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-test-"))
  fs.writeFileSync(
    path.join(rootDir, "requirements.md"),
    "a stub requirement that is definitely long enough to pass validation",
    "utf-8",
  )
  return fn(rootDir).finally(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })
}

function readCheckpoint(rootDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "state", "checkpoint.json"), "utf-8"))
}

const ONE_FAILURE = {
  id: "msg_eval",
  type: "assistant",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        phase: "evaluation",
        allPass: false,
        passedCount: 2,
        failedCount: 1,
        totalCount: 3,
        failures: [
          { itemId: "ITEM-003", description: "not implemented", errorDetail: "missing feature", severity: "high" },
        ],
        summary: "one item failing",
      }),
    },
  ],
  cost: 0.02,
  tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
}

const PROVIDER_FAILURE = {
  id: "msg_eval",
  type: "assistant",
  content: [],
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  error: { type: "provider.auth", message: "invalid api key", status: 403 },
}

const ALL_PASS = {
  id: "msg_eval",
  type: "assistant",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        phase: "evaluation",
        allPass: true,
        passedCount: 3,
        failedCount: 0,
        totalCount: 3,
        failures: [],
        summary: "all good",
      }),
    },
  ],
  cost: 0.02,
  tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("runAgentLoop termination", () => {
  it("reaches stuck after exactly maxReplans replans", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir, {
        maxRetries: 2,
        maxReplans: 2,
        maxTotalIterations: 50,
      })
      const { client, calls } = makeStubClient({ evaluator: () => ONE_FAILURE })

      const report = await runAgentLoop(client as never, config)

      assert.equal(report.success, false)
      assert.equal(report.phase, "stuck")
      assert.match(report.blockingIssue ?? "", /exhausted/i)

      const checkpoint = readCheckpoint(rootDir)
      assert.equal(checkpoint.replanCount, 2, "replanCount must count actual replans")
      assert.equal(checkpoint.infraErrors, 0)
      assert.equal(checkpoint.parseErrors, 0)
      assert.ok(
        Number(checkpoint.iterations) <= 50,
        `ran ${checkpoint.iterations} iterations, budget was 50`,
      )

      // maxRetries=2 means 3 evaluations per plan (retries 0,1,2), and the
      // generator runs once per evaluation.
      assert.equal(calls.planner, 3, "1 initial plan + 2 replans")
      assert.equal(calls.evaluator, 9, "3 plans x 3 evaluations")
      assert.equal(calls.generator, 9)
      // planner rotates per replan (3), generator and evaluator are reused.
      assert.equal(calls.create, 3 + 1 + 1, "3 planner + 1 generator + 1 evaluator")
    })
  })

  it("stays within the iteration budget even when the budget is tiny", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir, {
        maxRetries: 10,
        maxReplans: 10,
        maxTotalIterations: 4,
      })
      const { client } = makeStubClient({ evaluator: () => ONE_FAILURE })

      const report = await runAgentLoop(client as never, config)

      assert.equal(report.phase, "stuck")
      assert.match(report.blockingIssue ?? "", /budget/i)

      const checkpoint = readCheckpoint(rootDir)
      assert.ok(Number(checkpoint.iterations) <= 4)
      assert.ok(Number(checkpoint.replanCount) <= 10)
    })
  })

  it("never charges the code retry budget for provider failures", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir, {
        maxRetries: 4,
        maxReplans: 2,
        maxInfraErrors: 2,
        maxTotalIterations: 100,
      })

      const { client } = makeStubClient({ evaluator: () => PROVIDER_FAILURE })

      const report = await runAgentLoop(client as never, config)

      assert.equal(report.phase, "stuck")
      assert.match(report.blockingIssue ?? "", /Model\/provider unavailable/i)
      assert.match(report.blockingIssue ?? "", /invalid api key/)
      assert.match(report.blockingIssue ?? "", /403/)

      const checkpoint = readCheckpoint(rootDir)
      assert.equal(checkpoint.infraErrors, 2)
      assert.equal(checkpoint.retries, 0, "a bad API key must not consume code retries")
      assert.equal(checkpoint.replanCount, 0)

      const errors = fs
        .readFileSync(path.join(rootDir, "state", "errors.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.ok(errors.length >= 2)
      assert.equal(errors[0].kind, "infra")
      assert.match(errors[0].message, /invalid api key/)
    })
  })

  it("reports done when every contract item passes", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir)
      const { client } = makeStubClient({ evaluator: () => ALL_PASS })

      const report = await runAgentLoop(client as never, config)

      assert.equal(report.success, true)
      assert.equal(report.phase, "done")
      assert.equal(report.contractItems.passed, 3)
      assert.equal(report.contractItems.total, 3)
    })
  })

  it("records cost and tokens across the run", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir)
      const { client } = makeStubClient({ evaluator: () => ALL_PASS })

      await runAgentLoop(client as never, config)

      const usage = JSON.parse(
        fs.readFileSync(path.join(rootDir, "state", "usage.json"), "utf-8"),
      )
      assert.equal(usage.requests, 3, "planner + generator + evaluator")
      assert.ok(usage.input > 0)
      assert.ok(usage.cost > 0)
    })
  })

  it("resumes from a checkpoint instead of restarting the sprint", async () => {
    await withProject(async (rootDir) => {
      const stateDir = path.join(rootDir, "state")
      fs.mkdirSync(stateDir, { recursive: true })

      // Simulate a crash after evaluation, before the fix.
      fs.writeFileSync(
        path.join(stateDir, "checkpoint.json"),
        JSON.stringify({
          phase: "fixing",
          retries: 1,
          replanCount: 0,
          iterations: 4,
          infraErrors: 0,
          parseErrors: 0,
          errors: [],
          lastError: null,
          plannerSessionId: null,
          generatorSessionId: null,
          evaluatorSessionId: null,
          updatedAt: new Date().toISOString(),
        }),
      )
      fs.writeFileSync(
        path.join(stateDir, "contract.json"),
        JSON.stringify({
          overview: "restored project",
          items: PLANNER_ITEMS.map((item) => ({ ...item, status: "pending" })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      )
      fs.writeFileSync(
        path.join(stateDir, "evaluation.json"),
        JSON.stringify({
          phase: "evaluation",
          allPass: false,
          passedCount: 2,
          failedCount: 1,
          totalCount: 3,
          failures: [
            { itemId: "ITEM-003", description: "still broken", errorDetail: "restored from disk", severity: "high" },
          ],
          summary: "restored",
        }),
      )

      const config = makeConfig(rootDir, { maxRetries: 2, maxReplans: 0, maxTotalIterations: 20 })
      const { client, calls } = makeStubClient({ evaluator: () => ONE_FAILURE })

      const report = await runAgentLoop(client as never, config)

      assert.equal(calls.planner, 0, "must not replan on resume")
      assert.equal(calls.generator, 2, "fix, evaluate, fix again, then replans exhausted")
      assert.equal(calls.evaluator, 2)
      assert.equal(report.phase, "stuck")
      assert.ok(report.failures.some((f) => f.itemId === "ITEM-003"))
    })
  })

  it("keeps each role in its own session", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir)
      const { client } = makeStubClient({ evaluator: () => ALL_PASS })

      await runAgentLoop(client as never, config)

      // planner, generator, evaluator: three distinct sessions.
      const checkpoint = readCheckpoint(rootDir)
      const ids = [
        checkpoint.plannerSessionId,
        checkpoint.generatorSessionId,
        checkpoint.evaluatorSessionId,
      ]
      assert.equal(new Set(ids).size, 3, `expected 3 distinct sessions, got ${ids.join(",")}`)
    })
  })
})
