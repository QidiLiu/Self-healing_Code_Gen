import { startOpencode, restartOpencode, OpencodeContext } from "./opencode.js"
import { loadConfig } from "./config.js"
import { runAgentLoop } from "./loop.js"
import { printReport } from "./reporter.js"
import { ensureDir, initState, clearSessionIds } from "./state.js"
import { startDashboard, DashboardServer } from "./dashboard.js"
import * as fs from "fs"

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
  let exitCode = 0
  let context: OpencodeContext | undefined
  let dashboard: DashboardServer | undefined
  let restartCount = 0

  const port = args.servePort ? parseInt(args.servePort, 10) : 4097
  dashboard = startDashboard(config, port)

  async function runWithContext(ctx: OpencodeContext): Promise<number> {
    const report = await runAgentLoop(ctx.client, config)
    printReport(report)

    if (report.success) {
      console.log("\nImplementation files are in: " + config.workspacePath)
      return 0
    } else {
      console.log("\nThe agent is stuck. Review the report above and:")
      console.log("  1. Fix the requirements or provide additional info")
      console.log("  2. Run again to resume from the checkpoint")
      return 1
    }
  }

  try {
    console.log("Starting opencode server...")
    context = await startOpencode(config, config.workspacePath)
    console.log(`Server running at: ${context.server.url}\n`)

    exitCode = await runWithContext(context)
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
      exitCode = 2
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
          exitCode = await runWithContext(context)
          break
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message || String(retryErr)
          if (restartCount >= MAX_SERVER_RESTARTS) {
            console.error(`\nFATAL ERROR after ${MAX_SERVER_RESTARTS} restart attempts:`, retryMsg)
            console.error((retryErr as Error).stack)
            exitCode = 2
          }
        }
      }

      if (restartCount >= MAX_SERVER_RESTARTS && exitCode !== 0) {
        console.error("\nFATAL ERROR: Max server restarts exhausted.")
        exitCode = exitCode || 2
      }
    }
  } finally {
    if (dashboard) {
      dashboard.close()
    }
    if (context) {
      context.server.close()
    }
  }

  process.exit(exitCode)
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
