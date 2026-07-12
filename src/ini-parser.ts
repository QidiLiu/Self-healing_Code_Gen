import * as fs from "fs"

export type IniData = Record<string, Record<string, string>>

export function parseIniFile(filePath: string): IniData {
  const result: IniData = {}
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split("\n")

  let currentSection = ""

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue
    }

    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      if (!result[currentSection]) {
        result[currentSection] = {}
      }
      continue
    }

    const eqIndex = line.indexOf("=")
    if (eqIndex === -1) continue

    const key = line.substring(0, eqIndex).trim()
    let value = line.substring(eqIndex + 1).trim()

    const commentIdx = findCommentIndex(value)
    if (commentIdx !== -1) {
      value = value.substring(0, commentIdx).trim()
    }

    if (currentSection) {
      result[currentSection][key] = value
    }
  }

  return result
}

function findCommentIndex(value: string): number {
  let inQuote = false
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') inQuote = !inQuote
    if (!inQuote && (value[i] === "#" || value[i] === ";")) return i
  }
  return -1
}
