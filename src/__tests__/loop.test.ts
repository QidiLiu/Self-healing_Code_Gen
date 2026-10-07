import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { decideNextPhase, LoopLimits } from "../loop.js"
import { Checkpoint } from "../types.js"

const LIMITS: LoopLimits = {
  maxRetries: 4,
  maxReplans: 2,
  maxInfraErrors: 3,
  maxTotalIterations: 17,
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    phase: "evaluating",
    retries: 0,
    replanCount: 0,
    iterations: 0,
    infraErrors: 0,
    parseErrors: 0,
    errors: [],
    lastError: null,
    plannerSessionId: null,
    generatorSessionId: null,
    evaluatorSessionId: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/**
 * Replays the transition policy the way runAgentLoop does: the caller increments
 * replanCount and resets retries on the way into "replanning". This is the
 * regression test for the bug where replanCount could never leave 0 and the
 * loop replanned forever.
 */
function simulateAlwaysFailing(limits: LoopLimits, hardCap = 10000): {
  iterations: number
  finalPhase: string
  replans: number
  retries: number
} {
  let cp = checkpoint()
  let iterations = 0

  while (cp.phase !== "done" && cp.phase !== "stuck") {
    if (iterations > hardCap) {
      throw new Error("loop did not terminate within the hard cap")
    }
    if (iterations >= limits.maxTotalIterations) {
      cp.phase = "stuck"
      break
    }
    iterations++

    const decision = decideNextPhase(cp, false, limits)
    if (decision.phase === "done") {
      cp.phase = "done"
    } else if (decision.phase === "fixing") {
      cp.phase = "fixing"
      cp.retries++
    } else if (decision.phase === "replanning") {
      cp.phase = "replanning"
      cp.replanCount++
      cp.retries = 0
    } else {
      cp.phase = "stuck"
    }

    if (cp.phase === "replanning") cp.phase = "planning"
    if (cp.phase === "planning") cp.phase = "generating"
    if (cp.phase === "fixing" || cp.phase === "generating") cp.phase = "evaluating"
  }

  return {
    iterations,
    finalPhase: cp.phase,
    replans: cp.replanCount,
    retries: cp.retries,
  }
}

describe("decideNextPhase", () => {
  it("reports done when everything passed", () => {
    assert.deepEqual(decideNextPhase(checkpoint(), true, LIMITS), { phase: "done" })
  })

  it("keeps fixing while retries remain", () => {
    for (const retries of [0, 1, 2, 3]) {
      assert.deepEqual(
        decideNextPhase(checkpoint({ retries }), false, LIMITS),
        { phase: "fixing" },
        `retries=${retries}`,
      )
    }
  })

  it("replans once retries are exhausted and replans remain", () => {
    assert.deepEqual(
      decideNextPhase(checkpoint({ retries: 4, replanCount: 0 }), false, LIMITS),
      { phase: "replanning" },
    )
    assert.deepEqual(
      decideNextPhase(checkpoint({ retries: 4, replanCount: 1 }), false, LIMITS),
      { phase: "replanning" },
    )
  })

  it("gets stuck once both retries and replans are exhausted", () => {
    const decision = decideNextPhase(
      checkpoint({ retries: 4, replanCount: 2 }),
      false,
      LIMITS,
    )
    assert.equal(decision.phase, "stuck")
  })

  it("respects zero replans", () => {
    const limits = { ...LIMITS, maxReplans: 0 }
    const decision = decideNextPhase(checkpoint({ retries: 4, replanCount: 0 }), false, limits)
    assert.equal(decision.phase, "stuck")
  })

  it("respects zero retries", () => {
    const limits = { ...LIMITS, maxRetries: 0 }
    assert.equal(
      decideNextPhase(checkpoint({ retries: 0, replanCount: 0 }), false, limits).phase,
      "replanning",
    )
  })
})

describe("loop termination", () => {
  it("terminates as stuck after exactly maxReplans replans", () => {
    const result = simulateAlwaysFailing(LIMITS)

    assert.equal(result.finalPhase, "stuck")
    assert.equal(result.replans, LIMITS.maxReplans)
    assert.ok(
      result.iterations <= LIMITS.maxTotalIterations,
      `ran ${result.iterations} iterations, budget ${LIMITS.maxTotalIterations}`,
    )
  })

  it("is bounded for every retry/replan combination", () => {
    for (const maxRetries of [0, 1, 2, 4, 9]) {
      for (const maxReplans of [0, 1, 2, 5]) {
        const limits: LoopLimits = {
          maxRetries,
          maxReplans,
          maxInfraErrors: 3,
          maxTotalIterations: (maxRetries + 1) * (maxReplans + 1) + 2,
        }
        const result = simulateAlwaysFailing(limits)

        assert.equal(result.finalPhase, "stuck", `${maxRetries}/${maxReplans}`)
        assert.equal(result.replans, maxReplans, `${maxRetries}/${maxReplans}`)
        assert.ok(
          result.iterations <= limits.maxTotalIterations,
          `${maxRetries}/${maxReplans} used ${result.iterations}`,
        )
      }
    }
  })

  it("never exceeds the iteration budget even if the budget is larger than needed", () => {
    const limits: LoopLimits = { ...LIMITS, maxTotalIterations: 3 }
    const result = simulateAlwaysFailing(limits)
    assert.equal(result.finalPhase, "stuck")
    assert.ok(result.iterations <= 3)
  })
})
