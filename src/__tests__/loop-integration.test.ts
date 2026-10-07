import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { runAgentLoop } from "../loop.js"
import { loadConfig } from "../config.js"
import { AgentConfig } from "../types.js"

const PLANNER_ITEMS = Array.from({ length: 3 }, (_, i) => ({
  id: `ITEM-00${i + 1}`,
  description: `requirement ${i + 1}`,
  category: "logic",
  testableAssertion: `assertion ${i + 1}`,
}))

function textResponse(text: string, cost = 0.01) {
  return {
    data: {
      info: {
        id: "msg_1",
        error: undefined,
        cost,
        tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: "text", text }],
    },
  }
}

function evaluatorResponse(body: Record<string, unknown>) {
  return textResponse(JSON.stringify({ phase: "evaluation", summary: "stub", ...body }), 0.02)
}

/** Routes each prompt to the role that owns it, by inspecting the prompt text. */
function makeStubClient(
  overrides: {
    planner?: () => Promise<unknown>
    evaluator?: () => Promise<unknown>
  } = {},
) {
  let sessionCounter = 0
  const calls = { planner: 0, generator: 0, evaluator: 0 }

  const client = {
    session: {
      create: async () => {
        sessionCounter++
        return { data: { id: `ses_${sessionCounter}` } }
      },
      prompt: async (args: unknown) => {
        const prompt = (args as { body: { parts: { text: string }[] } }).body.parts[0].text

        if (prompt.includes("ITEMS TO VERIFY")) {
          calls.evaluator++
          if (overrides.evaluator) return overrides.evaluator()
          return evaluatorResponse({
            allPass: false,
            passedCount: 2,
            failedCount: 1,
            totalCount: 3,
            failures: [
              {
                itemId: "ITEM-003",
                description: "not implemented",
                errorDetail: "missing feature",
                severity: "high",
              },
            ],
          })
        }

        if (prompt.includes("REQUIREMENTS:") || prompt.includes("EVALUATION FAILURES")) {
          calls.planner++
          if (overrides.planner) return overrides.planner()
          return textResponse(JSON.stringify({ overview: "stub project", items: PLANNER_ITEMS }))
        }

        calls.generator++
        return textResponse("Wrote the implementation.")
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

describe("runAgentLoop termination", () => {
  it("reaches stuck after exactly maxReplans replans", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir, {
        maxRetries: 2,
        maxReplans: 2,
        maxTotalIterations: 50,
      })
      const { client, calls } = makeStubClient()

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

      assert.equal(calls.planner, 3, "1 initial plan + 2 replans")
      assert.equal(calls.generator, 9, "3 evaluations worth of fixes")
    })
  })

  it("stays within the iteration budget even when the budget is tiny", async () => {
    await withProject(async (rootDir) => {
      const config = makeConfig(rootDir, {
        maxRetries: 10,
        maxReplans: 10,
        maxTotalIterations: 4,
      })
      const { client } = makeStubClient()

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

      const { client } = makeStubClient({
        evaluator: async () => ({
          data: {
            info: {
              id: "m",
              error: {
                name: "ProviderAuthError",
                data: { providerID: "test", message: "invalid api key" },
              },
              cost: 0,
              tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            },
            parts: [],
          },
        }),
      })

      const report = await runAgentLoop(client as never, config)

      assert.equal(report.phase, "stuck")
      assert.match(report.blockingIssue ?? "", /Model\/provider unavailable/i)

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
      const { client } = makeStubClient({
        evaluator: async () =>
          evaluatorResponse({
            allPass: true,
            passedCount: 3,
            failedCount: 0,
            totalCount: 3,
            failures: [],
          }),
      })

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
      const { client } = makeStubClient()

      await runAgentLoop(client as never, config)

      const usage = JSON.parse(
        fs.readFileSync(path.join(rootDir, "state", "usage.json"), "utf-8"),
      )
      assert.ok(usage.requests > 0, "expected at least one request")
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
          plannerSessionId: "ses_old",
          generatorSessionId: "ses_old",
          evaluatorSessionId: "ses_old",
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
            {
              itemId: "ITEM-003",
              description: "still broken",
              errorDetail: "detail restored from disk",
              severity: "high",
            },
          ],
          summary: "restored",
        }),
      )

      const config = makeConfig(rootDir, { maxRetries: 2, maxReplans: 0, maxTotalIterations: 20 })
      const { client, calls } = makeStubClient()

      const report = await runAgentLoop(client as never, config)

      assert.equal(calls.planner, 0, "must not replan on resume")
      assert.equal(calls.generator, 2, "fix, evaluate, fix again, then replans exhausted")
      assert.equal(calls.evaluator, 2)
      assert.equal(report.phase, "stuck")
      assert.ok(report.failures.some((f) => f.itemId === "ITEM-003"))
    })
  })
})
