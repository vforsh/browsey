import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { ancestorsUpTo, normalizeDir } from './agents.js'
import { findGitRoot } from './git.js'
import type { AgentId, AgentSkill, AgentSkillSource, AgentSkillsResponse } from '@vforsh/browsey-shared'

/**
 * Where each CLI looks for skills, relative to a home or project directory.
 * `.agents/skills` is the cross-agent location both tools read, so it appears
 * for both; the agent's own folder is listed first and wins a name clash.
 */
const SKILL_DIRS: Record<AgentId, string[]> = {
  'claude-code': ['.claude/skills', '.agents/skills'],
  codex: ['.codex/skills', '.agents/skills'],
}

const SKILL_FILE = 'SKILL.md'

/**
 * Skills the agent would see when launched for `targetDir`: project skills from
 * the directory up to its git root, nearest first, then the global ones from
 * the home directory. The first skill seen under a name wins, which is how a
 * project overrides a global skill of the same name — the same precedence the
 * CLIs apply.
 *
 * Without a target only global skills are listed. `home` is a test seam.
 */
export async function listAgentSkills(
  agent: AgentId,
  targetDir: string | null,
  home: string = homedir()
): Promise<AgentSkillsResponse> {
  const roots: { dir: string; source: AgentSkillSource }[] = []

  // Real path, because git reports the root through resolved symlinks and the
  // walk-up window is computed by comparing the two.
  const cwd = targetDir ? normalizeDir(await fs.realpath(targetDir)) : null
  if (cwd) {
    const gitRoot = await findGitRoot(cwd)
    const window = gitRoot ? ancestorsUpTo(cwd, normalizeDir(gitRoot)) : [cwd]
    for (const dir of window) roots.push({ dir, source: 'project' })
  }
  roots.push({ dir: normalizeDir(home), source: 'global' })

  const seen = new Set<string>()
  const skills: AgentSkill[] = []
  for (const root of roots) {
    for (const relativeDir of SKILL_DIRS[agent]) {
      for (const skill of await readSkillDir(join(root.dir, relativeDir), root.source)) {
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        skills.push(skill)
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { agent, cwd, skills }
}

/**
 * Every `<dir>/<skill>/SKILL.md` under one skills directory. Entries are read
 * through symlinks on purpose: `npx skills` installs skills as links into a
 * shared library, and a link to nowhere is simply skipped.
 */
async function readSkillDir(dir: string, source: AgentSkillSource): Promise<AgentSkill[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // Most candidate directories do not exist; that is the normal case.
    return []
  }

  const skills = await Promise.all(
    entries.map(async (entry): Promise<AgentSkill | null> => {
      const skillDir = join(dir, entry)
      let contents: string
      try {
        contents = await fs.readFile(join(skillDir, SKILL_FILE), 'utf-8')
      } catch {
        return null
      }
      const frontmatter = parseFrontmatter(contents)
      return {
        name: frontmatter.name ?? basename(skillDir),
        description: frontmatter.description ?? '',
        source,
        path: skillDir,
      }
    })
  )

  return skills.filter((skill): skill is AgentSkill => skill !== null)
}

/**
 * The two frontmatter keys a skill listing needs. Deliberately not a YAML
 * parser: skill frontmatter is flat `key: value` lines in practice, and a
 * folded multi-line description reads well enough from its first line. Values
 * may be quoted; the quotes are dropped.
 */
export function parseFrontmatter(contents: string): { name?: string; description?: string } {
  const lines = contents.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}

  const result: { name?: string; description?: string } = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = /^(name|description):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as 'name' | 'description'
    const value = unquote(match[2]?.trim() ?? '')
    if (value && !(key in result)) result[key] = value
  }
  return result
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? (quoted[2] ?? '') : value
}

/** The directory a skill lookup starts from for a launch target. */
export function skillLookupDir(absPath: string, isDirectory: boolean): string {
  return isDirectory ? absPath : dirname(absPath)
}
