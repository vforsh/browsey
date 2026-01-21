# Feature: Info icon, virtual up item, image viewer navigation
Date: 2026-01-21

## Goal

- Replace the **list-row download action** with an **info** action.
- Add the same **info** action for **folder rows**.
- Add a virtual **`..` (one level up)** row to every folder (except root), shown **first**.
- In “image viewer” mode, allow switching between images in the same directory via **Prev/Next buttons**, **swipe**, and **keyboard arrows**, with **no wrap-around**.
- Adjust CLI defaults:
  - **Display QR code on start by default**
  - **Do not auto-open the browser by default**
  - If auto-open is enabled, open the **Network** address (not Local)
  - **Run in readonly mode by default**

## Current state

- **Directory list rendering + row actions** live in `src/ui/app.ts` (`FileBrowser.renderItems()`).
  - Files currently have a right-side **download** action button (inline SVG) and a **copy path** action.
  - Folders currently only have **copy path**.
- **Row click behavior** is delegated in `FileBrowser.setupEventListeners()`:
  - Download action uses `.download` and triggers `downloadFile(path)`.
  - Clicking a row navigates for directories; for files, opens viewer if viewable else downloads.
- **Viewer overlay** is `#viewer-overlay` in `src/ui/index.html`.
  - Viewer supports text + image, has a **download** button (`#viewer-download`) and close button.
  - No in-view navigation between images.
- **API** already supports:
  - `GET /api/list?path=/...` (items include `absolutePath`)
  - `GET /api/stat?path=/...` (metadata, no absolute path)
  - `GET /api/view?path=/...` (text or image URL)
- **CLI defaults today** (from `src/bin.ts`):
  - Auto-open is **enabled** by default (`--no-open` disables)
  - QR is **disabled** by default (`--qr` enables)
  - Readonly is **disabled** by default (`--readonly` enables)

## Proposed design

### 0) Adjust CLI options + defaults

Requirements:
- QR should display on start **by default**
- Browser should **not** auto-open by default
- If auto-open is enabled, it should open the **Network URL** (not localhost)
- Readonly should be **on by default**

Implementation approach (keep flags simple and explicit; no backward-compat requirement):
- Update `src/bin.ts` options to make defaults match:
  - Replace `--no-open` with `--open` (default: false).
  - Replace `--qr` with `--no-qr` (default: true).
  - Replace `--readonly` with `--no-readonly` (default: true).
- Update `README.md` options table + examples to match the new defaults.

Server open behavior:
- In `src/server.ts`, when `options.open` is true:
  - Compute `networkUrl` (already done)
  - Guard-clause: if `networkUrl` exists, open it
  - Otherwise, do not open (or fall back to local URL—pick one; recommended: **fall back to local URL** only if network URL is unavailable, and document this)

QR default behavior:
- Since host default is `0.0.0.0`, `networkUrl` will typically exist; with QR default on, QR renders by default.
- Guard-clause: if `networkUrl` is null (e.g. host not bound to `0.0.0.0`/`::`), skip QR rendering.

### 1) Info action + details modal (files + folders)

- Replace the per-row **download** action button with an **info** action button (`.info`).
- Add the **info** action for directory rows as well.
- Clicking the info button opens an **Info modal** (overlay) showing details:
  - **name**
  - **type**
  - **size** (formatted)
  - **modified**
  - **created**
  - **extension** (files only)
  - **absolute path** (from list data where available)
- Implementation approach:
  - Add a new UI component class `InfoModal` in `src/ui/app.ts`.
  - `InfoModal.open({ path, absolutePath? })` will:
    - Guard-clause: if no `path`, return early.
    - Fetch `/api/stat?path=...` and render a simple key/value layout.
    - Show loading/error states similarly to `FileViewer`.
  - Wire it into click delegation:
    - Guard-clause: if `.info` not clicked, do nothing.
    - Stop propagation so the row doesn’t navigate/open the viewer.

Notes:
- We keep **download on row click** for non-viewables, and keep **viewer download** as-is for viewables.

### 2) Virtual `..` item (one level up), first item in non-root folders

- In `FileBrowser.renderItems()` prepend a synthetic entry when `currentPath !== '/'`:
  - Row label: `..`
  - Row type: `directory`
  - Row `data-path`: computed parent path of `currentPath`
- Avoid server/API changes (this is a UI-only “virtual row”).
- UI behavior:
  - Clicking the row navigates up (normal directory navigation path).
  - Actions:
    - Recommended: **no actions** for `..` (no copy/info) to avoid confusing “virtual” metadata.
- Guard clauses:
  - If `currentPath === '/'`, return early and render no `..`.
  - If computed parent equals current (shouldn’t), return early and skip the row.

### 3) Image viewer navigation (buttons + swipe + keyboard)

Constraints from answers:
- Controls: **Prev/Next buttons**, **swipe**, **ArrowLeft/ArrowRight**.
- Image set: only viewable image extensions (current `VIEWABLE_IMAGE_EXTENSIONS`).
- No wrap-around: at ends, buttons are disabled and swipes/arrows do nothing.

Design:
- Track the current directory’s image list in `FileBrowser`:
  - Add `private currentItems: FileItem[] = []` updated whenever a directory list loads.
  - Derive `imagePaths` from `currentItems`:
    - Filter: `item.type === 'file'` and `isViewable(item.extension) === 'image'`
    - Map to full paths based on `currentPath`
  - Find `currentIndex` by matching the opened image path.
- Extend viewer API to accept navigation context:
  - Option A (recommended): `FileViewer.open(path, { imageNav?: { paths: string[]; index: number } })`
  - Viewer stores this nav state and updates UI accordingly.
- Add two new viewer header buttons in `src/ui/index.html`:
  - `#viewer-prev` and `#viewer-next`
  - Hidden/disabled unless image nav is available.
- Keyboard:
  - In the existing `document.keydown` handler, if viewer is open and nav exists:
    - `ArrowLeft` => prev
    - `ArrowRight` => next
  - Guard-clause: if overlay hidden, return early.
- Swipe:
  - Attach touch start/end listeners to the image container when rendering images.
  - Detect horizontal swipe (|deltaX| threshold and |deltaX| > |deltaY|):
    - Swipe left => next
    - Swipe right => prev
  - Guard-clause: if no nav, return early.
  - Ensure it doesn’t conflict with the existing swipe-down-to-close (vertical).

Deep link support (`/some/path/to/img.jpg?view=1`):
- Today: `navigate(parentPath, { openViewerPath })` then `viewer.open(openViewerPath)`.
- Update: after directory items load, detect whether `openViewerPath` is an image and, if so,
  open with nav context derived from `currentItems`.

## Touch points

- `src/bin.ts`
  - Adjust CLI options and defaults (QR on by default, open off by default, readonly on by default).
- `src/server.ts`
  - If open is enabled, open the **Network URL** (prefer network over localhost).
- `README.md`
  - Update options defaults table and usage examples accordingly.

- `src/ui/app.ts`
  - Replace `.download` action with `.info` action in `renderItems()`.
  - Add `InfoModal` class and hook it into delegated click handler.
  - Add `currentItems` state and update it in `navigate()` after list fetch.
  - Inject virtual `..` row at the top for non-root directories.
  - Extend `FileViewer` to support image navigation + new controls:
    - buttons
    - keyboard
    - swipe
  - Update deep-link flow so images open with nav context.

- `src/ui/index.html`
  - Add Info modal overlay markup (container, header/title, close button, body).
  - Add viewer prev/next buttons to `.viewer-actions` (near download/close).

- `src/ui/styles.css`
  - Styles for Info modal overlay and content.
  - Styles for disabled prev/next buttons (e.g. reduced opacity, no hover color).

## Rollout order

1) Adjust CLI options + defaults and update README.
2) Update server open behavior to prefer Network URL.
3) Add Info modal markup + minimal styling (hidden by default).
4) Implement `InfoModal` class with loading/error/render.
5) Swap list action from download → info for files and add info for directories.
6) Add virtual `..` row injection (first item, non-root).
7) Add viewer prev/next buttons + viewer nav state (no deep-link yet).
8) Add keyboard + swipe handlers for image navigation.
9) Update deep-link flow to open images with nav context.

## Risks / edge cases

- **Virtual `..` row actions**: best to keep action-less to avoid misleading “stat” or “absolutePath”.
- **Sorting**: `..` should remain first regardless of server sorting.
- **Deep links**: if the target image no longer exists in directory listing, open viewer without nav.
- **Swipe conflicts**: ensure horizontal swipes don’t trigger swipe-down-to-close and vice versa.
- **Very large directories**: image list derivation is O(n) per open; acceptable for now.

## Testing notes

- Manual checks:
  - From `/`, confirm there is **no** `..` row.
  - From `/a/b`, confirm `..` appears first and navigates to `/a`.
  - Click **info** on:
    - a folder row
    - a file row
    - confirm modal shows stats and closes via X / overlay click / ESC (if added).
  - Open an image and verify:
    - Prev/Next buttons work and disable at ends (no wrap).
    - Swipe left/right navigates images.
    - ArrowLeft/ArrowRight navigates images.
  - Deep-link an image URL with `?view=1` and confirm nav works within its directory.

## Final checklist

- Run `npm run typecheck`
- Run `npm run lint` (and `npm run lint:fix` if appropriate)
