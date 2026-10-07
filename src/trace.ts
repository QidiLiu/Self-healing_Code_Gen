import * as fs from "fs"
import * as path from "path"
import { AgentConfig } from "./types.js"

/**
 * Appends raw agent activity to state/trace.md.
 *
 * state/log.md records what the harness decided (which phase, what prompt).
 * This records what the agent actually did: tool calls, files written, provider
 * retries. Without it a failed run can only be diagnosed as "the evaluator said
 * no", which is not enough to fix anything.
 *
 * Enabled with --trace. Off by default because it can grow large on long runs.
 */
export interface TraceOptions {
  stateDir: string
  role: string
}

export function traceEnabled(): boolean {
  return process.env.AGENT_TRACE === "1"
}

export function createTraceSink(options: TraceOptions): (line: string) => void {
  const tracePath = path.join(options.stateDir, "trace.md")

  return (line: string) => {
    try {
      if (!fs.existsSync(tracePath)) {
        fs.writeFileSync(tracePath, `# Agent trace\n\n`, "utf-8")
      }
      fs.appendFileSync(
        tracePath,
        `${new Date().toISOString()} [${options.role}]${line}\n`,
        "utf-8",
      )
    } catch {
      // Tracing must never break the loop.
    }
  }
}

/**
 * Test seam: the default trace sink is a no-op unless AGENT_TRACE=1.
 */
export function traceSinkFor(config: AgentConfig, role: string): (line: string) => void {
  if (!traceEnabled()) return () => {}
  return createTraceSink({ stateDir: config.stateDir, role })
}

export function resetTrace(stateDir: string): void {
  const tracePath = path.join(stateDir, "trace.md")
  try {
    if (fs.existsSync(tracePath)) fs.unlinkSync(tracePath)
  } catch {
    // ignore
  }
}

export function traceSummary(stateDir: string): { lines: number; bytes: number } | null {
  const tracePath = path.join(stateDir, "trace.md")
  if (!fs.existsSync(tracePath)) return null

  try {
    const content = fs.readFileSync(tracePath, "utf-8")
    return { lines: content.split("\n").length - 1, bytes: content.length }
  } catch {
    return null
  }
}


