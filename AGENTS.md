# AGENTS.md - AI Coding Agent Guidelines for Browsey

## Project Overview

**Browsey** is a mobile-friendly web file browser CLI tool built with Bun. It runs separate API and UI servers — the API serves file data and the app serves the frontend. Perfect for quickly accessing files on your computer from your phone or tablet.

## Tech Stack

- **Runtime**: Bun (v1.1.0+)
- **Language**: TypeScript (v5.7.0, strict mode)
- **CLI**: Commander.js
- **Frontend**: Vanilla JS/TS (no framework), highlight.js, marked.js
- **Styling**: Custom CSS with dark theme, mobile-first responsive design
- **Monorepo**: Bun workspaces with 4 packages

## Project Structure

```
browsey/
├── package.json              # Root workspace config
├── tsconfig.json             # Base TS config (composite)
├── scripts/
│   └── build.ts              # Build script (produces dist/browsey)
├── dist/
│   └── browsey               # Single built executable
└── packages/
    ├── shared/               # @vforsh/browsey-shared
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts      # Re-exports everything
    │       ├── types.ts      # TypeScript type definitions
    │       ├── security.ts   # Path traversal prevention
    │       ├── auth.ts       # Token generation/validation
    │       ├── ignore.ts     # File ignore pattern matching
    │       ├── cors.ts       # CORS headers & helpers
    │       └── utils/
    │           └── mime.ts   # MIME type mapping
    ├── api/                  # @vforsh/browsey-api
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts      # Exports startApiServer
    │       ├── server.ts     # API Bun server with CORS
    │       ├── routes.ts     # API route handlers
    │       ├── git.ts        # Git operations
│       ├── agents.ts      # Agent thread launch (capabilities, cwd resolution, spawn)
    │       └── live-reload.ts # SSE live reload
    ├── app/                  # @vforsh/browsey-app
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts      # Exports startAppServer
    │       ├── server.ts     # UI Bun server
    │       └── ui/
    │           ├── app.ts    # Frontend app
    │           ├── index.html # HTML template
    │           ├── styles.css # Dark theme CSS
    │           └── pwa/      # manifest + icons + screenshots
    └── cli/                  # @vforsh/browsey-cli
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── bin.ts        # CLI entry point
            ├── agent-token.ts # Persisted agent bearer token (~/.browsey/agent-token)
            └── registry.ts   # Instance tracking
```

## Development Commands

```bash
bun install          # Install workspace dependencies
bun run dev:api      # Dev mode API server (port 4200)
bun run dev:app      # Dev mode UI server (port 4201, connects to API)
bun run typecheck    # Type checking (all packages)
bun run build        # Build distribution executable
```

## CLI Cheatsheet

```bash
# Start both servers (API + App) in one command
browsey start [path]                  # alias: serve
browsey start -p 4200 --app-port 4201 --open

# Start servers individually
browsey api [path]                    # alias: service (default port 4200)
browsey app                           # alias: ui (default port 4201, API URL configured in browser)

# Manage instances
browsey list                          # alias: ls (--json for JSON output)
browsey stop [target]                 # alias: kill — target: PID, :port, or path
browsey stop --all                    # stop everything
browsey stop --force                  # SIGKILL

# Reload running instances (picks up code changes)
browsey api reload <target>           # target: PID, :port, or path
browsey app reload <target>           # alias: restart

# Pair the mobile app for agent threads (prints token + QR)
browsey pair [target]                 # --url <url>, --name <name>
```

### `browsey start` options
`-p/--port` (API, default 4200), `--app-port` (App, default 4201), `-h/--host` (default 0.0.0.0), `-i/--ignore`, `--no-readonly`, `--hidden`, `--no-qr`, `--https`, `--https-cert`, `--https-key`, `-w/--watch`, `--cors <origin>` (default `*`), `--no-agents`, `--agents-token <token>`, `--open`

### `browsey api` options
`-p/--port` (default 4200), `-h/--host` (default 0.0.0.0), `-i/--ignore`, `--no-readonly`, `--hidden`, `--no-qr`, `--https`, `--https-cert`, `--https-key`, `-w/--watch`, `--cors <origin>` (default `*`), `--no-agents`, `--agents-token <token>`

### `browsey app` options
`-p/--port` (default 4201), `-h/--host` (default 0.0.0.0), `--open`, `--https`, `--https-cert`, `--https-key`, `--no-qr`, `-w/--watch`

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Health check |
| `GET /api/list?path=/` | List directory contents |
| `GET /api/file?path=/file.txt` | Download file |
| `GET /api/view?path=/file.txt` | View file in browser |
| `GET /api/stat?path=/file.txt` | Get file metadata |
| `GET /api/search?path=/&q=term` | Fuzzy file search |
| `POST /api/save` | Save an existing text file; requires read-write mode and `baseModified`/`baseSize` conflict guards |
| `GET /api/git?path=/` | Git repository status |
| `GET /api/git/log?path=/` | Git commit history |
| `GET /api/git/changes?path=/` | Git file changes |
| `GET /api/git/commit?path=/&hash=<sha>` | Git commit details, stats, navigation, and changed files (`includeAdjacent=0` skips navigation lookup) |
| `POST /api/git/revert` | Discard changes for one git file |
| `GET /api/reload` | SSE live reload (watch mode) |
| `GET /api/agents` | Agent capabilities (installed CLIs + curated model lists) — **bearer token required** |
| `POST /api/agents/launch` | Launch a detached Codex / Claude Code thread — **bearer token required** |

## Key Patterns

### Architecture
- **Separate processes**: API and UI always run as separate servers
- **CORS**: API server wraps all responses with CORS headers (default origin: `*`)
- **API base URL**: Injected at serve time via `window.__BROWSEY_API_BASE__` in HTML
- **Cross-package imports**: Use package names (`@vforsh/browsey-shared`); intra-package use relative paths
- **Build process**: Frontend bundled as IIFE, inlined into server as constants via `define`

### Security
- **Path traversal prevention**: All paths go through `resolveSafePath()` in shared package
- **Constant-time token comparison** in `auth.ts`
- **Readonly mode by default** - modifications require `--no-readonly` flag
- **Text saves use conflict guards** - clients must pass the `modified` and `size` values from `/api/view` as `baseModified`/`baseSize`
- **Null byte filtering** in path handling

### Agent Threads

`/api/agents/*` launches headless Codex / Claude Code runs on this machine. Fire-and-forget:
Browsey spawns a detached process and responds immediately; results are picked up later via
`claude --resume <session-id>` / `codex resume`.

- **Enabled by default**, disabled with `--no-agents`. Every route needs a bearer token
  (`Authorization: Bearer …` or `?token=`), compared in constant time via `auth.ts`.
- **Token** lives at `~/.browsey/agent-token` (mode `0600`), generated once and reused across
  restarts. `browsey pair` prints it plus a QR code whose payload is **JSON, not a URL**, so a
  stray camera scan cannot leak the token into browser history.
- **`readonly` does not gate agent routes.** `--no-readonly` protects Browsey's own file
  mutations; agents are gated by `--no-agents` + the token. Keep these independent.
- **cwd resolution** (`resolveThreadCwd`) is the whole of "reuse existing projects": both CLIs
  key project state by cwd. Nearest known project (from `~/.claude.json` `projects` keys or
  `[projects."…"]` headers in `~/.codex/config.toml`), else the git root, else the target dir.
  The walk-up window is bounded by the git root so umbrella entries (`~/dev`, `/`) never win,
  and `/` plus `$HOME` are blacklisted as a second belt.
- **Never mutate agent configs** from the server. Fresh projects materialize naturally on the
  agent side on first run.
- **Spawning** follows the `git.ts` discipline — argv arrays, never a shell — but detached and
  unref'd, with stdout/stderr to `~/.browsey/agent-runs/<timestamp>-<agent>.log`. Prompts are
  capped (100k chars) and selections (32 KB) to stay well inside `ARG_MAX`.
- **Binary resolution**: `BROWSEY_CLAUDE_BIN` / `BROWSEY_CODEX_BIN`, then `~/.local/bin/claude`
  and `/opt/homebrew/bin/codex`, then `Bun.which` against a PATH augmented with those dirs.
  Do **not** default to an interactive shell's `which claude` — it points into a volatile fnm
  multishell dir. The augmented PATH is also passed to the child, which matters because the
  `:4200` instance is launchd-managed with a bare PATH.
- **Launch stays fire-and-forget, but not blind.** The response returns as soon as
  `spawn` succeeds, so a run that dies seconds later (stale login, exhausted quota)
  cannot be reported in that reply. Instead a lingering `exit` listener records the
  last non-zero exit per agent in `lastFailures`, and `GET /api/agents` reports it as
  `lastFailure` so the app can warn where the agent is chosen. A clean exit clears it.
  In memory only — it describes machine state, so losing it on restart is correct.
- **Model lists** are curated constants in `agents.ts`; the `Default` label is enriched from
  `~/.claude/settings.json` / `~/.codex/config.toml`. Updating models needs no app release.

### Instance Registry
- Running instances tracked in `~/.browsey/instances.json` with atomic writes
- Instances have `kind: 'api' | 'app'` to distinguish server types
- `browsey list` shows KIND column with api/app entries

### Frontend Classes (in `packages/app/src/ui/app.ts`)
- `FileViewer`: Modal for displaying files with zoom/navigation controls
- `InfoModal`: Display file metadata
- `SearchOverlay`: Fuzzy file search
- `GitHistoryOverlay`: Commit history display
- `GitChangesOverlay`: Tree view of file changes
- `GitStatusBar`: Git status display
- `FileBrowser`: Main app managing navigation and state

### File Type Handling
- Text files (50+ extensions): Syntax highlighting via highlight.js
- Markdown: Rendered via marked.js
- Images (9 formats): Navigation between siblings, swipe support
- Videos (mp4, mov, webm): Streamed from `/api/file` with HTTP Range support
- Size limits: 5MB text, 20MB images; videos are not size-limited by `/api/view`

## TypeScript Configuration

- Strict mode enabled
- No implicit any or unchecked index access
- ES2022 target, ESNext modules
- Bundler module resolution
- Composite projects with project references

## Running Instances

API and UI servers are always running on this device:
- **API**: port `4200` (serves `~/dev`)
- **UI**: port `4201` (connects to API at `http://192.168.1.12:4200`)

After code changes, **rebuild** (`bun run build`) then **reload** the affected instance:
- `packages/api/` or `packages/shared/` changes → `browsey api reload :4200`
- `packages/app/` changes → `browsey app reload :4201`
- Both → reload both

### API 4200 Restart Rule (launchd-managed)

When API `:4200` is managed by LaunchAgent `com.browsey.api`, do **not** rely on `browsey api reload :4200` alone (port races/re-spawn can happen). Use this flow:

```bash
cd ~/dev/browsey
bun run build
launchctl kickstart -k gui/$(id -u)/com.browsey.api
curl -sSf http://127.0.0.1:4200/api/health
```

Expected health output:

```json
{"ok":true,"readonly":false}
```

## Guidelines for Changes

1. **Type safety**: Maintain strict TypeScript - no `any` types
2. **Security**: All file paths must use `resolveSafePath()` before filesystem access
3. **Mobile support**: Test touch interactions and responsive layout
4. **Build after changes**: Run `bun run build` to regenerate the executable, then reload the affected instance(s)
5. **No over-engineering**: Keep solutions simple and focused on the task
6. **Cross-package imports**: Use `@vforsh/browsey-shared` for shared types/utils
7. **TODO tracking**: After each commit, check `TODO.md` — if the committed work completes a listed task, remove it and renumber the remaining items

## Dependencies

**shared**: (no external deps)
**api**: `@vforsh/browsey-shared`, `qrcode-terminal`
**app**: `@vforsh/browsey-shared`, `highlight.js`, `lucide-static`, `marked`, `marked-highlight`, `qrcode-terminal`
**cli**: `@vforsh/browsey-shared`, `@vforsh/browsey-api`, `@vforsh/browsey-app`, `commander`, `get-port`
**Dev** (root): `@types/qrcode-terminal`, `@types/bun`, `typescript`

## Known Issues

See `TODO.md` for current bugs and improvements.
