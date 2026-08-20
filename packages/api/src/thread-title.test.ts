import { describe, expect, test } from 'bun:test'
import { MAX_TITLE_CHARS, promptTitle } from './thread-title.js'

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
