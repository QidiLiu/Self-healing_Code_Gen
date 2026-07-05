import { AgentConfig, Checkpoint, Contract, EvaluationResult, AgentReport, AgentPhase } from "./types.js"
import * as fs from "fs"
import * as path from "path"

export function printProgress(phase: AgentPhase, message: string): void {
  const timestamp = new Date().toISOString().substring(11, 19)
  console.log(`[${timestamp}] [${phase.toUpperCase()}] ${message}`)
}

export function generateReport(
  checkpoint: Checkpoint,
  contract: Contract | undefined,
  evaluation: EvaluationResult | undefined,
  config: AgentConfig,
): AgentReport {
  const isSuccess = checkpoint.phase === "done"

  const failures = evaluation?.failures || []
  const contractItems = contract
    ? { total: contract.items.length, passed: evaluation?.passedCount || 0, failed: evaluation?.failedCount || 0 }
    : { total: 0, passed: 0, failed: 0 }

  let summary: string
  let blockingIssue: string | null = null
  let suggestions: string[] = []

  if (isSuccess) {
    summary = `Successfully implemented the requirements. All ${contractItems.total} contract items passed evaluation.`
  } else {
    summary = `Could not complete all requirements. ${contractItems.passed} of ${contractItems.total} items passed. ${contractItems.failed} failed after ${checkpoint.retries} retries and ${checkpoint.replanCount} replans.`

    if (failures.length > 0) {
      blockingIssue = failures
        .filter((f) => f.severity === "critical" || f.severity === "high")
        .map((f) => f.errorDetail)
        .join("; ")
    }

    suggestions = [
      "Review the evaluation failures in the state/evaluation.json file",
      "Check the contract in state/contract.md to see what was expected",
      "Check the log in state/log.md for detailed trace",
      "Fix the requirements or provide additional information and restart",
    ]
  }

  const report: AgentReport = {
    success: isSuccess,
    phase: checkpoint.phase,
    contractItems,
    failures,
    summary,
    blockingIssue,
    suggestions,
    logPath: path.join(config.stateDir, "log.md"),
  }

  saveReportFile(report, config)

  return report
}

function saveReportFile(report: AgentReport, config: AgentConfig): void {
  const reportDir = config.outputDir
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true })
  }

  let md = `# Agent Report\n\n`
  md += `**Status**: ${report.success ? "SUCCESS" : "STUCK"}\n`
  md += `**Phase**: ${report.phase}\n`
  md += `**Generated**: ${new Date().toISOString()}\n\n`

  md += `## Summary\n\n${report.summary}\n\n`

  if (report.blockingIssue) {
    md += `## Blocking Issue\n\n${report.blockingIssue}\n\n`
  }

  md += `## Contract Results\n\n`
  md += `| Total | Passed | Failed |\n`
  md += `|-------|--------|--------|\n`
  md += `| ${report.contractItems.total} | ${report.contractItems.passed} | ${report.contractItems.failed} |\n\n`

  if (report.failures.length > 0) {
    md += `## Failures\n\n`
    for (const f of report.failures) {
      md += `- **[${f.severity.toUpperCase()}] ${f.itemId}**: ${f.description}\n`
      md += `  ${f.errorDetail}\n\n`
    }
  }

  if (report.suggestions.length > 0) {
    md += `## Suggestions\n\n`
    for (const s of report.suggestions) {
      md += `- ${s}\n`
    }
    md += `\n`
  }

  md += `## Files\n\n`
  md += `- Contract: \`state/contract.md\`\n`
  md += `- Progress: \`state/progress.md\`\n`
  md += `- Log: \`${report.logPath}\`\n`

  fs.writeFileSync(path.join(reportDir, "report.md"), md)

  const jsonReport = {
    ...report,
    failures: report.failures,
  }
  fs.writeFileSync(
    path.join(reportDir, "report.json"),
    JSON.stringify(jsonReport, null, 2),
  )
}

export function printReport(report: AgentReport): void {
  console.log("\n" + "=".repeat(60))
  console.log(
    report.success
      ? "  STATUS: SUCCESS"
      : "  STATUS: STUCK",
  )
  console.log("=".repeat(60))
  console.log(`\n${report.summary}\n`)

  if (report.blockingIssue) {
    console.log(`Blocking Issue: ${report.blockingIssue}\n`)
  }

  console.log(
    `Contract: ${report.contractItems.passed}/${report.contractItems.total} passed`,
  )

  if (report.failures.length > 0) {
    console.log(`\nFailures (${report.failures.length}):`)
    for (const f of report.failures.slice(0, 5)) {
      console.log(`  [${f.severity}] ${f.itemId}: ${f.description}`)
    }
    if (report.failures.length > 5) {
      console.log(`  ... and ${report.failures.length - 5} more`)
    }
  }

  if (report.suggestions.length > 0) {
    console.log(`\nSuggestions:`)
    for (const s of report.suggestions) {
      console.log(`  - ${s}`)
    }
  }

  console.log(`\nFull report: output/report.md`)
  console.log(`Log: state/log.md`)
}
