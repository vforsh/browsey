# Browsey

A mobile-friendly web file browser CLI tool built with Bun.

Start a local web server to browse files from any device on your network - perfect for quickly accessing files on your computer from your phone or tablet.

## Features

- **Mobile-first UI** - Touch-friendly interface with large tap targets
- **Dark theme** - Easy on the eyes
- **Copy path** - One-tap copy of absolute file paths
- **Ignore patterns** - Filter out files/folders with glob patterns
- **QR code** - Scan to open on mobile instantly
- **Zero config** - Just run `browsey` and go

## Installation

```bash
bun install -g @vforsh/browsey
```

Or run directly:

```bash
bunx @vforsh/browsey
```

## Usage

```bash
# Serve current directory
browsey

# Serve a specific directory
browsey ./photos

# Custom port
browsey -p 3000

# Show QR code for mobile access
browsey --qr

# Ignore patterns
browsey -i "node_modules,.git,*.log"

# Show hidden files
browsey --hidden

# All options
browsey ./my-folder -p 8080 -h 0.0.0.0 -i "node_modules,.git" --hidden --qr
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `[path]` | Directory to serve | `.` (current) |
| `-p, --port <port>` | Port number | `8080` |
| `-h, --host <host>` | Host to bind | `0.0.0.0` |
| `-i, --ignore <globs>` | Comma-separated ignore patterns | - |
| `--hidden` | Show hidden files | `false` |
| `--qr` | Display QR code for mobile | `false` |
| `--no-open` | Don't open browser automatically | - |

## API

Browsey exposes a simple REST API:

| Endpoint | Description |
|----------|-------------|
| `GET /api/list?path=/` | List directory contents |
| `GET /api/file?path=/file.txt` | Download a file |
| `GET /api/stat?path=/file.txt` | Get file metadata |

### Response format

`GET /api/list?path=/`

```json
{
  "path": "/",
  "items": [
    {
      "name": "documents",
      "type": "directory",
      "size": 4096,
      "modified": "2024-01-15T10:30:00.000Z",
      "extension": null
    },
    {
      "name": "photo.jpg",
      "type": "file",
      "size": 245678,
      "modified": "2024-01-14T08:20:00.000Z",
      "extension": "jpg"
    }
  ]
}
```

## Development

```bash
# Clone the repo
git clone https://github.com/vforsh/browsey.git
cd browsey

# Install dependencies
bun install

# Run in dev mode
bun run dev

# Build
bun run build

# Link locally for testing
bun link
```

## Tech Stack

- **Bun** - Runtime, bundler, and package manager
- **TypeScript** - Type safety
- **Bun.serve** - Native HTTP server
- **Bun.Glob** - Pattern matching
- **Commander.js** - CLI argument parsing

## License

MIT
