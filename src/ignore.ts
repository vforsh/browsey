export type IgnoreMatcher = (name: string) => boolean

export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  if (patterns.length === 0) {
    return () => false
  }

  const globs = patterns.map((pattern) => new Bun.Glob(pattern))
  return (name: string) => globs.some((glob) => glob.match(name))
}

export function parseIgnorePatterns(input: string | undefined): string[] {
  if (!input) {
    return []
  }
  return input
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}
