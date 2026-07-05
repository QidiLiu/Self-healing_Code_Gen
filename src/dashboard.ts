import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { AgentConfig } from "./types.js"

const DASHBOARD_HTML_PATH = path.join(process.cwd(), "dashboard", "index.html")
const POLL_INTERVAL_MS = 2000

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

function listWorkspaceFiles(dir: string): string[] {
  try {
    const result: string[] = []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        result.push(...listWorkspaceFiles(fullPath).map((f) => path.join(entry.name, f)))
      } else {
        result.push(entry.name)
      }
    }
    return result.sort()
  } catch {
    return []
  }
}

function jsonResponse(
  res: http.ServerResponse,
  data: object | null,
  status: number = 200,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
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

export function startDashboard(config: AgentConfig, port: number = 4097): DashboardServer {
  const stateDir = config.stateDir
  const workspacePath = config.workspacePath

  const server = http.createServer((req, res) => {
    const url = req.url || "/"

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      })
      res.end()
      return
    }

    if (url === "/" || url === "/index.html") {
      const html = readTextFile(DASHBOARD_HTML_PATH)
      if (html) {
        htmlResponse(res, html)
      } else {
        htmlResponse(res, `<!DOCTYPE html><html><body><h1>Dashboard HTML not found at ${DASHBOARD_HTML_PATH}</h1></body></html>`)
      }
      return
    }

    if (url === "/api/checkpoint") {
      const data = readJsonFile(path.join(stateDir, "checkpoint.json"))
      return jsonResponse(res, data)
    }

    if (url === "/api/contract") {
      const data = readJsonFile(path.join(stateDir, "contract.json"))
      return jsonResponse(res, data)
    }

    if (url === "/api/evaluation") {
      const data = readJsonFile(path.join(stateDir, "evaluation.json"))
      return jsonResponse(res, data)
    }

    if (url === "/api/progress") {
      const text = readTextFile(path.join(stateDir, "progress.md"))
      return textResponse(res, text || "")
    }

    if (url === "/api/log") {
      const text = readTextFile(path.join(stateDir, "log.md"))
      return textResponse(res, text || "")
    }

    if (url === "/api/config") {
      return jsonResponse(res, {
        model: config.model,
        maxRetries: config.maxRetries,
        maxReplans: config.maxReplans,
        requirementsPath: config.requirementsPath,
      })
    }

    if (url === "/api/workspace") {
      const files = listWorkspaceFiles(workspacePath)
      return jsonResponse(res, { files })
    }

    if (url.startsWith("/api/workspace/")) {
      const filePath = path.join(workspacePath, url.replace("/api/workspace/", ""))
      const text = readTextFile(filePath)
      if (text !== null) {
        return textResponse(res, text)
      }
      return jsonResponse(res, { error: "File not found" }, 404)
    }

    jsonResponse(res, { error: "Not found" }, 404)
  })

  server.listen(port, () => {
    console.log(`Dashboard server running at http://localhost:${port}`)
  })

  return {
    url: `http://localhost:${port}`,
    close: () => server.close(),
  }
}
