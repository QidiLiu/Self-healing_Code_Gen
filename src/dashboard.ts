import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { AgentConfig, ReplyPayload } from "./types.js"

const POLL_INTERVAL_MS = 2000

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  "venv",
  ".venv",
])

const MAX_LIST_DEPTH = 6
const MAX_LIST_FILES = 500

function readJsonFile(filePath: string): object | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
}

/**
 * Bounded, symlink-free listing. Symlinks are skipped because entry.isFile()
 * and entry.isDirectory() are both false for them, and a workspace may contain
 * symlinks pointing anywhere on the host.
 */
function listWorkspaceFiles(dir: string, depth = 0, prefix = ""): string[] {
  if (depth > MAX_LIST_DEPTH) return []

  let result: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (result.length >= MAX_LIST_FILES) break
      if (SKIP_DIRS.has(entry.name)) continue

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        result = result.concat(listWorkspaceFiles(path.join(dir, entry.name), depth + 1, relative))
      } else if (entry.isFile()) {
        result.push(relative)
      }
    }
  } catch {
    return []
  }

  return result.sort()
}

function jsonResponse(
  res: http.ServerResponse,
  data: object | null,
  status: number = 200,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  })
  res.end(JSON.stringify(data))
}

function textResponse(
  res: http.ServerResponse,
  text: string,
  status: number = 200,
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  })
  res.end(text)
}

function htmlResponse(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

export interface DashboardServer {
  url: string
  close(): void
}

const WORKSPACE_PREFIX = "/api/workspace/"

export function startDashboard(config: AgentConfig, port: number = 4097): DashboardServer {
  const stateDir = config.stateDir
  const workspacePath = config.workspacePath
  const workspaceRoot = path.resolve(workspacePath)
  const htmlPath = path.join(config.rootDir, "dashboard", "index.html")

  const server = http.createServer((req, res) => {
    // Strip the query string before routing; the raw req.url is not normalised.
    const pathname = (req.url || "/").split("?")[0]

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      })
      res.end()
      return
    }

    if (pathname === "/" || pathname === "/index.html") {
      const html = readTextFile(htmlPath)
      if (html) {
        htmlResponse(res, html)
      } else {
        htmlResponse(res, `<!DOCTYPE html><html><body><h1>Dashboard HTML not found at ${htmlPath}</h1></body></html>`)
      }
      return
    }

    if (pathname === "/api/checkpoint") {
      return jsonResponse(res, readJsonFile(path.join(stateDir, "checkpoint.json")))
    }

    if (pathname === "/api/contract") {
      return jsonResponse(res, readJsonFile(path.join(stateDir, "contract.json")))
    }

    if (pathname === "/api/evaluation") {
      return jsonResponse(res, readJsonFile(path.join(stateDir, "evaluation.json")))
    }

    if (pathname === "/api/usage") {
      return jsonResponse(res, readJsonFile(path.join(stateDir, "usage.json")))
    }

    if (pathname === "/api/progress") {
      const text = readTextFile(path.join(stateDir, "progress.md"))
      return textResponse(res, text || "")
    }

    if (pathname === "/api/log") {
      const text = readTextFile(path.join(stateDir, "log.md"))
      return textResponse(res, text || "")
    }

    if (pathname === "/api/config") {
      return jsonResponse(res, {
        model: config.model,
        maxRetries: config.maxRetries,
        maxReplans: config.maxReplans,
        maxInfraErrors: config.maxInfraErrors,
        maxTotalIterations: config.maxTotalIterations,
        requirementsPath: config.requirementsPath,
      })
    }

    if (pathname === "/api/workspace") {
      const files = listWorkspaceFiles(workspaceRoot)
      return jsonResponse(res, { files, pollIntervalMs: POLL_INTERVAL_MS })
    }

    if (pathname.startsWith(WORKSPACE_PREFIX)) {
      let requested: string
      try {
        requested = decodeURIComponent(pathname.slice(WORKSPACE_PREFIX.length))
      } catch {
        return jsonResponse(res, { error: "Bad path encoding" }, 400)
      }

      if (!requested || requested.includes("\0")) {
        return jsonResponse(res, { error: "Bad path" }, 400)
      }

      // Resolve then confirm containment. Without this, "/api/workspace/../../x"
      // reads any file the harness can read.
      const filePath = path.resolve(workspaceRoot, requested)
      if (filePath !== workspaceRoot && !filePath.startsWith(workspaceRoot + path.sep)) {
        return jsonResponse(res, { error: "Forbidden" }, 403)
      }

      const text = readTextFile(filePath)
      if (text !== null) {
        return textResponse(res, text)
      }
      return jsonResponse(res, { error: "File not found" }, 404)
    }

    if (pathname === "/api/reply-status") {
      const cp = readJsonFile(path.join(stateDir, "checkpoint.json")) as { phase?: string } | null
      const waiting = cp?.phase === "done" || cp?.phase === "stuck"
      return jsonResponse(res, { waiting })
    }

    if (pathname === "/api/reply" && req.method === "POST") {
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => {
        if (req.destroyed) return

        const raw = Buffer.concat(chunks).toString("utf-8")
        let body = ""
        try {
          const parsed = JSON.parse(raw) as Partial<ReplyPayload>
          body = String(parsed.body || "")
        } catch {
          body = raw.trim()
        }

        if (!body.trim()) {
          return jsonResponse(res, { ok: false, error: "empty body" }, 400)
        }

        const payload: ReplyPayload = {
          body,
          source: "web",
          timestamp: new Date().toISOString(),
        }
        fs.writeFileSync(path.join(stateDir, "reply.json"), JSON.stringify(payload, null, 2), "utf-8")
        return jsonResponse(res, { ok: true })
      })
      return
    }

    jsonResponse(res, { error: "Not found" }, 404)
  })

  // Loopback only. The dashboard exposes the workspace and accepts commands that
  // rewrite the requirements file, so it must not be reachable from the LAN.
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard server running at http://localhost:${port}`)
  })

  return {
    url: `http://localhost:${port}`,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
