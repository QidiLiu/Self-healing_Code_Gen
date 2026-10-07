import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { normalizeEvaluation } from "../roles/evaluator.js"
import { Contract, ContractItem } from "../types.js"

function contract(count: number): Contract {
  const items: ContractItem[] = Array.from({ length: count }, (_, i) => ({
    id: `ITEM-00${i + 1}`,
    description: `requirement ${i + 1}`,
    category: "logic",
    status: "pending",
    testableAssertion: `assertion ${i + 1}`,
  }))
  return {
    overview: "test contract",
    items,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

describe("normalizeEvaluation", () => {
  it("accepts a consistent all-pass result", () => {
    const { evaluation, warnings } = normalizeEvaluation(
      { allPass: true, passedCount: 3, failedCount: 0, totalCount: 3, failures: [], summary: "ok" },
      contract(3),
    )

    assert.equal(evaluation.allPass, true)
    assert.equal(evaluation.passedCount, 3)
    assert.equal(evaluation.totalCount, 3)
    assert.equal(warnings.length, 0)
  })

  it("rejects allPass=true when failures are present", () => {
    const { evaluation, warnings } = normalizeEvaluation(
      {
        allPass: true,
        passedCount: 3,
        failedCount: 1,
        totalCount: 3,
        failures: [
          { itemId: "ITEM-002", description: "d", errorDetail: "e", severity: "low" },
        ],
        summary: "ok",
      },
      contract(3),
    )

    assert.equal(evaluation.allPass, false)
    assert.equal(evaluation.failedCount, 1)
    assert.equal(evaluation.passedCount, 2)
    assert.ok(warnings.some((w) => /claimed allPass=true/.test(w)))
  })

  it("never trusts inflated counts over the failure list", () => {
    // The silent false-success shape: claims everything passed with a
    // totalCount that does not match the contract.
    const { evaluation } = normalizeEvaluation(
      { allPass: true, passedCount: 99, failedCount: 0, totalCount: 99, failures: [], summary: "" },
      contract(3),
    )

    assert.equal(evaluation.totalCount, 3, "totalCount comes from the contract")
    assert.equal(evaluation.passedCount, 3)
    assert.equal(evaluation.allPass, true)
  })

  it("treats an empty contract as not passing", () => {
    const { evaluation, warnings } = normalizeEvaluation(
      { allPass: true, passedCount: 0, failedCount: 0, totalCount: 0, failures: [] },
      contract(0),
    )

    assert.equal(evaluation.allPass, false)
    assert.ok(warnings.some((w) => /cannot claim success/.test(w)))
  })

  it("defaults an invalid severity and warns", () => {
    const { evaluation, warnings } = normalizeEvaluation(
      {
        allPass: false,
        failures: [{ itemId: "ITEM-001", description: "d", errorDetail: "e", severity: "catastrophic" }],
      },
      contract(2),
    )

    assert.equal(evaluation.failures[0].severity, "medium")
    assert.ok(warnings.some((w) => /invalid severity/.test(w)))
  })

  it("warns about failures pointing at unknown contract items", () => {
    const { warnings } = normalizeEvaluation(
      {
        allPass: false,
        failures: [{ itemId: "ITEM-999", description: "d", errorDetail: "e", severity: "high" }],
      },
      contract(2),
    )

    assert.ok(warnings.some((w) => /unknown contract item "ITEM-999"/.test(w)))
  })

  it("counts derived failures even when the model omitted the counts", () => {
    const { evaluation } = normalizeEvaluation(
      {
        allPass: false,
        failures: [
          { itemId: "ITEM-001", description: "d", errorDetail: "e", severity: "high" },
          { itemId: "ITEM-002", description: "d", errorDetail: "e", severity: "low" },
        ],
      },
      contract(3),
    )

    assert.equal(evaluation.failedCount, 2)
    assert.equal(evaluation.passedCount, 1)
    assert.equal(evaluation.totalCount, 3)
    assert.equal(evaluation.allPass, false)
  })
})
