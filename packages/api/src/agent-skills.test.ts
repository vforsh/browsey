import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listAgentSkills, parseFrontmatter } from './agent-skills.js'

const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

async function writeSkill(root: string, relativeDir: string, folder: string, frontmatter: string) {
  const dir = join(root, relativeDir, folder)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })))
})

describe('parseFrontmatter', () => {
  test('reads name and description, dropping quotes', () => {
    expect(
      parseFrontmatter('---\nname: "imagegen"\ndescription: \'Makes images.\'\nother: x\n---\n# Title')
    ).toEqual({ name: 'imagegen', description: 'Makes images.' })
  })

  test('returns nothing without a frontmatter block', () => {
    expect(parseFrontmatter('# Just a heading\nname: not-frontmatter')).toEqual({})
  })

  test('keeps the first line of a folded description', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: First line\n  continued\n---')).toEqual({
      name: 'a',
      description: 'First line',
    })
  })
})

describe('listAgentSkills', () => {
  test('lists global skills from the agent folder and the shared one, sorted', async () => {
    const home = await tempDir('browsey-skills-home-')
    await writeSkill(home, '.claude/skills', 'zeta', 'name: zeta\ndescription: Z')
    await writeSkill(home, '.agents/skills', 'alpha', 'name: alpha\ndescription: A')
    await writeSkill(home, '.codex/skills', 'codex-only', 'name: codex-only')

    const response = await listAgentSkills('claude-code', null, home)

    expect(response.cwd).toBeNull()
    expect(response.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ['alpha', 'global'],
      ['zeta', 'global'],
    ])
  })

  test('falls back to the folder name when frontmatter names nothing', async () => {
    const home = await tempDir('browsey-skills-home-')
    await writeSkill(home, '.codex/skills', 'folder-name', 'description: only')

    const { skills } = await listAgentSkills('codex', null, home)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('folder-name')
    expect(skills[0]?.description).toBe('only')
  })

  test('project skills come from the target up to the git root and shadow global ones', async () => {
    const home = await tempDir('browsey-skills-home-')
    const repo = await tempDir('browsey-skills-repo-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const nested = join(repo, 'packages', 'app')
    await fs.mkdir(nested, { recursive: true })

    await writeSkill(home, '.claude/skills', 'deploy', 'name: deploy\ndescription: global')
    await writeSkill(repo, '.claude/skills', 'deploy', 'name: deploy\ndescription: repo')
    await writeSkill(nested, '.claude/skills', 'local', 'name: local\ndescription: nested')
    // A skill above the git root is out of the walk-up window.
    await writeSkill(join(repo, '..'), '.claude/skills', 'above', 'name: above')

    const response = await listAgentSkills('claude-code', nested, home)

    expect(response.cwd).toBe(await fs.realpath(nested))
    expect(response.skills.map((skill) => [skill.name, skill.source, skill.description])).toEqual([
      ['deploy', 'project', 'repo'],
      ['local', 'project', 'nested'],
    ])
    await fs.rm(join(repo, '..', '.claude'), { recursive: true, force: true })
  })

  test('a folder without SKILL.md is not a skill', async () => {
    const home = await tempDir('browsey-skills-home-')
    await fs.mkdir(join(home, '.claude/skills/empty'), { recursive: true })

    const { skills } = await listAgentSkills('claude-code', null, home)
    expect(skills).toEqual([])
  })
})
