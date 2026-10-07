import { ValidationResult } from "./types.js"

export const MIN_REQUIREMENTS_CHARS = 20

/**
 * Requirements are stored as blocks separated by a line containing only `---`.
 * Every block-level edit (add / modify / delete) operates on this list, never on
 * raw text, so an edit can never bleed across neighbouring blocks.
 */
const BLOCK_SEPARATOR = /\n[ \t]*---[ \t]*\n/

export function validateRequirementsContent(text: string): ValidationResult {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "Requirements content is empty.",
    }
  }

  if (trimmed.length < MIN_REQUIREMENTS_CHARS) {
    return {
      ok: false,
      error:
        `Requirements too vague (only ${trimmed.length} chars, minimum ${MIN_REQUIREMENTS_CHARS}). ` +
        "Describe what to build, its inputs and its outputs.",
    }
  }

  return { ok: true }
}

export function splitBlocks(text: string): string[] {
  return text
    .split(BLOCK_SEPARATOR)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
}

export function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n---\n\n").trim() + "\n"
}

export function splitKeywords(keyword: string): string[] {
  return keyword
    .split(/[、,，;；\n]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

export function findBlockIndexes(blocks: string[], keyword: string): number[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []

  const hits: number[] = []
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].toLowerCase().includes(needle)) hits.push(i)
  }
  return hits
}
