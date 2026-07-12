import { startOpencode, restartOpencode, OpencodeContext } from "./opencode.js"
import { OpencodeClient } from "@opencode-ai/sdk"
import { loadConfig } from "./config.js"
import { runAgentLoop, LoopOptions } from "./loop.js"
import { printReport } from "./reporter.js"
import { ensureDir, initState, clearSessionIds, createEmptyCheckpoint, saveCheckpoint } from "./state.js"
import { startDashboard, DashboardServer } from "./dashboard.js"
import {
  AgentlyCliStatus,
  checkAgentlyCli,
  sendTerminalNotification,
  sendProgressReport,
  pollForReply,
  parseReplyInstructions,
  applyReplyInstructions,
  generateRunId,
} from "./email.js"
import { Contract, EvaluationResult, AgentPhase } from "./types.js"
import * as fs from "fs"
import * as path from "path"
import * as readline from "readline"

let shutdownRequested = false
const shutdownController = new AbortController()

function gracefulShutdown(dashboard: DashboardServer | undefined, context: OpencodeContext | undefined): void {
  console.log("\nShutting down...")
  shutdownRequested = true
  shutdownController.abort()
  if (dashboard) {
    try { dashboard.close() } catch {}
  }
  if (context) {
    try { context.server.close() } catch {}
  }
  process.exit(0)
}

function resetCheckpointForRestart(stateDir: string): void {
  const cp = createEmptyCheckpoint()
  saveCheckpoint(stateDir, cp)
}

function promptCliReply(stateDir: string, signal: AbortSignal): () => void {
  const replyPath = path.join(stateDir, "reply.json")
  let done = false

  console.log("")
  console.log("══════════════════════════════════════════════════════")
  console.log("  You can also type reply instructions below.")
  console.log("  Format:  修改需求: <keyword>")
  console.log("           新增需求: <description>")
  console.log("           删除需求: <keyword>")
  console.log("  Separate blocks with --- on its own line.")
  console.log("  Press Enter twice to submit (empty line ends input).")
  console.log("══════════════════════════════════════════════════════")
  console.log("")

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const lines: string[] = []
  let emptyCount = 0

  const onAbort = (): void => {
    rl.close()
  }
  signal.addEventListener("abort", onAbort, { once: true })

  rl.on("line", (line: string) => {
    if (done || signal.aborted) return
    if (line.trim() === "") {
      emptyCount++
      if (emptyCount >= 2 || lines.length > 0) {
        rl.close()
      }
    } else {
      emptyCount = 0
      lines.push(line)
    }
  })

  rl.on("close", () => {
    signal.removeEventListener("abort", onAbort)
    if (done || signal.aborted) return
    const body = lines.join("\n").trim()
    if (!body) {
      console.log("  [CLI] No input received, continuing to wait for email...")
      return
    }
    const payload = {
      body,
      source: "cli",
      timestamp: new Date().toISOString(),
    }
    fs.writeFileSync(replyPath, JSON.stringify(payload, null, 2), "utf-8")
    console.log("  [CLI] Reply saved, processing...")
  })

  return () => {
    done = true
    try { rl.close() } catch {}
    try { fs.unlinkSync(replyPath) } catch {}
  }
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (args.help) {
    printHelp()
    return
  }

  const config = loadConfig({
    requirements: args.requirements,
    workspace: args.workspace,
    stateDir: args.stateDir,
    outputDir: args.outputDir,
    model: args.model,
    apiKey: args.apiKey,
    keyFile: args.keyFile,
    baseUrl: args.baseUrl,
    maxRetries: args.maxRetries ? parseInt(args.maxRetries, 10) : undefined,
    maxReplans: args.maxReplans ? parseInt(args.maxReplans, 10) : undefined,
  })

  if (!config.apiKey) {
    console.error(
      "ERROR: No API key provided. Set DEEPSEEK_API_KEY env var or provide --api-key or ensure doc/DEEPSEEK_KEY.md exists.",
    )
    process.exit(1)
  }

  ensureDir(config.stateDir)
  ensureDir(config.workspacePath)
  ensureDir(config.outputDir)

  initState(config.stateDir)

  if (!fs.existsSync(config.requirementsPath)) {
    console.error(`ERROR: Requirements file not found: ${config.requirementsPath}`)
    process.exit(1)
  }

  const requirements = fs.readFileSync(config.requirementsPath, "utf-8")
  if (!validateRequirements(requirements)) {
    process.exit(1)
  }
  console.log(`\nRequirements loaded (${requirements.trim().length} chars)\n`)
  console.log(`Model: ${config.model}`)
  console.log(`Max retries: ${config.maxRetries}, Max replans: ${config.maxReplans}\n`)

  const MAX_SERVER_RESTARTS = 2
  let context: OpencodeContext | undefined
  let dashboard: DashboardServer | undefined
  let restartCount = 0

  const port = args.servePort ? parseInt(args.servePort, 10) : 4097
  dashboard = startDashboard(config, port)

  process.on("SIGINT", () => gracefulShutdown(dashboard, context))
  process.on("SIGTERM", () => gracefulShutdown(dashboard, context))

  let emailStatus: AgentlyCliStatus = "not-installed"
  if (config.email.enabled) {
    console.log("Checking agently-cli for email notifications...")
    emailStatus = await checkAgentlyCli()
    if (emailStatus === "not-installed") {
      console.log("  [WARN] agently-cli is not installed. Email notifications disabled.")
      console.log("  [INFO] Install with: npm install -g @tencent-qqmail/agently-cli")
    } else if (emailStatus === "unauthorized") {
      console.log("  [WARN] agently-cli is not authorized. Email notifications disabled.")
      console.log("  [INFO] Authorize with: agently-cli auth login")
    } else {
      console.log("  [OK] agently-cli is ready for email notifications")
    }
    console.log("")
  }

  async function maybeSendProgress(
    phase: AgentPhase,
    contract: Contract | null,
    evaluation: EvaluationResult | null,
    loopStartTime: number,
    lastProgressTimeRef: { value: number },
    runId: string,
  ): Promise<void> {
    if (emailStatus !== "ready") return
    if (!config.email.recipient) return
    if (config.email.progressIntervalMinutes <= 0) return

    const elapsed = Date.now() - loopStartTime
    const intervalMs = config.email.progressIntervalMinutes * 60 * 1000

    if (elapsed < intervalMs) return
    if (Date.now() - lastProgressTimeRef.value < intervalMs) return

    lastProgressTimeRef.value = Date.now()

    try {
      await sendProgressReport(
        phase,
        contract?.items.length || 0,
        evaluation?.passedCount || 0,
        evaluation?.failedCount || 0,
        evaluation?.failures || [],
        config.email.recipient,
        runId,
        Math.floor(elapsed / 60000),
      )
      console.log(`  [EMAIL] Progress report sent (${Math.floor(elapsed / 60000)} min elapsed)`)
    } catch (err: unknown) {
      console.log(`  [WARN] Failed to send progress email: ${(err as Error).message || String(err)}`)
    }
  }

  async function runWithContext(ctx: OpencodeClient, initialRunId: string): Promise<void> {
    let runId = initialRunId
    let loopStartTime = Date.now()
    const lastProgressTimeRef = { value: 0 }
    let shouldContinue = true

    while (shouldContinue && !shutdownRequested) {
      const tickFn = (
        phase: AgentPhase,
        contract: Contract | null,
        evaluation: EvaluationResult | null,
      ) => {
        maybeSendProgress(phase, contract, evaluation, loopStartTime, lastProgressTimeRef, runId)
      }

      const loopOptions: LoopOptions = {
        onProgressTick: tickFn,
      }

      const report = await runAgentLoop(ctx, config, loopOptions)
      printReport(report)

      if (report.success) {
        console.log("\nImplementation files are in: " + config.workspacePath)
      } else {
        console.log("\nThe agent is stuck. Review the report above.")
      }

      const canEmail = emailStatus === "ready" && config.email.enabled && config.email.recipient

      const state = report.success ? "done" as const : "stuck" as const

      if (canEmail) {
        try {
          console.log(`\n[EMAIL] Sending ${state} notification to ${config.email.recipient}...`)
          await sendTerminalNotification(state, report, config.email.recipient, runId)
          console.log(`  [OK] Notification sent.`)
        } catch (err: unknown) {
          console.log(`  [WARN] Failed to send notification: ${(err as Error).message || String(err)}`)
        }
      }

      console.log(`  Waiting for reply (CLI, Web,${canEmail ? " or Email" : ""})...`)

      const cleanupCli = promptCliReply(config.stateDir, shutdownController.signal)

      const reply = await pollForReply(runId, 30000, shutdownController.signal)

      cleanupCli()

      if (reply && !shutdownRequested) {
        const instructions = parseReplyInstructions(reply)
        if (instructions.length > 0) {
          applyReplyInstructions(instructions, config.requirementsPath)
          resetCheckpointForRestart(config.stateDir)
          console.log(`\n[REPLY] Received instructions (${instructions.length}). Restarting loop with updated requirements...`)
          runId = generateRunId()
          loopStartTime = Date.now()
          lastProgressTimeRef.value = 0
          continue
        }
        console.log("  [INFO] Reply received but no recognized instructions found")
      }

      shouldContinue = false
    }
  }

  try {
    console.log("Starting opencode server...")
    context = await startOpencode(config, config.workspacePath)
    console.log(`Server running at: ${context.server.url}\n`)

    const runId = generateRunId()
    await runWithContext(context.client!, runId)
  } catch (err) {
    const errMsg = (err as Error).message || String(err)
    const isNetworkErr =
      errMsg.includes("fetch failed") ||
      errMsg.includes("ECONNREFUSED") ||
      errMsg.includes("ECONNRESET") ||
      errMsg.includes("network")

    if (!isNetworkErr) {
      console.error("\nFATAL ERROR:", errMsg)
      console.error((err as Error).stack)
    } else {
      while (restartCount < MAX_SERVER_RESTARTS) {
        restartCount++
        console.log(`\n[WARN] Server unreachable: ${errMsg}`)
        console.log(`[INFO] Restarting server (attempt ${restartCount}/${MAX_SERVER_RESTARTS})...\n`)

        if (context) {
          try { context.server.close() } catch {}
        }

        try {
          clearSessionIds(config.stateDir)
          context = await restartOpencode()
          console.log(`Server restarted at: ${context.server.url}\n`)
          const runId = generateRunId()
          await runWithContext(context.client!, runId)
          break
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message || String(retryErr)
          if (restartCount >= MAX_SERVER_RESTARTS) {
            console.error(`\nFATAL ERROR after ${MAX_SERVER_RESTARTS} restart attempts:`, retryMsg)
            console.error((retryErr as Error).stack)
          }
        }
      }
    }
  }

  console.log("Dashboard running at http://localhost:" + port)
  console.log("Press Ctrl+C to stop")

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (shutdownRequested) {
        clearInterval(check)
        resolve()
      }
    }, 500)
  })

  gracefulShutdown(dashboard, context)
}

function parseArgs(): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {}
  const raw = process.argv.slice(2)

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--help" || raw[i] === "-h") {
      args.help = "true"
      continue
    }

    if (raw[i].startsWith("--")) {
      const key = raw[i].substring(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (i + 1 < raw.length && !raw[i + 1].startsWith("--")) {
        args[key] = raw[i + 1]
        i++
      } else {
        args[key] = "true"
      }
    }
  }

  return args
}

function validateRequirements(requirements: string): boolean {
  const trimmed = requirements.trim()

  if (trimmed.length === 0) {
    console.error("ERROR: Requirements file is empty.")
    console.error("Please write a clear description of what you want to build.")
    console.error(`See doc/REQUIREMENTS_EXAMPLE.md for an example.`)
    return false
  }

  if (trimmed.length < 20) {
    console.error(`ERROR: Requirements too vague (only ${trimmed.length} chars).`)
    console.error("Please provide more detail. At minimum, describe:")
    console.error("  - What to build (e.g. 'a GUI calculator', 'a REST API server')")
    console.error("  - What inputs it takes")
    console.error("  - What outputs it produces")
    console.error("")
    console.error("Current requirements:")
    console.error(trimmed)
    console.error("")
    console.error(`See doc/REQUIREMENTS_EXAMPLE.md for a minimal valid example.`)
    return false
  }

  return true
}

function printHelp(): void {
  console.log(`
Self-Healing Autonomous Agent System
====================================

Usage:
  npm start -- [options]
  node dist/main.js [options]

Options:
  --requirements <path>    Path to requirements file (default: requirements/current.md)
  --workspace <path>       Path to workspace directory (default: workspace/)
  --state-dir <path>       Path to state directory (default: state/)
  --output-dir <path>      Path to output directory (default: output/)
  --model <provider/model> Model to use (default: deepseek/deepseek-v4-pro)
  --api-key <key>          API key for the provider
  --key-file <path>        Path to file containing API key (default: doc/DEEPSEEK_KEY.md)
  --base-url <url>         Custom base URL for the provider API
  --max-retries <n>        Max fix retries before replan (default: 4)
  --max-replans <n>        Max replans before giving up (default: 2)
  --serve-port <n>         Dashboard port (default: 4097)
  --help, -h               Show this help

Configuration:
  Edit meta/config.ini to configure model, email notifications, and thresholds.

Examples:
  npm start
  npm start -- --requirements ./my-requirements.md
  npm start -- --model openai/gpt-4o --api-key sk-xxx
`)
}

main().catch((err) => {
  console.error("Unhandled error:", err)
  process.exit(3)
})
