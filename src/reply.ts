import * as fs from "fs"
import * as path from "path"
import { ReplyPayload } from "./types.js"
import {
  findBlockIndexes,
  joinBlocks,
  splitBlocks,
  splitKeywords,
  validateRequirementsContent,
} from "./requirements.js"

export interface ParsedReply {
  type: "modify" | "add" | "delete"
  keyword: string
  content: string
}

export type ApplyResult = { ok: true; changed: number } | { ok: false; error: string }

const REPLY_FILE = "reply.json"
const REPLY_POLL_INTERVAL_MS = 1000

export function generateRunId(): string {
  return Date.now().toString(36)
}

/**
 * Instruction format (blocks separated by a line containing only `---`):
 *
 *   修改需求: <keyword>
 *   新内容: <full replacement text>
 *   ---
 *   新增需求:
 *   <text to append>
 *   ---
 *   删除需求: <keyword>
 *
 * Command keywords must start a line so they are never picked up from inside a
 * 新内容 body. Everything else is captured verbatim.
 */
export function parseReplyInstructions(body: string): ParsedReply[] {
  const instructions: ParsedReply[] = []

  const cleanBody = htmlToPlainText(body)
    .replace(/^>.*$/gm, "")
    .replace(/^On .* wrote:.*$/gm, "")
    .replace(/^在\s+.*\s+写道[：:].*$/gm, "")
    .trim()

  for (const rawBlock of cleanBody.split(/\n?---[ \t]*\n?/)) {
    const block = rawBlock.trim()
    if (!block) continue

    const modifyMatch = block.match(/^修改需求\s*[:：]\s*(.+)/m)
    if (modifyMatch) {
      const afterKeyword = block.slice(modifyMatch.index! + modifyMatch[0].length)
      const contentMatch = afterKeyword.match(/新内容\s*[:：]\s*([\s\S]*)/)
      instructions.push({
        type: "modify",
        keyword: modifyMatch[1].trim(),
        content: contentMatch ? contentMatch[1].trim() : "",
      })
      continue
    }

    const addMatch = block.match(/^新增需求\s*[:：]?[ \t]*([\s\S]+)/m)
    if (addMatch) {
      instructions.push({
        type: "add",
        keyword: "",
        content: addMatch[1].trim(),
      })
      continue
    }

    const deleteMatch = block.match(/^删除需求\s*[:：]\s*(.+)/m)
    if (deleteMatch) {
      instructions.push({
        type: "delete",
        keyword: deleteMatch[1].trim(),
        content: "",
      })
      continue
    }
  }

  return instructions
}

/**
 * Applies instructions to the requirements file as block-level operations.
 *
 * The whole batch is computed in memory and validated before a single byte is
 * written, so a rejected instruction (unknown keyword, empty replacement,
 * ambiguous keyword, result that would empty the file) leaves the file
 * untouched. On success the previous content is copied to `backupPath`.
 */
export function applyReplyInstructions(
  instructions: ParsedReply[],
  reqPath: string,
  backupPath?: string,
): ApplyResult {
  if (!fs.existsSync(reqPath)) {
    return { ok: false, error: `Requirements file not found: ${reqPath}` }
  }

  const original = fs.readFileSync(reqPath, "utf-8")
  let working = splitBlocks(original)

  if (working.length === 0) {
    return { ok: false, error: `${reqPath} has no content blocks.` }
  }

  let changed = 0

  for (const instr of instructions) {
    if (instr.type === "add") {
      const content = instr.content.trim()
      if (!content) {
        return { ok: false, error: 'Instruction "新增需求" is empty. Nothing was modified.' }
      }
      working.push(content)
      changed++
      continue
    }

    const keywords = splitKeywords(instr.keyword)
    if (keywords.length === 0) {
      return {
        ok: false,
        error: `Instruction "${instr.type}" has no keyword. Nothing was modified.`,
      }
    }

    const hits = new Set<number>()
    for (const kw of keywords) {
      for (const idx of findBlockIndexes(working, kw)) hits.add(idx)
    }

    if (hits.size === 0) {
      return {
        ok: false,
        error:
          `Keyword not found in requirements: ${keywords.map((k) => `"${k}"`).join(", ")}. ` +
          "Nothing was modified.",
      }
    }

    if (instr.type === "delete") {
      const removed = hits.size
      working = working.filter((_, index) => !hits.has(index))
      changed += removed
      continue
    }

    const content = instr.content.trim()
    if (!content) {
      return {
        ok: false,
        error:
          `Instruction "修改需求: ${instr.keyword}" has no 新内容 line. ` +
          "Nothing was modified.",
      }
    }

    if (hits.size > 1) {
      return {
        ok: false,
        error:
          `Keyword "${instr.keyword}" matches ${hits.size} blocks. ` +
          "修改需求 requires a keyword that identifies exactly one block. Nothing was modified.",
      }
    }

    working[[...hits][0]] = content
    changed++
  }

  const next = joinBlocks(working)
  const validation = validateRequirementsContent(next)
  if (!validation.ok) {
    return {
      ok: false,
      error: `Rejected edit would leave invalid requirements: ${validation.error} Nothing was modified.`,
    }
  }

  if (next === original) {
    return { ok: true, changed: 0 }
  }

  if (backupPath) {
    try {
      fs.writeFileSync(backupPath, original, "utf-8")
    } catch {
      // A missing backup must not block a valid edit.
    }
  }

  fs.writeFileSync(reqPath, next, "utf-8")
  return { ok: true, changed }
}

export function readReplyPayload(replyPath: string): ReplyPayload | null {
  try {
    if (!fs.existsSync(replyPath)) return null
    const parsed = JSON.parse(fs.readFileSync(replyPath, "utf-8")) as Partial<ReplyPayload>
    return {
      body: typeof parsed.body === "string" ? parsed.body : "",
      source: parsed.source === "web" ? "web" : "cli",
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    }
  } catch {
    return null
  }
}

function consumeReply(replyPath: string): { body: string; source: string } | null {
  const payload = readReplyPayload(replyPath)
  if (!payload) return null

  // The file is consumed either way: keeping an empty payload would spin forever.
  try {
    fs.unlinkSync(replyPath)
  } catch {
    // ignore
  }

  const body = payload.body.trim()
  if (!body) return null

  return { body, source: payload.source }
}

/**
 * Waits for a reply written by the CLI prompt or the dashboard into
 * `<stateDir>/reply.json`. Event driven via fs.watch, with a 1s polling fallback.
 * Resolves with the reply body, or null once `signal` aborts (shutdown).
 */
export function waitForReply(
  stateDir: string,
  signal: AbortSignal,
  pollIntervalMs: number = REPLY_POLL_INTERVAL_MS,
): Promise<string | null> {
  const replyPath = path.join(stateDir, REPLY_FILE)

  return new Promise<string | null>((resolve) => {
    let settled = false
    let watcher: fs.FSWatcher | undefined

    const timer = setInterval(() => {
      const reply = consumeReply(replyPath)
      if (reply) {
        console.log(`  [REPLY] Received reply (source: ${reply.source})`)
        finish(reply.body)
      }
    }, pollIntervalMs)

    function finish(value: string | null): void {
      if (settled) return
      settled = true
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
        // ignore
      }
      signal.removeEventListener("abort", onAbort)
      resolve(value)
    }

    function onAbort(): void {
      finish(null)
    }

    try {
      watcher = fs.watch(stateDir, (_event, filename) => {
        if (filename && filename !== REPLY_FILE) return
        const reply = consumeReply(replyPath)
        if (reply) {
          console.log(`  [REPLY] Received reply (source: ${reply.source})`)
          finish(reply.body)
        }
      })
      watcher.on("error", () => {
        try {
          watcher?.close()
        } catch {
          // ignore
        }
        watcher = undefined
      })
    } catch {
      watcher = undefined
    }

    if (signal.aborted) {
      finish(null)
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<\/p>/gi, "")
    .replace(/<div[^>]*>/gi, "\n")
    .replace(/<\/div>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
}
