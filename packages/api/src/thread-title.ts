/**
 * What a launched thread is called. Both agents take their title from the same
 * place — the message the user typed — so the rule for turning one into the
 * other lives here rather than in either agent's own module.
 *
 * Codex uses this as phase one of a two-phase title and replaces it with a
 * generated one seconds later (see `codex-thread-title.ts`). Claude cannot: its
 * session name is fixed at spawn, so this is the title, permanently.
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
