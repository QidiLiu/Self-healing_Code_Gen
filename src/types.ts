export type AgentPhase =
  | "idle"
  | "planning"
  | "generating"
  | "evaluating"
  | "fixing"
  | "replanning"
  | "done"
  | "stuck"

export interface Checkpoint {
  phase: AgentPhase
  retries: number
  replanCount: number
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

export interface AgentConfig {
  requirementsPath: string
  workspacePath: string
  stateDir: string
  outputDir: string
  model: string
  apiKey: string
  baseUrl: string | null
  maxRetries: number
  maxReplans: number
}
