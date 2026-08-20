/**
 * What a launched thread is called. Both agents take their title from the same
 * place — the message the user typed — and both end up with one a model wrote,
 * so the rules for getting from one to the other live here rather than in either
 * agent's own module.
 *
 * They differ only in when they can afford it. Codex can rename a thread over
 * the protocol, so it launches on the prompt slice and swaps in the generated
 * title seconds later (`codex-thread-title.ts`). A Claude session's name is
 * fixed at spawn, so generation has to happen first and the launch waits on it
 * (`claude-thread-title.ts`) — with the slice as the fallback when it doesn't
 * come back.
 */

export const MAX_TITLE_CHARS = 60
/** Titles come from the opening of the prompt; the rest cannot change them. */
export const PROMPT_SLICE_CHARS = 4_000

export const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Cuts on a word boundary when there is a reasonable one, so a title does not
 * end mid-identifier.
 */
export function truncateTitle(text: string): string {
  if (text.length <= MAX_TITLE_CHARS) return text
  const cut = text.slice(0, MAX_TITLE_CHARS - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > MAX_TITLE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * The prompt itself as a title, flattened to one line. Null when the prompt
 * cannot yield one — a session launched with no instructions, or a prompt that
 * is nothing but the leading dashes stripped below.
 *
 * Those dashes matter: a title is passed to a CLI as an argument, and one that
 * opens with `-` would be read as a flag instead ("-v is broken" → unknown
 * option). Stripping them is what makes any prompt safe to title with.
 */
export function promptTitle(prompt: string): string | null {
  const flattened = collapseWhitespace(prompt.slice(0, PROMPT_SLICE_CHARS)).replace(/^-+\s*/, '')
  return flattened.length === 0 ? null : truncateTitle(flattened)
}

/**
 * What to ask a model for. Shared so that a thread reads the same in the Codex
 * app as it does in Claude's, having been titled by two different models.
 */
export function generationPrompt(prompt: string): string {
  return [
    'Write a short title for a coding assistant thread that opens with the message below.',
    '',
    'Rules:',
    '- 3 to 8 words, at most 60 characters.',
    '- Title Case. No quotes, no trailing punctuation, no file extensions.',
    '- Name the task, not the message: "Fix Tab Bar Overlap", not "Request About A File".',
    '- If the message defers the real instructions to a later one, title it from whatever',
    '  file, directory or excerpt it does carry.',
    '- Answer in English even when the message is in another language.',
    '',
    'Message:',
    '<<<',
    prompt.slice(0, PROMPT_SLICE_CHARS),
    '>>>',
  ].join('\n')
}

/**
 * Guards against a model that ignores the length rule, answers with quotes, or —
 * where the answer is plain text rather than schema-shaped — pads it with a line
 * of preamble. Null when nothing usable is left.
 */
export function sanitizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = collapseWhitespace(raw).replace(/^["'`]+|["'`.]+$/g, '')
  return cleaned.length === 0 ? null : truncateTitle(cleaned)
}
