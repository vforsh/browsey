# AGENTS.md - AI Coding Agent Guidelines for Browsey

## Project Overview

**Browsey** is a mobile-friendly web file browser CLI tool built with Bun. It starts a local web server to browse files from any device on the network - perfect for quickly accessing files on your computer from your phone or tablet.

## Tech Stack

- **Runtime**: Bun (v1.1.0+)
- **Language**: TypeScript (v5.7.0, strict mode)
- **CLI**: Commander.js
- **Frontend**: Vanilla JS/TS (no framework), highlight.js, marked.js
- **Styling**: Custom CSS with dark theme, mobile-first responsive design

## Project Structure

```
src/
├── bin.ts          # CLI entry point (Commander.js commands)
├── server.ts       # Bun HTTP server, request routing, Bonjour
├── routes.ts       # API route handlers (/api/list, /api/file, etc.)
├── types.ts        # TypeScript type definitions
├── auth.ts         # Token generation/validation
├── security.ts     # Path traversal prevention
├── ignore.ts       # File ignore pattern matching
├── bonjour.ts      # mDNS service advertising for iOS discovery
├── registry.ts     # Instance tracking in ~/.browsey/instances.json
├── ui/
│   ├── index.html  # HTML template
│   ├── styles.css  # Dark theme CSS
│   └── app.ts      # Frontend app (FileViewer, InfoModal, FileBrowser classes)
└── utils/
    └── mime.ts     # MIME type mapping

scripts/
└── build.ts        # Build script: bundles UI + server into single executable

dist/
└── browsey         # Built executable
```

## Development Commands

```bash
bun install          # Install dependencies
bun run dev          # Dev mode (loads UI from disk)
bun run typecheck    # Type checking
bun run build        # Build distribution executable
bun link             # Link locally for testing
```

## CLI Usage

```bash
browsey [path]       # Serve directory (default: current dir)
browsey list         # List running instances
browsey stop [target] # Stop by PID, :port, or path
```

**Options**: `-p/--port`, `-h/--host`, `-i/--ignore`, `--open`, `--no-readonly`, `--hidden`, `--no-qr`, `--no-bonjour`

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/list?path=/` | List directory contents |
| `GET /api/file?path=/file.txt` | Download file |
| `GET /api/view?path=/file.txt` | View file in browser |
| `GET /api/stat?path=/file.txt` | Get file metadata |
| `GET /` | Serve SPA |

## Key Patterns

### Security
- **Path traversal prevention**: All paths go through `resolveSafePath()` in `security.ts`
- **Constant-time token comparison** in `auth.ts`
- **Readonly mode by default** - modifications require `--no-readonly` flag
- **Null byte filtering** in path handling

### Architecture
- **Process registry**: Running instances tracked in `~/.browsey/instances.json` with atomic writes
- **Mobile-first UI**: Touch swipes, keyboard navigation, safe areas for notches
- **Build process**: Frontend bundled as IIFE, inlined into server as constants

### Frontend Classes (in `src/ui/app.ts`)
- `FileViewer`: Modal for displaying files with zoom/navigation controls
- `InfoModal`: Display file metadata
- `FileBrowser`: Main app managing navigation and state

### File Type Handling
- Text files (50+ extensions): Syntax highlighting via highlight.js
- Markdown: Rendered via marked.js
- Images (9 formats): Navigation between siblings, swipe support
- Size limits: 5MB text, 20MB images

## TypeScript Configuration

- Strict mode enabled
- No implicit any or unchecked index access
- ES2022 target, ESNext modules
- Bundler module resolution

## Guidelines for Changes

1. **Type safety**: Maintain strict TypeScript - no `any` types
2. **Security**: All file paths must use `resolveSafePath()` before filesystem access
3. **Mobile support**: Test touch interactions and responsive layout
4. **Build after changes**: Run `bun run build` to regenerate the executable
5. **No over-engineering**: Keep solutions simple and focused on the task

## Dependencies

**Production**: `bonjour-service`, `commander`, `get-port`, `highlight.js`, `lucide-static`, `marked`, `marked-highlight`, `qrcode-terminal`

**Dev**: `@types/qrcode-terminal`, `@types/bun`, `typescript`

## Known Issues

See `TODO.md` for current bugs and improvements.
