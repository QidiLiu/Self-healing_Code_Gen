import * as fs from "fs"
import * as path from "path"

export interface ParseResult<T> {
  data: T | null
  error: string | null
  rawText: string
}

export function parseLLMJson<T>(text: string): ParseResult<T> {
  const rawText = text
  let jsonStr = text.trim()

  jsonStr = stripMarkdownFences(jsonStr)
  jsonStr = extractJsonObject(jsonStr)

  if (!jsonStr) {
    return { data: null, error: "No JSON object found in response", rawText }
  }

  let lastError: string | null = null

  const attempts: { name: string; fn: () => T }[] = [
    { name: "direct", fn: () => JSON.parse(jsonStr) as T },
    {
      name: "fix_keys_and_commas",
      fn: () => JSON.parse(fixUnquotedKeys(fixTrailingCommas(jsonStr))) as T,
    },
    { name: "fix_escaped_backticks", fn: () => JSON.parse(jsonStr.replace(/\\`/g, "`")) as T },
    {
      name: "fix_newlines",
      fn: () => JSON.parse(fixUnescapedControlCharsInStrings(jsonStr)) as T,
    },
    {
      name: "fix_newlines_keys",
      fn: () =>
        JSON.parse(
          fixUnescapedControlCharsInStrings(fixUnquotedKeys(fixTrailingCommas(jsonStr))),
        ) as T,
    },
    {
      name: "try_json_repair",
      fn: () => tryJsonRepair<T>(jsonStr),
    },
  ]

  for (const attempt of attempts) {
    try {
      const result = attempt.fn()
      return { data: result, error: null, rawText }
    } catch (e) {
      lastError = `${attempt.name}: ${(e as Error).message}`
    }
  }

  return { data: null, error: lastError || "Unknown parse error", rawText }
}

/**
 * Only a leading and a trailing fence are removed. Stripping every fence would
 * corrupt string values that legitimately contain ``` (e.g. an assertion that
 * asks for an ```html``` file).
 */
function stripMarkdownFences(text: string): string {
  let result = text.trim()
  result = result.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "")
  result = result.replace(/```[ \t]*$/, "")
  return result.trim()
}

/**
 * Returns the first balanced top-level JSON object.
 *
 * Brace counting must be string-aware: contract assertions and error details
 * routinely contain { } characters, and naive counting truncates the object and
 * makes every repair strategy operate on a fragment.
 */
function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  if (start === -1) return ""

  let depth = 0
  let inString = false

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]

    if (inString) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return trimmed.slice(start, i + 1)
    }
  }

  // Unbalanced output (truncated response). Hand the tail to the repair passes.
  return trimmed.slice(start)
}

function fixUnquotedKeys(jsonStr: string): string {
  return jsonStr.replace(
    /(['"])?([a-zA-Z_][a-zA-Z0-9_-]*)(['"])?\s*:/g,
    (_match, _q1, key, _q2) => `"${key}":`,
  )
}

function fixTrailingCommas(jsonStr: string): string {
  return jsonStr.replace(/,\s*([}\]])/g, "$1")
}

/**
 * Replaces raw control characters that appear inside JSON string literals with
 * their escape sequences. Raw newlines inside a string are the single most
 * common reason a multi-line LLM JSON response fails to parse.
 */
function fixUnescapedControlCharsInStrings(jsonStr: string): string {
  const result: string[] = []
  let inString = false

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i]

    if (ch === '"' && jsonStr[i - 1] !== "\\") {
      inString = !inString
      result.push(ch)
      continue
    }

    if (inString) {
      if (ch === "\n") { result.push("\\n"); continue }
      if (ch === "\r") { result.push("\\r"); continue }
      if (ch === "\t") { result.push("\\t"); continue }
    }

    result.push(ch)
  }

  return result.join("")
}

function tryJsonRepair<T>(jsonStr: string): T {
  const repaired = jsonStr
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ':"$1"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, (ch) => {
      if (ch === "\n") return "\\n"
      if (ch === "\r") return "\\r"
      if (ch === "\t") return "\\t"
      return ""
    })

  return JSON.parse(repaired) as T
}

export function saveParseDebug(
  stateDir: string,
  parseResult: ParseResult<unknown>,
  label: string,
): void {
  if (!parseResult.rawText && !parseResult.error) return

  const dir = path.join(stateDir, "debug")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

  if (parseResult.rawText) {
    fs.writeFileSync(path.join(dir, `${label}_${timestamp}_raw.txt`), parseResult.rawText)
  }
  if (parseResult.error) {
    fs.writeFileSync(path.join(dir, `${label}_${timestamp}_error.txt`), parseResult.error)
  }
}
