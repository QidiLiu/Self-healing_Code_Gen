import { execFile } from "child_process"
import { AgentReport, AgentPhase, EvaluationFailure } from "./types.js"
import * as fs from "fs"
import * as path from "path"

const AGENTLY_CLI = "agently-cli"
const SUBJECT_PREFIX = "[SelfHealing-Agent]"

export type AgentlyCliStatus = "ready" | "not-installed" | "unauthorized"

export interface ParsedReply {
  type: "modify" | "add" | "delete"
  keyword: string
  content: string
}

export async function checkAgentlyCli(): Promise<AgentlyCliStatus> {
  try {
    await execAgently(["auth", "status"])
    return "ready"
  } catch (err: unknown) {
    const msg = extractErrorMessage(err)
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      return "not-installed"
    }
    return "unauthorized"
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function sendTerminalNotification(
  state: "done" | "stuck",
  report: AgentReport,
  recipient: string,
  runId: string,
): Promise<void> {
  const subject = `${SUBJECT_PREFIX}/${runId}] ${state === "done" ? "SUCCESS" : "STUCK"}`
  let body = ""

  body += `状态: ${state === "done" ? "完成" : "卡住"}\n`
  body += `阶段: ${report.phase}\n`
  body += `合约: ${report.contractItems.passed}/${report.contractItems.total} 通过\n\n`

  body += `--- 摘要 ---\n${report.summary}\n\n`

  if (report.failures.length > 0) {
    body += `--- 失败详情 ---\n`
    for (const f of report.failures) {
      body += `[${f.severity}] ${f.itemId}: ${f.description}\n`
      body += `  ${f.errorDetail}\n\n`
    }
  }

  if (report.blockingIssue) {
    body += `阻塞问题: ${report.blockingIssue}\n\n`
  }

  body += `---\n`
  body += `回复此邮件并说明如何调整需求，系统将根据指令继续运行。\n`
  body += `指令格式:\n`
  body += `修改需求: <关键词>\n新内容: <替换内容>\n---\n新增需求:\n<新内容>\n---\n删除需求: <关键词>\n`

  await sendEmail(recipient, subject, body)
}

export async function sendProgressReport(
  phase: AgentPhase,
  contractTotal: number,
  passed: number,
  failed: number,
  failures: EvaluationFailure[],
  recipient: string,
  runId: string,
  elapsedMinutes: number,
): Promise<void> {
  const subject = `${SUBJECT_PREFIX}/${runId}] 进度报告 - ${phase.toUpperCase()}`
  let body = ""

  body += `运行阶段: ${phase}\n`
  body += `已运行: ${elapsedMinutes} 分钟\n`
  body += `合约进度: ${passed}/${contractTotal} 通过, ${failed} 失败\n\n`

  body += `--- 摘要 ---\n`
  body += `系统正在运行中，当前阶段: ${phase}\n`

  if (failures.length > 0) {
    body += `\n--- 失败详情 ---\n`
    for (const f of failures.slice(0, 10)) {
      body += `[${f.severity}] ${f.itemId}: ${f.description}\n`
      body += `  ${f.errorDetail}\n\n`
    }
    if (failures.length > 10) {
      body += `... 还有 ${failures.length - 10} 个失败\n`
    }
  }

  body += `\n---\n`
  body += `仪表盘: http://localhost:4097\n`

  await sendEmail(recipient, subject, body)
}

export async function pollForReply(
  runId: string,
  pollIntervalMs: number = 30000,
  signal?: AbortSignal,
): Promise<string | null> {
  let attemptCount = 0
  const replyFilePath = path.join(process.cwd(), "state", "reply.json")

  function checkReplyFile(): string | null {
    try {
      if (fs.existsSync(replyFilePath)) {
        const raw = fs.readFileSync(replyFilePath, "utf-8")
        const parsed = safeJsonParse(raw)
        const body: string = parsed?.body || ""
        fs.unlinkSync(replyFilePath)
        if (body) {
          console.log(`  [POLL #${attemptCount}] Reply found in state/reply.json (source: ${parsed?.source || "unknown"})`)
          return body
        }
      }
    } catch {
      // If file read fails, continue
    }
    return null
  }

  while (!signal?.aborted) {
    attemptCount++

    const fileReply = checkReplyFile()
    if (fileReply) return fileReply
    try {
      const stdout = await execAgently(["message", "+list", "--dir", "inbox", "--limit", "50"])
      const list = safeJsonParse(stdout)

      const messages = Array.isArray(list?.data?.data) ? list.data.data :
        Array.isArray(list?.data) ? list.data :
        Array.isArray(list?.messages) ? list.messages :
        Array.isArray(list) ? list : []

      console.log(`  [POLL #${attemptCount}] Fetched ${messages.length} messages from inbox`)

      for (const msg of messages) {
        const subject: string = msg.subject || msg.Subject || ""
        if (subject.includes(runId)) {
          console.log(`  [POLL #${attemptCount}] Match found! Subject: "${subject.slice(0, 80)}"`)
          const id: string = msg.id || msg.Id || msg.message_id || msg.messageId || ""
          if (!id) {
            console.log("  [POLL #${attemptCount}] No message ID, skipping")
            continue
          }

          const readStdout = await execAgently(["message", "+read", "--id", id])
          const readData = safeJsonParse(readStdout)
          const body: string = readData?.data?.body || readData?.body || readData?.data?.Body || ""
          if (body) {
            console.log(`  [POLL #${attemptCount}] Reply body (${body.length} chars): ${body.slice(0, 100)}...`)
            return body
          }
          console.log("  [POLL #${attemptCount}] Empty body, skipping")
        }
      }

      if (attemptCount === 1 || attemptCount % 5 === 0) {
        const subjects = messages.map((m: { subject?: string; Subject?: string }) =>
          (m.subject || m.Subject || "(no subject)").slice(0, 60)
        )
        console.log(`  [POLL #${attemptCount}] Recent subjects: ${subjects.join(" | ")}`)
      }
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err)
      console.log(`  [POLL #${attemptCount}] Error: ${msg.slice(0, 200)}`)
    }

    const lateReply = checkReplyFile()
    if (lateReply) return lateReply

    await sleep(Math.min(pollIntervalMs, 30000))
  }

  return null
}

export function parseReplyInstructions(body: string): ParsedReply[] {
  const instructions: ParsedReply[] = []

  const plainText = htmlToPlainText(body)

  const cleanBody = plainText
    .replace(/^>.*$/gm, "")
    .replace(/^On .* wrote:.*$/gm, "")
    .replace(/^在\s+.*\s+写道[：:].*$/gm, "")
    .trim()

  const blocks = cleanBody.split(/\n?---\n?/)

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue

    const modifyMatch = trimmed.match(/^修改需求\s*[:：]\s*(.+)/m)
    if (modifyMatch) {
      const newContentMatch = trimmed.match(/\n新内容\s*[:：]\s*([\s\S]+)/m)
      instructions.push({
        type: "modify",
        keyword: modifyMatch[1].trim(),
        content: newContentMatch ? newContentMatch[1].trim() : "",
      })
      continue
    }

    const addMatch = trimmed.match(/^新增需求\s*[:：]?\s*([\s\S]+)/m)
    if (addMatch) {
      instructions.push({
        type: "add",
        keyword: "",
        content: addMatch[1].trim(),
      })
      continue
    }

    const deleteMatch = trimmed.match(/^删除需求\s*[:：]\s*(.+)/m)
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

export function applyReplyInstructions(
  instructions: ParsedReply[],
  reqPath: string,
): void {
  if (!fs.existsSync(reqPath)) return

  let content = fs.readFileSync(reqPath, "utf-8")

  for (const instr of instructions) {
    const timestamp = new Date().toISOString()

    switch (instr.type) {
      case "modify": {
        const escaped = escapeRegex(instr.keyword)
        const keywordLineRegex = new RegExp(`^.*${escaped}.*$`, "m")
        const match = content.match(keywordLineRegex)
        if (match) {
          const idx = match.index!
          let blockStart = content.lastIndexOf("\n\n", idx - 1)
          if (blockStart === -1) blockStart = content.lastIndexOf("\n", idx - 1)
          if (blockStart === -1) blockStart = 0
          else blockStart += 1

          let blockEnd = content.indexOf("\n\n", idx + match[0].length)
          if (blockEnd === -1) blockEnd = content.length

          const before = content.substring(0, blockStart)
          const after = content.substring(blockEnd)
          const prefix = before.endsWith("\n") ? "" : "\n"
          content = `${before}${prefix}${instr.content}${after}`
        }
        break
      }

      case "add": {
        content += `\n\n---\n[Email 指令 ${timestamp}]\n${instr.content}\n`
        break
      }

      case "delete": {
        const escaped = escapeRegex(instr.keyword)
        const regex = new RegExp(`^[\\s\\S]*?${escaped}[\\s\\S]*?$`, "m")
        content = content.replace(regex, "")
        // Clean up double newlines
        content = content.replace(/\n{3,}/g, "\n\n")
        break
      }
    }
  }

  fs.writeFileSync(reqPath, content.trim() + "\n")
}

export function generateRunId(): string {
  return Date.now().toString(36)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function execAgently(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(AGENTLY_CLI, args, {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const raw = (error as { code?: unknown }).code
        const exitCode = typeof raw === "number" ? raw : -1
        const output = stdout + stderr
        reject(new AgentlyError(exitCode, output, error.message))
        return
      }
      resolve(stdout)
    })
  })
}

class AgentlyError extends Error {
  exitCode: number
  output: string

  constructor(exitCode: number, output: string, message: string) {
    super(message)
    this.exitCode = exitCode
    this.output = output
  }
}

async function sendEmail(to: string, subject: string, body: string, retried = false): Promise<void> {
  const bodyFile = `.shag-email-body-${Date.now()}.txt`
  const bodyPath = path.join(process.cwd(), bodyFile)
  fs.writeFileSync(bodyPath, body, "utf-8")

  function cleanup(): void {
    try { fs.unlinkSync(bodyPath) } catch {}
  }

  let ctk: string | null = null

  async function obtainCtk(): Promise<{ token: string | null; alreadySent: boolean }> {
    let exitCode = 0
    let output = ""

    try {
      output = await execAgently([
        "message", "+send",
        "--to", to,
        "--subject", subject,
        "--body-file", bodyFile,
      ])
    } catch (err: unknown) {
      if (err instanceof AgentlyError && err.exitCode === 8) {
        exitCode = 8
        output = err.output
      } else {
        throw err
      }
    }

    const token = extractConfirmationToken(output)
    console.log(`  [EMAIL DEBUG] Step 1 exit=${exitCode}, token=${token || "NONE"}`)

    if (!token) {
      return { token: null, alreadySent: true }
    }

    const parsed = safeJsonParse(output)
    if (parsed?.data?.confirmation_required === true) {
      return { token, alreadySent: false }
    }

    return { token: null, alreadySent: true }
  }

  async function sendWithToken(): Promise<void> {
    const token = ctk!
    console.log(`  [EMAIL DEBUG] Step 2 using token: ${token}`)
    await execAgently([
      "message", "+send",
      "--to", to,
      "--subject", subject,
      "--body-file", bodyFile,
      "--confirmation-token", token,
    ])
  }

  const result = await obtainCtk()

  if (result.alreadySent) {
    console.log("  [EMAIL DEBUG] Email sent directly (no confirmation needed)")
    cleanup()
    return
  }

  ctk = result.token

  if (!ctk) {
    cleanup()
    throw new Error("Failed to obtain confirmation token from agently-cli")
  }

  try {
    await sendWithToken()
    console.log("  [EMAIL DEBUG] Email sent with confirmation")
  } catch (err: unknown) {
    if (err instanceof AgentlyError) {
      const expired = err.exitCode === 6 &&
        err.output.includes("expired or invalid") &&
        !retried

      if (expired) {
        console.log("  [EMAIL DEBUG] Token expired, retrying with new token...")
        cleanup()
        await sendEmail(to, subject, body, true)
        return
      }

      const msg = `agently-cli exited with code ${err.exitCode}. Output: ${err.output.slice(0, 500)}`
      throw new Error(msg)
    }
    throw err
  } finally {
    cleanup()
  }
}

function extractConfirmationToken(output: string): string | null {
  const jsonBlock = extractJsonBlock(output)
  if (jsonBlock) {
    const parsed = safeJsonParse(jsonBlock)
    if (parsed?.data?.confirmation_token) {
      return parsed.data.confirmation_token
    }
  }
  const match = output.match(/ctk_[^\s"'}\]]+/)
  return match ? match[0] : null
}

function extractJsonBlock(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.substring(start, i + 1)
    }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function htmlToPlainText(html: string): string {
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
