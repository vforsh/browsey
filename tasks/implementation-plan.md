# Browsey - Mobile-Friendly Web File Browser CLI

## Overview
Create `@vforsh/browsey` - a CLI tool that starts a web server for browsing files, optimized for mobile devices.

## Tech Stack
- **Bun** (latest) - Runtime, bundler, and package manager
- **TypeScript** (latest, strict mode)
- **Bun.serve** - Native HTTP server (no Express needed)
- **Vanilla JS/HTML/CSS** - Mobile-first UI

## Project Structure
```
browsey/
├── src/
│   ├── bin.ts                 # CLI entry point
│   ├── server.ts              # Bun.serve HTTP server
│   ├── routes.ts              # API route handlers
│   ├── security.ts            # Path traversal prevention
│   ├── ignore.ts              # Glob pattern filtering
│   └── ui/
│       ├── index.html         # Mobile UI
│       ├── styles.css         # Mobile-first styles
│       └── app.ts             # Client-side JS
├── scripts/
│   └── build.ts               # Bun build script
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## CLI Interface
```bash
browsey [path] [options]

Options:
  -p, --port <port>       Port (default: 8080)
  -h, --host <host>       Host (default: 0.0.0.0)
  -i, --ignore <globs>    Ignore patterns (comma-separated globs)
  --no-open               Don't open browser
  --readonly              Disable modifications
  --hidden                Show hidden files
  --qr                    Show QR code for mobile

Examples:
  browsey                              # Serve current dir
  browsey ./photos -p 3000             # Serve photos on port 3000
  browsey --readonly --qr              # Read-only with QR code
  browsey -i "node_modules,*.log,.git" # Ignore patterns
```

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/list?path=` | List directory contents |
| GET | `/api/file?path=` | Download file |
| GET | `/api/stat?path=` | Get file info |

## Mobile UI Features
- Dark theme with high contrast
- 48px minimum touch targets
- Sticky header with path breadcrumb
- Back button navigation
- File icons by type (📁 folder, 📄 file, 🖼️ image, etc.)
- File metadata (size, date)
- **Copy absolute path button** on each entry (clipboard icon)
- Pull-to-refresh

## Ignore Patterns
- CLI accepts `-i, --ignore` with comma-separated glob patterns
- Uses Bun's native `Bun.Glob` for pattern matching
- Patterns are applied when listing directories
- Common use: `node_modules`, `.git`, `*.log`, `dist`
- API returns only non-ignored entries

## Security
- Path traversal prevention via middleware
- Resolve and normalize all paths
- Verify paths stay within root directory
- Block `..` sequences and encoded variants

## Implementation Steps

### 1. Initialize Project
- `bun init` with `@vforsh/browsey`
- Configure TypeScript for Bun
- Set up bunfig.toml

### 2. CLI Setup (`src/bin.ts`)
- Use Commander.js for argument parsing
- Validate root path exists
- Call server start function

### 3. Bun HTTP Server (`src/server.ts`)
- Use `Bun.serve()` for native HTTP
- Pattern match routes
- Serve embedded UI via `Bun.file()`
- Print local/network URLs
- Optional QR code display

### 4. API Routes (`src/routes.ts`)
- `/api/list` - `readdir` with file stats
- `/api/file` - stream file via `Bun.file()`
- `/api/stat` - single file info

### 5. Security (`src/security.ts`)
- Extract path from query
- Resolve against root
- Reject if outside root

### 6. Mobile UI (`src/ui/`)
- `index.html` - viewport meta, PWA-ready
- `styles.css` - mobile-first, dark theme
- `app.ts` - fetch API, render list, navigation, copy path

### 7. Build Pipeline (`scripts/build.ts`)
- Use `Bun.build()` to bundle
- Embed UI assets as strings
- Output single executable with shebang

### 8. Test & Verify
- `bun run build`
- `bun link` and test locally
- Test on mobile device via network URL

## Dependencies
```json
{
  "dependencies": {
    "commander": "^14.0.0",
    "qrcode-terminal": "^0.12.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  }
}
```

**Note:** Bun provides built-in:
- HTTP server (`Bun.serve`)
- File operations (`Bun.file`, `readdir`)
- Glob matching (`Bun.Glob`)
- Bundling (`Bun.build`)
- No need for Express, esbuild, picomatch, or open

## Verification
1. Run `bun run build` - should complete without errors
2. Run `bunx browsey` or `./dist/browsey` - should start server
3. Open in mobile browser via network URL
4. Navigate folders, download files
5. Test `--qr` displays QR code
6. Test `-i` ignore patterns work
