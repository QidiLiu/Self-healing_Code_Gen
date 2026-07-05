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

  const attempts = [
    { name: "direct", fn: () => JSON.parse(jsonStr) as T },
    { name: "fix_keys_and_commas", fn: () => JSON.parse(fixUnquotedKeys(fixTrailingCommas(jsonStr))) as T },
    { name: "fix_escaped_backticks", fn: () => JSON.parse(jsonStr.replace(/\\`/g, "`")) as T },
    { name: "fix_unescaped_quotes", fn: () => JSON.parse(fixUnescapedQuotesInStrings(jsonStr)) as T },
    { name: "fix_newlines", fn: () => JSON.parse(fixUnescapedNewlinesInStrings(jsonStr)) as T },
    { name: "fix_newlines_keys", fn: () => JSON.parse(fixUnescapedNewlinesInStrings(fixUnquotedKeys(fixTrailingCommas(jsonStr)))) as T },
    { name: "fix_combined", fn: () => JSON.parse(fixUnescapedNewlinesInStrings(fixUnescapedQuotesInStrings(fixUnquotedKeys(fixTrailingCommas(jsonStr))))) as T },
    { name: "try_json_repair", fn: () => tryJsonRepair<T>(jsonStr) },
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

function stripMarkdownFences(text: string): string {
  let result = text

  result = result.replace(/```json\s*\n?/i, "")

  result = result.replace(/```[a-zA-Z]*\s*\n?/g, "")

  return result.trim()
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim()

  const firstBrace = trimmed.indexOf("{")
  if (firstBrace === -1) {
    const jsonLike = trimmed.match(/\{[\s\S]*\}/)
    return jsonLike ? jsonLike[0] : ""
  }

  let depth = 0
  let endIdx = -1
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }

  if (endIdx !== -1) {
    return trimmed.substring(firstBrace, endIdx + 1)
  }

  const jsonLike = trimmed.match(/\{[\s\S]*\}/)
  return jsonLike ? jsonLike[0] : trimmed.substring(firstBrace)
}

function fixUnquotedKeys(jsonStr: string): string {
  return jsonStr.replace(
    /(['"])?([a-zA-Z_][a-zA-Z0-9_-]*)(['"])?\s*:/g,
    (match, q1, key, q2) => {
      return `"${key}":`
    },
  )
}

function fixTrailingCommas(jsonStr: string): string {
  return jsonStr.replace(/,\s*([}\]])/g, "$1")
}

function fixUnescapedQuotesInStrings(jsonStr: string): string {
  const result: string[] = []
  let inString = false
  let i = 0

  while (i < jsonStr.length) {
    const ch = jsonStr[i]

    if (ch === '"' && (i === 0 || jsonStr[i - 1] !== "\\")) {
      inString = !inString
      result.push(ch)
      i++
      continue
    }

    if (inString && ch === '"') {
      result.push('\\"')
      i++
      continue
    }

    if (inString && ch === "\n") {
      result.push("\\n")
      i++
      continue
    }

    if (inString && ch === "\r") {
      result.push("\\r")
      i++
      continue
    }

    if (inString && ch === "\t") {
      result.push("\\t")
      i++
      continue
    }

    result.push(ch)
    i++
  }

  return result.join("")
}

function fixUnescapedNewlinesInStrings(jsonStr: string): string {
  const result: string[] = []
  let inString = false
  let i = 0

  while (i < jsonStr.length) {
    const ch = jsonStr[i]

    if (ch === '"' && (i === 0 || jsonStr[i - 1] !== "\\")) {
      inString = !inString
      result.push(ch)
      i++
      continue
    }

    if (inString && ch === "\n") {
      result.push("\\n")
      i++
      continue
    }

    if (inString && ch === "\r") {
      result.push("\\r")
      i++
      continue
    }

    result.push(ch)
    i++
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

export function saveParseDebug(stateDir: string, parseResult: ParseResult<unknown>, label: string): void {
  const dir = path.join(stateDir, "debug")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const rawPath = path.join(dir, `${label}_${timestamp}_raw.txt`)
  fs.writeFileSync(rawPath, parseResult.rawText)

  if (parseResult.error) {
    const errPath = path.join(dir, `${label}_${timestamp}_error.txt`)
    fs.writeFileSync(errPath, parseResult.error)
  }
}
