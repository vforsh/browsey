# Font Size Control for File Viewer - Implementation Plan

## Overview

Add font size control buttons (`A-` / `A+`) to the file viewer modal that allow users to adjust text size for markdown and code content. The buttons replace the `< >` navigation buttons contextually - showing font controls for text content and navigation arrows for images.

## Specifications

| Spec | Value |
|------|-------|
| Scope | Markdown + Code viewer |
| UI | Two buttons: `A-` (decrease) and `A+` (increase) |
| Range | Incremental: 12px to 24px in 2px steps (7 levels) |
| Persistence | Yes, saved in localStorage |
| Context | Show font controls for text, `< >` for images |

## Font Size Levels

| Level | Size | Label |
|-------|------|-------|
| 1 | 12px | Smallest |
| 2 | 14px | Small |
| 3 | 16px | Default |
| 4 | 18px | Medium |
| 5 | 20px | Large |
| 6 | 22px | Larger |
| 7 | 24px | Largest |

Default: Level 3 (16px)

## Implementation Steps

### Step 1: Update HTML (`src/ui/index.html`)

Add font size control buttons alongside existing navigation buttons:

```html
<!-- In viewer-actions div, add font size buttons (hidden by default) -->
<button class="btn-icon" id="viewer-font-decrease" aria-label="Decrease font size" hidden>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <text x="4" y="17" font-size="14" font-weight="bold" fill="currentColor" stroke="none">A</text>
    <text x="14" y="17" font-size="10" font-weight="bold" fill="currentColor" stroke="none">-</text>
  </svg>
</button>
<button class="btn-icon" id="viewer-font-increase" aria-label="Increase font size" hidden>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <text x="4" y="17" font-size="14" font-weight="bold" fill="currentColor" stroke="none">A</text>
    <text x="14" y="17" font-size="10" font-weight="bold" fill="currentColor" stroke="none">+</text>
  </svg>
</button>
```

Button order in header: `[A-] [A+] [<] [>] [Download] [Close]`

### Step 2: Update FileViewer Class (`src/ui/app.ts`)

#### 2.1 Add Properties

```typescript
class FileViewer {
  // Existing properties...
  private fontDecreaseBtn: HTMLButtonElement
  private fontIncreaseBtn: HTMLButtonElement
  private currentFontLevel: number = 3 // Default: 16px
  private readonly FONT_SIZES = [12, 14, 16, 18, 20, 22, 24]
  private readonly STORAGE_KEY = 'browsey-font-size'
  private currentContentType: 'text' | 'image' | null = null
```

#### 2.2 Update Constructor

```typescript
constructor(onClose?: () => void, onNavigate?: (path: string) => void) {
  // Existing initialization...
  this.fontDecreaseBtn = document.getElementById('viewer-font-decrease') as HTMLButtonElement
  this.fontIncreaseBtn = document.getElementById('viewer-font-increase') as HTMLButtonElement

  this.loadFontPreference()
  this.setupEventListeners()
  this.setupMarked()
}
```

#### 2.3 Add Font Size Methods

```typescript
private loadFontPreference(): void {
  const saved = localStorage.getItem(this.STORAGE_KEY)
  if (saved) {
    const level = parseInt(saved, 10)
    if (level >= 1 && level <= this.FONT_SIZES.length) {
      this.currentFontLevel = level
    }
  }
}

private saveFontPreference(): void {
  localStorage.setItem(this.STORAGE_KEY, String(this.currentFontLevel))
}

private getCurrentFontSize(): number {
  return this.FONT_SIZES[this.currentFontLevel - 1] ?? 16
}

private decreaseFontSize(): void {
  if (this.currentFontLevel <= 1) return
  this.currentFontLevel--
  this.applyFontSize()
  this.saveFontPreference()
  this.updateFontButtons()
}

private increaseFontSize(): void {
  if (this.currentFontLevel >= this.FONT_SIZES.length) return
  this.currentFontLevel++
  this.applyFontSize()
  this.saveFontPreference()
  this.updateFontButtons()
}

private applyFontSize(): void {
  const size = this.getCurrentFontSize()
  const textContent = this.content.querySelector('.viewer-text, .viewer-markdown')
  if (textContent) {
    (textContent as HTMLElement).style.fontSize = `${size}px`
  }
}

private updateFontButtons(): void {
  this.fontDecreaseBtn.disabled = this.currentFontLevel <= 1
  this.fontIncreaseBtn.disabled = this.currentFontLevel >= this.FONT_SIZES.length
}
```

#### 2.4 Update setupEventListeners

```typescript
private setupEventListeners(): void {
  // Existing listeners...
  this.fontDecreaseBtn.addEventListener('click', () => this.decreaseFontSize())
  this.fontIncreaseBtn.addEventListener('click', () => this.increaseFontSize())

  // Add keyboard shortcuts for font size
  document.addEventListener('keydown', (e) => {
    if (this.overlay.hidden) return
    if (e.key === 'Escape') {
      this.close()
    } else if (e.key === 'ArrowLeft') {
      if (this.currentContentType === 'image') {
        this.navigatePrev()
      }
    } else if (e.key === 'ArrowRight') {
      if (this.currentContentType === 'image') {
        this.navigateNext()
      }
    } else if (e.key === '-' || e.key === '_') {
      if (this.currentContentType === 'text') {
        this.decreaseFontSize()
      }
    } else if (e.key === '=' || e.key === '+') {
      if (this.currentContentType === 'text') {
        this.increaseFontSize()
      }
    }
  })
}
```

#### 2.5 Update Button Visibility Logic

```typescript
private updateControlButtons(): void {
  const isImage = this.currentContentType === 'image'
  const isText = this.currentContentType === 'text'

  // Image navigation: show only for images with nav context
  const hasImageNav = this.imageNav !== null
  this.prevBtn.hidden = !(isImage && hasImageNav)
  this.nextBtn.hidden = !(isImage && hasImageNav)
  if (hasImageNav) {
    this.prevBtn.disabled = this.imageNav!.index <= 0
    this.nextBtn.disabled = this.imageNav!.index >= this.imageNav!.paths.length - 1
  }

  // Font controls: show only for text content
  this.fontDecreaseBtn.hidden = !isText
  this.fontIncreaseBtn.hidden = !isText
  if (isText) {
    this.updateFontButtons()
  }
}
```

#### 2.6 Update renderText Method

```typescript
private renderText(content: string, extension: string | null, filename: string): void {
  this.currentContentType = 'text'
  const size = this.getCurrentFontSize()

  const isMarkdown = extension?.toLowerCase() === 'md' || extension?.toLowerCase() === 'markdown'

  if (isMarkdown) {
    const html = marked.parse(content) as string
    this.content.innerHTML = `<div class="viewer-markdown" style="font-size: ${size}px">${html}</div>`
  } else {
    const language = getLanguage(extension)
    let highlighted: string

    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(content, { language }).value
    } else {
      highlighted = hljs.highlightAuto(content).value
    }

    this.content.innerHTML = `<div class="viewer-text" style="font-size: ${size}px"><code class="hljs">${highlighted}</code></div>`
  }

  this.updateControlButtons()
}
```

#### 2.7 Update renderImage Method

```typescript
private renderImage(url: string, filename: string): void {
  this.currentContentType = 'image'
  // Existing image rendering code...
  this.updateControlButtons()
}
```

#### 2.8 Update close/reset Methods

```typescript
private closeInternal(shouldNotify: boolean): void {
  this.overlay.hidden = true
  this.currentPath = null
  this.imageNav = null
  this.currentContentType = null
  this.content.innerHTML = ''
  this.updateControlButtons()
  if (!shouldNotify) return
  this.onClose?.()
}
```

### Step 3: Update CSS (`src/ui/styles.css`)

```css
/* Font size button styling */
#viewer-font-decrease,
#viewer-font-increase {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

#viewer-font-decrease:disabled,
#viewer-font-increase:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Ensure text content respects font-size */
.viewer-text,
.viewer-markdown {
  transition: font-size 0.15s ease;
}

.viewer-text code {
  font-size: inherit;
}
```

## File Changes Summary

| File | Changes |
|------|---------|
| `src/ui/index.html` | Add 2 new buttons for font size control |
| `src/ui/app.ts` | Add font size logic, update button visibility |
| `src/ui/styles.css` | Add styles for font buttons and transitions |

## Keyboard Shortcuts

| Key | Action | Context |
|-----|--------|---------|
| `-` | Decrease font size | Text viewer |
| `+` / `=` | Increase font size | Text viewer |
| `←` | Previous image | Image viewer |
| `→` | Next image | Image viewer |
| `Esc` | Close viewer | All |

## Testing Checklist

- [ ] Font size buttons appear for markdown files
- [ ] Font size buttons appear for code files
- [ ] Font size buttons hidden for images
- [ ] `< >` buttons appear for images with siblings
- [ ] `< >` buttons hidden for text content
- [ ] `A-` disabled at minimum size (12px)
- [ ] `A+` disabled at maximum size (24px)
- [ ] Font size persists across page reloads
- [ ] Font size persists across different files
- [ ] Keyboard shortcuts work correctly
- [ ] Transition animation is smooth
