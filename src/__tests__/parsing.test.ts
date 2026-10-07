import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { parseLLMJson } from "../json-parser.js"
import { readKeyFile, parseModel } from "../config.js"
import { validateRequirementsContent } from "../requirements.js"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

describe("parseLLMJson", () => {
  it("parses a plain object", () => {
    const result = parseLLMJson<{ a: number }>('{"a": 1}')
    assert.deepEqual(result.data, { a: 1 })
    assert.equal(result.error, null)
  })

  it("strips a surrounding markdown fence", () => {
    const result = parseLLMJson<{ a: number }>("```json\n{\"a\": 1}\n```")
    assert.deepEqual(result.data, { a: 1 })
  })

  it("keeps braces that appear inside string values", () => {
    // Regression: naive brace counting truncated the object here.
    const text = JSON.stringify({
      items: [{ assertion: 'the file uses a { placeholder } and a } closing brace' }],
    })
    const result = parseLLMJson<{ items: { assertion: string }[] }>(text)

    assert.ok(result.data, result.error ?? "parse failed")
    assert.equal(result.data!.items[0].assertion, "the file uses a { placeholder } and a } closing brace")
  })

  it("keeps fenced blocks that appear inside string values", () => {
    const text = '{"a": "create an ```html``` file"}'
    const result = parseLLMJson<{ a: string }>(text)
    assert.deepEqual(result.data, { a: "create an ```html``` file" })
  })

  it("is not confused by escaped quotes", () => {
    const text = String.raw`{"a": "he said \"hello\" then left", "b": 2}`
    const result = parseLLMJson<{ a: string; b: number }>(text)
    assert.deepEqual(result.data, { a: 'he said "hello" then left', b: 2 })
  })

  it("finds the object after chatty preamble", () => {
    const text = 'Sure! Here is the contract:\n\n```json\n{"items": []}\n```\n\nLet me know.'
    const result = parseLLMJson<{ items: unknown[] }>(text)
    assert.deepEqual(result.data, { items: [] })
  })

  it("repairs unquoted keys", () => {
    const result = parseLLMJson<{ a: number }>("{a: 1}")
    assert.deepEqual(result.data, { a: 1 })
  })

  it("repairs trailing commas", () => {
    const result = parseLLMJson<{ a: number[] }>('{"a": [1, 2,],}')
    assert.deepEqual(result.data, { a: [1, 2] })
  })

  it("repairs raw newlines inside string values", () => {
    const text = '{\n  "a": "line one\nline two",\n  "b": 2\n}'
    const result = parseLLMJson<{ a: string; b: number }>(text)
    assert.ok(result.data, result.error ?? "parse failed")
    assert.equal(result.data!.a, "line one\nline two")
    assert.equal(result.data!.b, 2)
  })

  it("reports an error for output with no object", () => {
    const result = parseLLMJson("I could not do that.")
    assert.equal(result.data, null)
    assert.match(result.error!, /No JSON object/)
    assert.equal(result.rawText, "I could not do that.")
  })

  it("reports an error for truncated output", () => {
    const result = parseLLMJson('{"items": [{"id": "ITEM-001"')
    assert.equal(result.data, null)
    assert.ok(result.error)
  })
})

describe("readKeyFile", () => {
  function withFile(content: string, fn: (file: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyfile-test-"))
    try {
      const file = path.join(dir, "DEEPSEEK_KEY.md")
      fs.writeFileSync(file, content, "utf-8")
      fn(file)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it("reads a bare key", () => {
    withFile("sk-abc123\n", (file) => {
      assert.equal(readKeyFile(file).key, "sk-abc123")
    })
  })

  it("unwraps a fenced key", () => {
    withFile("```\nsk-abc123\n```\n", (file) => {
      assert.equal(readKeyFile(file).key, "sk-abc123")
    })
  })

  it("skips comments and prose lines", () => {
    withFile("# DeepSeek key\n\nThis file holds the key used by the agent.\n\nsk-real-key-1\n", (file) => {
      assert.equal(readKeyFile(file).key, "sk-real-key-1")
    })
  })

  it("returns an error when there is no key-shaped line", () => {
    withFile("# only prose here\n", (file) => {
      const result = readKeyFile(file)
      assert.equal(result.key, "")
      assert.match(result.error!, /no API key found/)
    })
  })
})

describe("parseModel", () => {
  it("splits provider and model, keeping slashes in the model id", () => {
    assert.deepEqual(parseModel("deepseek/deepseek-v4-pro"), {
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
    })
    assert.deepEqual(parseModel("openrouter/meta/llama-3/70b"), {
      providerID: "openrouter",
      modelID: "meta/llama-3/70b",
    })
  })

  it("rejects malformed model strings", () => {
    assert.throws(() => parseModel("deepseek"))
    assert.throws(() => parseModel("/model"))
    assert.throws(() => parseModel("provider/"))
  })
})

describe("validateRequirementsContent", () => {
  it("accepts a real requirement", () => {
    // Note: the 20 char minimum counts characters, so it bites sooner for CJK
    // text than for English. A full CJK spec is comfortably above it.
    const requirement =
      "做一个扫雷游戏的复刻原型，使用HTML/CSS/JS在单个网页中运行，" +
      "支持初级、中级、高级三种难度。"
    assert.equal(validateRequirementsContent(requirement).ok, true)
  })

  it("accepts the README example unchanged", () => {
    const readme =
      "有图形交互界面的专门算斐波那契数列的计算程序。\n\n输入：第几个数\n输入：确认计算的按键\n输出：结果"
    assert.equal(validateRequirementsContent(readme).ok, true)
  })

  it("rejects a short but plausible CJK one-liner", () => {
    assert.equal(validateRequirementsContent("做一个扫雷游戏，支持三种难度。").ok, false)
  })

  it("rejects empty content", () => {
    assert.equal(validateRequirementsContent("   \n  ").ok, false)
  })

  it("rejects content below the minimum length", () => {
    assert.equal(validateRequirementsContent("太短了").ok, false)
  })

  it("rejects the exact boundary from below", () => {
    assert.equal(validateRequirementsContent("a".repeat(19)).ok, false)
    assert.equal(validateRequirementsContent("a".repeat(20)).ok, true)
  })
})
