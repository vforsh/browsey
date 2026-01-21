---
name: browsey
description: Use the Browsey CLI to serve a directory as a mobile-friendly web file browser.
metadata:
  short-description: Run Browsey, choose host/port, serve a folder, and share a QR/network URL.
---

You are helping a user run and troubleshoot the **Browsey** CLI (`browsey`) which starts a local Bun server that provides a mobile-friendly web UI for browsing and downloading files from a directory.

## Default agent behavior (do this first)

Run Browsey exactly like this (no extra flags unless the user asks):

```bash
browsey <DIR_PATH> --no-qr
```

Then read Browsey’s startup output and give the user the **Network** URL it prints (the line that starts with `Network:`). That is the address they should open from their phone/other device on the same network.

If no Network URL is printed (e.g. bound to a non-wildcard host), give the **Local** URL instead.

## Quick start

- Serve a specific directory (recommended default):

```bash
browsey ./photos --no-qr
```

After starting, Browsey prints:
- a **Local** URL (typically `http://localhost:<port>`)
- a **Network** URL (only when binding to `0.0.0.0` or `::`)

## Common workflows

- Make it reachable from your phone on the same Wi‑Fi:

```bash
browsey . -h 0.0.0.0
```

- Use a custom port (if the port is busy, Browsey auto-picks another and prints a message):

```bash
browsey -p 3000
```

- Open the browser automatically on start:

```bash
browsey --open
```

- Hide the QR code:

```bash
browsey --no-qr
```

- Include dotfiles:

```bash
browsey --hidden
```

- Ignore files/folders by comma-separated patterns:

```bash
browsey -i "node_modules,.git,*.log"
```

- Allow file modifications (default is read-only):

```bash
browsey --no-readonly
```

## CLI reference (authoritative)

Browsey is implemented in `src/bin.ts` (Commander). Use `browsey --help` to confirm the exact flags in the installed version.

- **Argument**
  - `[path]`: directory to serve (default `.`)

- **Options**
  - `-p, --port <port>`: port to listen on (default `8080`)
  - `-h, --host <host>`: host to bind to (default `0.0.0.0`)
  - `-i, --ignore <globs>`: comma-separated ignore patterns
  - `--open`: open browser automatically (default: off)
  - `--no-readonly`: allow file modifications (default: read-only)
  - `--hidden`: show hidden files (default: off)
  - `--no-qr`: do not display QR code (default: show QR)

## Troubleshooting checklist

- If it says the directory doesn’t exist:
  - Confirm the path you passed exists; Browsey exits if it can’t find the directory.
- If your phone can’t connect:
  - Ensure you bound to `0.0.0.0` (default) and you’re on the same network.
  - Check firewall prompts / inbound rules.
  - Prefer the printed **Network** URL (not `localhost`).
- If the port is in use:
  - Browsey will fall back to an available port and print which one it chose.
  - Or pick another with `-p <port>`.

## What to do when the user asks “how do I…?”

- If they want **local-only** browsing, suggest `-h localhost` (no Network URL, no QR usefulness).
- If they want **mobile access**, suggest `-h 0.0.0.0` and scanning the QR code.
- If they want to prevent changes, keep default **read-only**; only suggest `--no-readonly` when they explicitly need modifications.
