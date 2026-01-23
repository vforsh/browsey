# Goal

Make Browsey a “proper” installable PWA **when served behind HTTPS** (secure context), with:

- A web app manifest (`/manifest.webmanifest`)
- Required icon assets (including iOS `apple-touch-icon`)
- Correct server routes + MIME types for those assets in **dev** (load from disk) and **prod** (inlined into the built `dist/browsey` binary)
- Deep-link support (PWA scope should include Browsey’s path-based navigation)

Constraints from answers:

- Install target: **HTTPS only** (recommended; required for “proper PWA” semantics)
- Offline: **none** (no service worker; no offline caching)
- Scope: **include deep paths** (not just `/`)
- Display: **`fullscreen`**
- Platform extras: **iOS Add to Home Screen polish**
- Asset generation: use **`eikon` CLI** as the placeholder tool (note: `eikon --help` shows image generation/upscale/placeholder tools, not a PWA-specific generator)

# Current state

- UI is served as three endpoints:
  - `GET /` → `src/ui/index.html`
  - `GET /styles.css` → `src/ui/styles.css`
  - `GET /app.js` → bundled `src/ui/app.ts`
  - Everything else (non-API) falls back to `index.html` for SPA deep links.
  - See `src/server.ts` (dev loads from disk; prod uses `UI_HTML/UI_CSS/UI_JS` constants injected by `scripts/build.ts`).
- There is no PWA manifest, icons, or dedicated static asset routing yet.
- `src/ui/index.html` already has some iOS-ish meta tags, but no manifest/icon links.

# Proposed design

## PWA assets (no service worker)

- Add `src/ui/pwa/manifest.webmanifest` served at `/manifest.webmanifest`.
- Add icon assets under `src/ui/pwa/icons/` (filenames stable, referenced by the manifest):
  - `icon-192.png`
  - `icon-512.png`
  - `apple-touch-icon.png` (180×180)
  - (Optional but recommended) `maskable-512.png` + `maskable-192.png`
  - (Optional) `favicon.ico` or `favicon-32.png`

Manifest specifics (fill with chosen values):

- `name`: **Browsey** (assumption: user’s “y” = yes to default name)
- `short_name`: **Browsey**
- `start_url`: `/`
- `scope`: `/` (covers deep paths like `/some/folder`)
- `display`: `fullscreen`
- `background_color`: match current theme (`#0f0f17` from CSS root)
- `theme_color`: match current meta theme-color (`#1a1a2e`)

## HTML integration

Update `src/ui/index.html` to include:

- `<link rel="manifest" href="/manifest.webmanifest">`
- `<link rel="icon" ...>` (favicon)
- `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`
- iOS title meta (optional): `<meta name="apple-mobile-web-app-title" content="Browsey">`

## Server routing (guard-clause / return-early style)

Add explicit handling in `src/server.ts` **before** API handling and the SPA fallback:

- `GET /manifest.webmanifest` → manifest content (`application/manifest+json` or `application/json`)
- `GET /icons/<name>.png` → PNG bytes with `image/png`
- `GET /favicon.ico` (if added) → `image/x-icon`

Keep existing SPA fallback for deep links (anything else non-API should still return `index.html`).

## Build pipeline (dev + prod parity)

Extend the “UI bundle injection” pattern:

- In dev: load the new manifest + icons from `src/ui/pwa/**` on disk.
- In prod: inline the manifest + icon bytes into the built server bundle (similar to `UI_HTML/UI_CSS/UI_JS`):
  - For binary assets (PNGs/ICO), inject them as base64 strings (via `define`) and decode at runtime to `Uint8Array`/`Buffer` for `Response`.

No new runtime dependencies required if we keep binary handling minimal (base64 decode).

# Touch points (file-by-file)

- `src/ui/index.html`
  - Add manifest + icon links and any extra iOS meta tags.
- `src/server.ts`
  - Add routes for `/manifest.webmanifest`, `/icons/*`, and optional `/favicon.ico`.
  - Ensure guard-clauses keep nesting shallow.
- `scripts/build.ts`
  - Read `src/ui/pwa/manifest.webmanifest` and icon files.
  - Inject constants (e.g. `UI_MANIFEST`, `UI_ICON_192_B64`, etc.) with `define`.
- `src/ui/pwa/manifest.webmanifest` (new)
- `src/ui/pwa/icons/*` (new binary files)
- `README.md` (optional but recommended)
  - Add a short note: PWA install works behind HTTPS; suggest reverse proxy setup.

# Asset generation (using `eikon placeholder` with JetBrains Mono)

Use `eikon placeholder` for **all** required PWA image assets (placeholder-quality is fine to start), with `--font-family "JetBrains Mono"` so the look is consistent.

Suggested commands (adjust colors/text as desired):

```bash
# App icons (transparent is not supported by placeholder; use solid background)
eikon placeholder --w 192 --h 192 --bg-color "#0f0f17" --text "B" --text-color "#F9FAFB" --font-family "JetBrains Mono" --font-weight 700 --out src/ui/pwa/icons/icon-192.png
eikon placeholder --w 512 --h 512 --bg-color "#0f0f17" --text "B" --text-color "#F9FAFB" --font-family "JetBrains Mono" --font-weight 700 --out src/ui/pwa/icons/icon-512.png

# Maskable icons (recommended)
eikon placeholder --w 192 --h 192 --bg-color "#0f0f17" --text "B" --text-color "#F9FAFB" --font-family "JetBrains Mono" --font-weight 700 --out src/ui/pwa/icons/maskable-192.png
eikon placeholder --w 512 --h 512 --bg-color "#0f0f17" --text "B" --text-color "#F9FAFB" --font-family "JetBrains Mono" --font-weight 700 --out src/ui/pwa/icons/maskable-512.png

# iOS Add-to-Home-Screen icon
eikon placeholder --w 180 --h 180 --bg-color "#0f0f17" --text "B" --text-color "#F9FAFB" --font-family "JetBrains Mono" --font-weight 700 --out src/ui/pwa/icons/apple-touch-icon.png
```

Notes:

- If JetBrains Mono isn’t available on the machine running `eikon`, the output may fall back to a default font. (We can later embed a webfont in the UI if you want the installed app to use JetBrains Mono for text too.)

# Rollout order

1) Add `src/ui/pwa/manifest.webmanifest` and decide the exact icon filenames + paths.
2) Add icon files under `src/ui/pwa/icons/`.
3) Update `src/ui/index.html` to reference manifest + icons.
4) Update `src/server.ts` to serve manifest/icons with correct MIME types (guard clauses).
5) Update `scripts/build.ts` to inline new assets into `dist/browsey` for production builds.
6) Verify:
   - `/manifest.webmanifest` returns correct JSON with correct header
   - `/icons/*` returns images (not the SPA HTML fallback)
   - deep links like `/some/folder` still load the SPA
7) Document HTTPS requirement in `README.md`.

# Risks / edge cases

- **Secure context**: Without HTTPS (or localhost), service workers and “installability” won’t behave like a “proper PWA”. This plan targets HTTPS explicitly.
- **Route ordering**: If static asset routes are not handled before the SPA fallback, requests for `/manifest.webmanifest` or icons will incorrectly return `index.html`.
- **Binary embedding**: Base64 size overhead is acceptable for a few small icons, but keep the set minimal.
- **iOS quirks**: iOS uses `apple-touch-icon` and meta tags more than the manifest for A2HS behavior; `display: fullscreen` won’t always map 1:1.

# Testing notes

- **Manual**:
  - Run `bun run dev`, open the app over HTTPS (reverse proxy) and confirm “Add to Home Screen” offers correct icon/title.
  - Visit:
    - `/manifest.webmanifest`
    - `/icons/icon-192.png`
    - `/icons/apple-touch-icon.png`
  - Confirm deep links still render the app:
    - open `/` then navigate into folders; refresh on a deep path.
- **Chrome DevTools**:
  - Application → Manifest: fields populate; icons load; “Install” is available (when HTTPS).

# Final checklist

- Run `bun run typecheck`
- Run `bun run build`
- Smoke test dev mode and built `dist/browsey` behind HTTPS

