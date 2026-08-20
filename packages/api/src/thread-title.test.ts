import { describe, expect, test } from 'bun:test'
import { MAX_TITLE_CHARS, promptTitle, sanitizeGeneratedTitle } from './thread-title.js'

describe('promptTitle', () => {
  test('uses the prompt as written when it already fits', () => {
    expect(promptTitle('Fix the tab bar overlap')).toBe('Fix the tab bar overlap')
  })

  test('flattens a multi-line prompt onto one line', () => {
    expect(promptTitle('Fix the crash\n\n  on   launch\t')).toBe('Fix the crash on launch')
  })

  test('truncates on a word boundary and marks the cut', () => {
    const title = promptTitle(
      'Fix the login redirect loop that happens after a user logs out on iOS'
    )
    expect(title).toBe('Fix the login redirect loop that happens after a user logs…')
    expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
  })

  test('cuts mid-word rather than throw away most of a title', () => {
    expect(promptTitle(`refactor ${'x'.repeat(80)}`)).toBe(
      `refactor ${'x'.repeat(MAX_TITLE_CHARS - 10)}…`
    )
  })

  test('keeps non-latin prompts intact', () => {
    expect(promptTitle('Проверь падение на старте')).toBe('Проверь падение на старте')
  })

  // A title is passed to a CLI as an argument, where a leading dash makes it a
  // flag instead — `claude --remote-control "-v is broken"` fails outright.
  test('strips leading dashes', () => {
    expect(promptTitle('-v is broken, fix it')).toBe('v is broken, fix it')
    expect(promptTitle('--force does nothing')).toBe('force does nothing')
    expect(promptTitle('- fix the header')).toBe('fix the header')
  })

  test('has nothing to offer for a prompt that is blank or all dashes', () => {
    expect(promptTitle('')).toBeNull()
    expect(promptTitle('   \n\t ')).toBeNull()
    expect(promptTitle('---')).toBeNull()
  })
})

describe('sanitizeGeneratedTitle', () => {
  // Claude answers on stdout, so the raw value arrives with a trailing newline.
  test('trims what a CLI adds around the answer', () => {
    expect(sanitizeGeneratedTitle('Fix Tab Bar Overlap\n')).toBe('Fix Tab Bar Overlap')
  })

  test('drops quoting and trailing punctuation the rules told it not to add', () => {
    expect(sanitizeGeneratedTitle('"Fix Tab Bar Overlap."')).toBe('Fix Tab Bar Overlap')
    expect(sanitizeGeneratedTitle('`Rename Session Titles`')).toBe('Rename Session Titles')
  })

  test('enforces the length rule the model was asked to follow', () => {
    const title = sanitizeGeneratedTitle('Investigate '.repeat(12))
    expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
    expect(title!.endsWith('…')).toBe(true)
  })

  test('rejects an answer that is not usable text', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull()
    expect(sanitizeGeneratedTitle('  \n ')).toBeNull()
    expect(sanitizeGeneratedTitle(undefined)).toBeNull()
    expect(sanitizeGeneratedTitle(42)).toBeNull()
  })
})
