import type { OpencodeClient } from "./opencode.js"

export type AgentPhase =
  | "idle"
  | "planning"
  | "generating"
  | "evaluating"
  | "fixing"
  | "replanning"
  | "done"
  | "stuck"

export type RoleName = "planner" | "generator" | "evaluator"

/**
 * A role bound to its opencode session.
 *
 * `sessionId` is mutable because a replan needs a fresh planner session: keeping
 * the old one would leave the previous plan in context and anchor the model into
 * reproducing it.
 */
export interface RoleSpec {
  name: RoleName
  client: OpencodeClient
  sessionId: string
  newSession: (title: string) => Promise<string>
}

export interface Checkpoint {
  phase: AgentPhase
  retries: number
  replanCount: number
  /** Total number of state-machine iterations, used as a hard budget guard. */
  iterations: number
  /** Consecutive infrastructure failures (provider/network). Not retried against the code. */
  infraErrors: number
  /** Consecutive malformed LLM outputs. */
  parseErrors: number
  errors: string[]
  lastError: string | null
  plannerSessionId: string | null
  generatorSessionId: string | null
  evaluatorSessionId: string | null
  updatedAt: string
}

export interface ContractItem {
  id: string
  description: string
  category: "ui" | "logic" | "validation" | "integration" | "testing"
  status: "pending" | "in_progress" | "passed" | "failed"
  testableAssertion: string
}

export interface Contract {
  overview: string
  items: ContractItem[]
  createdAt: string
  updatedAt: string
}

export interface EvaluationResult {
  phase: "evaluation"
  allPass: boolean
  passedCount: number
  failedCount: number
  totalCount: number
  failures: EvaluationFailure[]
  summary: string
}

export interface EvaluationFailure {
  itemId: string
  description: string
  errorDetail: string
  severity: "critical" | "high" | "medium" | "low"
}

export interface LogEntry {
  timestamp: string
  phase: AgentPhase
  role: "system" | "planner" | "generator" | "evaluator"
  action: string
  detail: string
}

export interface ErrorEntry {
  timestamp: string
  role: string
  kind: "parse" | "infra" | "llm"
  message: string
  hint?: string
}

export interface AgentReport {
  success: boolean
  phase: AgentPhase
  contractItems: { total: number; passed: number; failed: number }
  failures: EvaluationFailure[]
  summary: string
  blockingIssue: string | null
  suggestions: string[]
  logPath: string
}

export interface ReplyPayload {
  body: string
  source: "cli" | "web"
  timestamp: string
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

export interface AgentConfig {
  /** Project root used to locate doc/ and dashboard/ regardless of process.cwd(). */
  rootDir: string
  requirementsPath: string
  workspacePath: string
  stateDir: string
  outputDir: string
  model: string
  apiKey: string
  /** Where the API key came from, for logging only. Never the value itself. */
  apiKeySource: string
  /** Why key resolution failed, if it did. */
  apiKeyError: string | null
  baseUrl: string | null
  maxRetries: number
  maxReplans: number
  maxInfraErrors: number
  maxTotalIterations: number
}
