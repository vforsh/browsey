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
| `GET /api/agents?path=/` | Agent capabilities (installed CLIs, curated model lists, live sessions; `path` adds the cwd a launch would resolve to) — **bearer token required** |
| `POST /api/agents/launch` | Launch a Codex thread or open a Claude session — **bearer token required** |
| `POST /api/agents/stop` | End a live Claude session by `sessionId` — **bearer token required** |

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

Full research on which surfaces list these threads and why lives in
`../browsey-expo/docs/agent-thread-visibility.md` — read it before re-investigating any of it.

**The two agents launch differently on purpose**, and `AgentDescriptor.launchMode` is how a
client tells them apart:

- `prompt` (Codex) composes a one-shot thread from a prompt plus its file context, spawns it,
  and forgets it. Results are picked up with `codex resume`.
- `session` (Claude) takes no prompt at all. It opens a live Remote Control session in a
  directory and hands back a link that opens that exact session in the phone app; the
  conversation itself happens there. Passing a prompt would mean typing into a TUI, which was
  measured, rejected, and written up in the research doc.

A `session` agent is the only one with anything to stop, which is what `/api/agents/stop` is
for.

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
- **Spawning** follows the `git.ts` discipline — argv arrays, never a shell — with
  stdout/stderr to `~/.browsey/agent-runs/<timestamp>-<agent>.log`. Claude is detached and
  outlives a browsey restart; Codex talks stdio JSON-RPC, so its turn is tied to this process
  and a restart mid-run aborts it. Prompts are capped (100k chars) and selections (32 KB) to
  stay well inside `ARG_MAX`.
- **Claude sessions are never tracked in memory.** `listClaudeSessions` reads
  `~/.claude/sessions/<pid>.json`, which Claude writes itself, and keeps the entries whose pid
  is still alive — so sessions started before the last restart are still listed and still
  stoppable, and nothing has to be reconciled. Stale files are normal; the pid check is what
  makes the list truthful.
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
- **App visibility is why each agent is launched differently.** Every one of these apps
  filters on how a session was produced, and none of them shows a plain headless run.
  - *Claude Code* on the Mac reads the same on-disk transcripts the CLI writes and filters on
    the recorded surface, so `CLAUDE_CODE_ENTRYPOINT=claude-desktop` is forced on every run —
    a bare `-p` run records `sdk-cli` and stays invisible. Forcing it also stops the value
    depending on the environment browsey inherited: a shell running inside Claude Code exports
    it, a launchd job does not.
  - *The Claude phone app* lists live Remote Control sessions and nothing else, which no
    transcript can satisfy. `claude-remote-control.ts` therefore starts an interactive session
    under a pty — `script(1)`, so no native pty module is needed — with
    `--permission-mode bypassPermissions`. That flag is load-bearing: without it the run stops
    on the "Make auto mode your default permission mode?" prompt and never registers, and
    answering that prompt blind is exactly the screen-scraping the research doc rejected.
    Registration takes about a second; `bridgeSessionId` lands a beat later and becomes
    `https://claude.ai/code/<id>`, which opens that session on the phone.
  - *Codex Desktop* and the Codex iOS app filter on the session's `source`. `codex exec`
    records `source: exec`, which they treat as automation and never list — no flag or env
    var changes it (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` moves `originator` only; `source`
    is set structurally by the subcommand, and `thread/resume` does not re-stamp it: a
    resumed thread still carries one `session_meta`). So Codex threads are created over the
    **app-server protocol** (`codex-app-server.ts`), which records `source: vscode` and
    `originator: browsey` from our `clientInfo`, and they show up in both Codex clients.
  - **`source` is not ours to pick and `vscode` there does not mean VS Code.** It labels the
    transport; Codex has called every app-server client `vscode` since the VS Code extension
    was the first one. On this machine ten different tools carry it, including Codex Desktop
    itself and the official iOS client — only `originator: codex_vscode` is the actual
    extension. It is unaffected by `clientInfo.name`, `serviceName` and `sessionStartSource`
    (all measured). The field that identifies us is `originator`, and it says `browsey`.
    `threadSource: 'user'` is set too, matching what the real clients record for a thread a
    person started, rather than leaving it empty like a subagent spawn.
  - **The turn must be seen through to a clean shutdown.** Killing the app server early
    truncates the thread — it keeps the user's message and drops the answer — and never
    closing it leaks one process per launch. The run therefore ends on `turn/completed` by
    closing stdin, with a 30-minute stop-loss. Two earlier bugs both came from getting this
    wrong, so do not "simplify" it away.
  - Known trade-off: this transport records `history_mode: legacy`, so the rollout carries
    `user_message`/`agent_message` events instead of `item_completed` items. `codex exec`
    records `paginated`. There is no client-side switch — `capabilities.experimentalApi`,
    `-c threads.history_mode=paginated`, `--enable paginated_threads` (not a real flag),
    `thread/start`'s `config` in two shapes, and ChatGPT.app's bundled 0.148.0-alpha.15
    binary were all tried and all yield `legacy`. Across every local session there are zero
    `source: vscode` + `paginated` threads on 0.148.0. If a future Codex release changes
    that, this is a one-minute check: run `codex app-server`, send `initialize` then
    `thread/start` with no turn, and read `thread.historyMode` from the response.
  - Codex clients do not refresh their list for a thread created by another process; it
    appears after the app restarts, or immediately if something opens `codex://threads/<id>`
    — which drags the app to the foreground, so we do not fire it.
  - Do not write into either desktop app's private state to fake visibility.
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
