import { startOpencode, restartOpencode, preflightProvider, OpencodeContext, describeError } from "./opencode.js"
import { loadConfig } from "./config.js"
import { runAgentLoop } from "./loop.js"
import { printReport } from "./reporter.js"
import {
  ensureDir,
  initState,
  clearSessionIds,
  createEmptyCheckpoint,
  saveCheckpoint,
  resetUsage,
  loadUsage,
} from "./state.js"
import { startDashboard, DashboardServer } from "./dashboard.js"
import {
  waitForReply,
  parseReplyInstructions,
  applyReplyInstructions,
  generateRunId,
} from "./reply.js"
import { validateRequirementsContent } from "./requirements.js"
import { AgentReport, AgentConfig } from "./types.js"
import * as fs from "fs"
import * as path from "path"
import * as readline from "readline"

let shutdownRequested = false
const shutdownController = new AbortController()

function gracefulShutdown(dashboard: DashboardServer | undefined, context: OpencodeContext | undefined): void {
  if (shutdownRequested) return
  console.log("\nShutting down...")
  shutdownRequested = true
  shutdownController.abort()
  if (dashboard) {
    try { dashboard.close() } catch {}
  }
  if (context) {
    try { context.server.close() } catch {}
  }
}

function resetCheckpointForRestart(stateDir: string): void {
  saveCheckpoint(stateDir, createEmptyCheckpoint())
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
      console.log("  [CLI] No input received, still waiting...")
      return
    }
    const payload = {
      body,
      source: "cli",
      timestamp: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(replyPath, JSON.stringify(payload, null, 2), "utf-8")
      console.log("  [CLI] Reply saved, processing...")
    } catch (err: unknown) {
      console.log(`  [WARN] Could not write reply file: ${describeError(err)}`)
    }
  })

  return () => {
    done = true
    try { rl.close() } catch {}
  }
}

interface ParsedArgs {
  help?: boolean
  once?: boolean
  requirements?: string
  workspace?: string
  stateDir?: string
  outputDir?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  keyFile?: string
  baseUrl?: string
  serverPort?: string
  maxRetries?: string
  maxReplans?: string
  maxInfraErrors?: string
  maxTotalIterations?: string
  servePort?: string
}

const KNOWN_FLAGS = new Set([
  "help", "h", "once",
  "requirements", "workspace", "stateDir", "outputDir",
  "model", "apiKey", "apiKeyEnv", "keyFile", "baseUrl", "serverPort",
  "maxRetries", "maxReplans", "maxInfraErrors", "maxTotalIterations",
  "servePort",
])

const KNOWN_SWITCHES = new Set(["help", "h", "once"])

export function parseArgs(argv: string[]): { args: ParsedArgs; unknown: string[] } {
  const args: ParsedArgs = {}
  const unknown: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith("--")) continue

    const key = token.substring(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

    if (!KNOWN_FLAGS.has(key)) {
      unknown.push(token)
      continue
    }

    if (KNOWN_SWITCHES.has(key)) {
      args.help = args.help || key === "help" || key === "h"
      args.once = args.once || key === "once"
      continue
    }

    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      unknown.push(`${token} (missing value)`)
      continue
    }

    ;(args as Record<string, unknown>)[key] = next
    i++
  }

  return { args, unknown }
}

function parseIntArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    console.error(`ERROR: expected an integer, got "${value}"`)
    process.exit(1)
  }
  return parsed
}

function printHelp(): void {
  console.log(`
Self-Healing Autonomous Agent System
====================================

Usage:
  npm start -- [options]
  node dist/main.js [options]

Options:
  --requirements <path>      Path to requirements file (default: requirements/current.md)
  --workspace <path>         Path to workspace directory (default: workspace/)
  --state-dir <path>         Path to state directory (default: state/)
  --output-dir <path>        Path to output directory (default: output/)
  --model <provider/model>   Model to use (default: deepseek/deepseek-v4-pro)
  --api-key <key>            API key for the provider
  --api-key-env <NAME>       Environment variable to read the API key from
  --key-file <path>          File containing the API key (default: doc/DEEPSEEK_KEY.md)
  --base-url <url>           Custom base URL for the provider API
  --server-port <n>          opencode server port (default: 4096)
  --max-retries <n>          Max fix retries before replan (default: 4)
  --max-replans <n>          Max replans before giving up (default: 2)
  --max-infra-errors <n>     Consecutive provider failures before giving up (default: 3)
  --max-total-iterations <n> Hard loop iteration cap (default: derived from retries/replans)
  --serve-port <n>           Dashboard port (default: 4097)
  --once                     Run one cycle, print the report and exit with 0/1
  --help, -h                 Show this help

API key resolution order:
  --api-key, --api-key-env, meta/config.ini [model] api_key,
  <PROVIDER>_API_KEY env var, --key-file / doc/DEEPSEEK_KEY.md

Configuration:
  Edit meta/config.ini to configure the model, thresholds and ports.

Examples:
  npm start
  npm start -- --requirements ./my-requirements.md
  npm start -- --model openai/gpt-4o
  npm start -- --once
`)
}

async function main(): Promise<number> {
  const { args, unknown } = parseArgs(process.argv.slice(2))

  if (unknown.length > 0) {
    console.error(`ERROR: unknown or malformed option(s): ${unknown.join(", ")}`)
    console.error("Run with --help to see the supported options.\n")
    return 1
  }

  if (args.help) {
    printHelp()
    return 0
  }

  let config: AgentConfig
  try {
    config = loadConfig({
      requirements: args.requirements,
      workspace: args.workspace,
      stateDir: args.stateDir,
      outputDir: args.outputDir,
      model: args.model,
      apiKey: args.apiKey,
      apiKeyEnv: args.apiKeyEnv,
      keyFile: args.keyFile,
      baseUrl: args.baseUrl,
      serverPort: parseIntArg(args.serverPort),
      maxRetries: parseIntArg(args.maxRetries),
      maxReplans: parseIntArg(args.maxReplans),
      maxInfraErrors: parseIntArg(args.maxInfraErrors),
      maxTotalIterations: parseIntArg(args.maxTotalIterations),
    })
  } catch (err: unknown) {
    console.error(`ERROR: ${describeError(err)}`)
    return 1
  }

  if (!config.apiKey) {
    console.error("ERROR: No API key available.\n")
    console.error("Checked, in order:")
    console.error("  1. --api-key")
    console.error("  2. --api-key-env <NAME>")
    console.error("  3. meta/config.ini [model] api_key")
    console.error(`  4. $${config.model.split("/")[0].toUpperCase()}_API_KEY`)
    console.error(`  5. ${path.join(config.rootDir, "doc", "DEEPSEEK_KEY.md")}`)
    if (config.apiKeyError) {
      console.error(`\nLast problem: ${config.apiKeyError}`)
    }
    return 1
  }

  ensureDir(config.stateDir)
  ensureDir(config.workspacePath)
  ensureDir(config.outputDir)

  initState(config.stateDir)

  if (!fs.existsSync(config.requirementsPath)) {
    console.error(`ERROR: Requirements file not found: ${config.requirementsPath}`)
    return 1
  }

  const requirements = fs.readFileSync(config.requirementsPath, "utf-8")
  const validation = validateRequirementsContent(requirements)
  if (!validation.ok) {
    console.error(`ERROR: ${validation.error}`)
    console.error("")
    console.error("Current requirements:")
    console.error(requirements.trim())
    console.error("")
    console.error("See doc/REQUIREMENTS_EXAMPLE.md for a minimal valid example.")
    return 1
  }

  console.log(`\nRequirements loaded (${requirements.trim().length} chars)`)
  console.log(`API key source: ${config.apiKeySource}`)
  console.log(`Model: ${config.model}`)
  console.log(`Limits: retries=${config.maxRetries} replans=${config.maxReplans} ` +
    `infraErrors=${config.maxInfraErrors} iterations<=${config.maxTotalIterations}\n`)

  const once = args.once === true
  const dashboard = startDashboard(config, args.servePort ? parseIntArg(args.servePort)! : 4097)

  let context: OpencodeContext | undefined
  let exitCode = 0
  let lastReport: AgentReport | undefined

  process.on("SIGINT", () => gracefulShutdown(dashboard, context))
  process.on("SIGTERM", () => gracefulShutdown(dashboard, context))

  async function runWithContext(ctx: OpencodeContext["client"], initialRunId: string): Promise<AgentReport | undefined> {
    let runId = initialRunId
    let lastReportFromRun: AgentReport | undefined

    for (;;) {
      if (shutdownRequested) break

      lastReportFromRun = await runAgentLoop(ctx, config)
      printReport(lastReportFromRun)

      if (lastReportFromRun.success) {
        console.log(`\nImplementation files are in: ${config.workspacePath}`)
        exitCode = 0
      } else {
        console.log("\nThe agent is stuck. Review the report above.")
        exitCode = 1
      }

      const usage = loadUsage(config.stateDir)
      console.log(
        `\nCost so far: ${usage.requests} requests, ${usage.cost.toFixed(4)}, ` +
        `tokens in/out ${usage.input}/${usage.output}`,
      )

      if (once) break

      console.log("  Waiting for reply (CLI or Web dashboard)...")

      const cleanupCli = promptCliReply(config.stateDir, shutdownController.signal)
      const reply = await waitForReply(config.stateDir, shutdownController.signal)
      cleanupCli()

      if (shutdownRequested) break

      if (!reply) break

      const instructions = parseReplyInstructions(reply)
      if (instructions.length === 0) {
        console.log("  [INFO] Reply contained no recognized instructions. Nothing was changed.")
        break
      }

      const result = applyReplyInstructions(
        instructions,
        config.requirementsPath,
        path.join(config.stateDir, "requirements.bak.md"),
      )

      if (!result.ok) {
        console.error(`  [ERROR] ${result.error}`)
        console.error("  Requirements unchanged. Please fix the instruction and resubmit.")
        break
      }

      resetCheckpointForRestart(config.stateDir)
      resetUsage(config.stateDir)
      console.log(
        `\n[REPLY] Applied ${result.changed} change(s). Restarting loop with updated requirements...`,
      )

      runId = generateRunId()
      void runId
    }

    return lastReportFromRun
  }

  const MAX_SERVER_RESTARTS = 2
  let restartCount = 0
  let recovered = false

  try {
    console.log("Starting opencode server...")
    context = await startOpencode(config, config.workspacePath)
    console.log(`Server running at: ${context.server.url}\n`)

    const preflight = await preflightProvider(context.client, config)
    if (preflight.warning) {
      console.log(`  [WARN] ${preflight.warning}`)
    }
    if (!preflight.ok) {
      console.error(`\nFATAL ERROR: ${preflight.error}`)
      if (preflight.hint) console.error(preflight.hint)
      gracefulShutdown(dashboard, context)
      return 1
    }
    console.log("  [OK] Provider preflight passed\n")

    const runId = generateRunId()
    lastReport = await runWithContext(context.client, runId)
    recovered = true
  } catch (err: unknown) {
    const errMsg = describeError(err)
    const isNetworkErr =
      /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket hang up|EADDRINUSE/i.test(errMsg)

    if (!isNetworkErr) {
      console.error("\nFATAL ERROR:", errMsg)
      if (err instanceof Error && err.stack) console.error(err.stack)
      gracefulShutdown(dashboard, context)
      return 1
    }

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

        const preflight = await preflightProvider(context.client, config)
        if (!preflight.ok) {
          console.error(`\nFATAL ERROR after restart: ${preflight.error}`)
          if (preflight.hint) console.error(preflight.hint)
          gracefulShutdown(dashboard, context)
          return 1
        }

        const runId = generateRunId()
        lastReport = await runWithContext(context.client, runId)
        recovered = true
        break
      } catch (retryErr: unknown) {
        const retryMsg = describeError(retryErr)
        if (restartCount >= MAX_SERVER_RESTARTS) {
          console.error(`\nFATAL ERROR after ${MAX_SERVER_RESTARTS} restart attempts:`, retryMsg)
          if (retryErr instanceof Error && retryErr.stack) console.error(retryErr.stack)
          gracefulShutdown(dashboard, context)
          return 1
        }
      }
    }
  }

  if (!recovered) {
    console.error("\nFATAL ERROR: could not start the agent loop.")
    gracefulShutdown(dashboard, context)
    return 1
  }

  if (shutdownRequested) {
    gracefulShutdown(dashboard, context)
    return 130
  }

  if (once || lastReport === undefined) {
    console.log(`\nReport: ${path.join(config.outputDir, "report.md")}`)
    gracefulShutdown(dashboard, context)
    return exitCode
  }

  console.log(`\nDashboard running at ${dashboard.url}`)
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
  return exitCode
}

main()
  .then((code) => {
    // Give sockets and the opencode child process a moment to close cleanly.
    // The timer must keep the event loop alive, otherwise node exits with 0
    // before it fires.
    setTimeout(() => process.exit(code), 150)
  })
  .catch((err: unknown) => {
    console.error("Unhandled error:", describeError(err))
    if (err instanceof Error && err.stack) console.error(err.stack)
    process.exit(3)
  })
