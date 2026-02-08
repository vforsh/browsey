import {
  Archive,
  File,
  FileCode,
  FileCog,
  FileText,
  Folder,
  FolderHeart,
  FolderOpen,
  Image,
  Info,
  Music,
  Star,
  Video,
  TriangleAlert,
} from 'lucide-static'
import hljs from 'highlight.js'
import jsQR from 'jsqr'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'

declare global {
  interface Window {
    __BROWSEY_API_BASE__: string
  }
}

/** Prepend the API base URL (set by the app server) to an API path */
function apiUrl(path: string): string {
  const base = window.__BROWSEY_API_BASE__ || ''
  return base + path
}

const FAVORITES_KEY = 'browsey-favorites'

function getFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function setFavorites(favs: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]))
}

function toggleFavorite(absolutePath: string): boolean {
  const favs = getFavorites()
  if (favs.has(absolutePath)) {
    favs.delete(absolutePath)
    setFavorites(favs)
    return false
  }
  favs.add(absolutePath)
  setFavorites(favs)
  return true
}

function isFavorite(absolutePath: string): boolean {
  return getFavorites().has(absolutePath)
}

type FileItem = {
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  extension: string | null
  absolutePath: string
}

type ListResponse = {
  path: string
  absolutePath: string
  items: FileItem[]
}

type ViewResponse =
  | { type: 'text'; filename: string; extension: string | null; content: string; size: number }
  | { type: 'image'; filename: string; extension: string | null; url: string; size: number }

type StatResponse = {
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  created: string
  extension: string | null
}

type SearchResult = {
  name: string
  path: string
  absolutePath: string
  type: 'file' | 'directory'
  score: number
  extension: string | null
}

type GitStatusResponse = {
  isRepo: boolean
  branch: string | null
  isDirty: boolean
  staged: number
  unstaged: number
  untracked: number
  lastCommit: {
    hash: string
    shortHash: string
    author: string
    date: string
    message: string
  } | null
  remoteUrl: string | null
  repoRoot: string | null
}

type ImageNavContext = {
  paths: string[]
  index: number
}

type ViewerTarget = {
  container: HTMLElement
  content: HTMLElement
  filename: HTMLElement
  downloadBtn: HTMLElement
  closeBtn: HTMLElement
  prevBtn: HTMLButtonElement
  nextBtn: HTMLButtonElement
  fontDecreaseBtn: HTMLButtonElement
  fontIncreaseBtn: HTMLButtonElement
  isOverlay: boolean
}

function isTwoPaneMode(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches
}

// Extensions that can be viewed
const VIEWABLE_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'rb', 'php', 'pl', 'pm', 'lua', 'r',
  'go', 'rs', 'java', 'kt', 'kts', 'scala', 'clj', 'cljs',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'cs', 'fs', 'fsx',
  'swift', 'mm', 'm', 'zig', 'nim', 'v', 'odin',
  'sql', 'graphql', 'gql',
  'env', 'envrc', 'gitignore', 'gitattributes', 'dockerignore', 'editorconfig',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'properties',
  'log', 'diff', 'patch',
  'vue', 'svelte', 'astro',
  'ejs', 'erb', 'hbs', 'handlebars', 'mustache', 'pug', 'jade', 'njk', 'jinja', 'jinja2', 'twig',
])

const VIEWABLE_IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
])

// Map file extensions to highlight.js language names
const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  fs: 'fsharp',
  fsx: 'fsharp',
  swift: 'swift',
  mm: 'objectivec',
  m: 'objectivec',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',
  diff: 'diff',
  patch: 'diff',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  zig: 'zig',
  nim: 'nim',
  ejs: 'xml',
  erb: 'erb',
  hbs: 'xml',
  handlebars: 'xml',
  mustache: 'xml',
  pug: 'pug',
  jade: 'pug',
  njk: 'twig',
  jinja: 'twig',
  jinja2: 'twig',
  twig: 'twig',
}

function isViewable(extension: string | null): 'text' | 'image' | null {
  if (!extension) return null
  const ext = extension.toLowerCase()
  if (VIEWABLE_TEXT_EXTENSIONS.has(ext)) return 'text'
  if (VIEWABLE_IMAGE_EXTENSIONS.has(ext)) return 'image'
  return null
}

function getLanguage(extension: string | null): string | undefined {
  if (!extension) return undefined
  return LANGUAGE_MAP[extension.toLowerCase()]
}

function isIosStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof navigator === 'undefined') return false
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  if (!isIos) return false
  if ((navigator as Navigator & { standalone?: boolean }).standalone) return true
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false
}

class FileViewer {
  private overlayTarget: ViewerTarget
  private previewTarget: ViewerTarget
  private activeTarget: ViewerTarget
  private currentPath: string | null = null
  private imageNav: ImageNavContext | null = null
  private currentContentType: 'text' | 'image' | null = null
  private currentFontLevel: number = 3 // Default: 16px
  private readonly FONT_SIZES = [12, 14, 16, 18, 20, 22, 24]
  private readonly STORAGE_KEY = 'browsey-font-size'
  private onClose?: () => void
  private onNavigate?: (path: string) => void

  // Preload cache for adjacent images
  private viewCache = new Map<string, ViewResponse>()

  // Image zoom/pan state
  private imageZoom = 1
  private panX = 0
  private panY = 0
  private navHidden = false
  private pinchStartDist = 0
  private pinchStartZoom = 1
  private pinchStartPanX = 0
  private pinchStartPanY = 0
  private pinchMidX = 0
  private pinchMidY = 0
  private dragStartPanX = 0
  private dragStartPanY = 0

  constructor(onClose?: () => void, onNavigate?: (path: string) => void) {
    this.overlayTarget = {
      container: document.getElementById('viewer-overlay')!,
      content: document.getElementById('viewer-content')!,
      filename: document.getElementById('viewer-filename')!,
      downloadBtn: document.getElementById('viewer-download')!,
      closeBtn: document.getElementById('viewer-close')!,
      prevBtn: document.getElementById('viewer-prev') as HTMLButtonElement,
      nextBtn: document.getElementById('viewer-next') as HTMLButtonElement,
      fontDecreaseBtn: document.getElementById('viewer-font-decrease') as HTMLButtonElement,
      fontIncreaseBtn: document.getElementById('viewer-font-increase') as HTMLButtonElement,
      isOverlay: true,
    }

    this.previewTarget = {
      container: document.getElementById('preview-pane')!,
      content: document.getElementById('preview-content')!,
      filename: document.getElementById('preview-filename')!,
      downloadBtn: document.getElementById('preview-download')!,
      closeBtn: document.getElementById('preview-close')!,
      prevBtn: document.getElementById('preview-prev') as HTMLButtonElement,
      nextBtn: document.getElementById('preview-next') as HTMLButtonElement,
      fontDecreaseBtn: document.getElementById('preview-font-decrease') as HTMLButtonElement,
      fontIncreaseBtn: document.getElementById('preview-font-increase') as HTMLButtonElement,
      isOverlay: false,
    }

    this.activeTarget = this.overlayTarget
    this.onClose = onClose
    this.onNavigate = onNavigate

    this.loadFontPreference()
    this.setupEventListeners()
    this.setupMarked()
  }

  private bindTargetEvents(target: ViewerTarget): void {
    target.closeBtn.addEventListener('click', () => this.close())
    target.downloadBtn.addEventListener('click', () => this.download())
    target.prevBtn.addEventListener('click', () => this.navigatePrev())
    target.nextBtn.addEventListener('click', () => this.navigateNext())
    target.fontDecreaseBtn.addEventListener('click', () => this.decreaseFontSize())
    target.fontIncreaseBtn.addEventListener('click', () => this.increaseFontSize())
  }

  private setupEventListeners(): void {
    this.bindTargetEvents(this.overlayTarget)
    this.bindTargetEvents(this.previewTarget)

    this.overlayTarget.container.addEventListener('click', (event) => {
      if (event.target !== this.overlayTarget.container) return
      this.close()
    })

    // Close on ESC, navigate on arrows, font size with +/-
    document.addEventListener('keydown', (e) => {
      const overlayVisible = !this.overlayTarget.container.hidden
      const previewVisible = !this.previewTarget.container.hidden
      if (!overlayVisible && !previewVisible) return
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

    // Swipe handling for mobile (overlay only, single-finger only)
    let touchStartX = 0
    let touchStartY = 0
    let wasPinch = false
    this.overlayTarget.container.addEventListener('touchstart', (e) => {
      wasPinch = e.touches.length >= 2
      touchStartX = e.touches[0]?.clientX ?? 0
      touchStartY = e.touches[0]?.clientY ?? 0
    }, { passive: true })

    this.overlayTarget.container.addEventListener('touchend', (e) => {
      if (wasPinch || this.imageZoom > 1) return
      const touchEndX = e.changedTouches[0]?.clientX ?? 0
      const touchEndY = e.changedTouches[0]?.clientY ?? 0
      const deltaX = touchEndX - touchStartX
      const deltaY = touchEndY - touchStartY

      // Horizontal swipe for image navigation
      if (Math.abs(deltaX) > 80 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
        if (deltaX < 0) {
          this.navigateNext()
        } else {
          this.navigatePrev()
        }
        return
      }

      // Swipe down to close
      if (deltaY > 100 && this.activeTarget.content.scrollTop === 0) {
        this.close()
      }
    }, { passive: true })
  }

  private navigatePrev(): void {
    if (!this.imageNav || this.imageNav.index <= 0) return
    const newPath = this.imageNav.paths[this.imageNav.index - 1]
    if (!newPath) return
    this.onNavigate?.(newPath)
  }

  private navigateNext(): void {
    if (!this.imageNav || this.imageNav.index >= this.imageNav.paths.length - 1) return
    const newPath = this.imageNav.paths[this.imageNav.index + 1]
    if (!newPath) return
    this.onNavigate?.(newPath)
  }

  private hideAllControlButtons(): void {
    this.activeTarget.prevBtn.hidden = true
    this.activeTarget.nextBtn.hidden = true
    this.activeTarget.fontDecreaseBtn.hidden = true
    this.activeTarget.fontIncreaseBtn.hidden = true
  }

  private updateControlButtons(): void {
    const isImage = this.currentContentType === 'image'
    const isText = this.currentContentType === 'text'

    // Image navigation: show only for images with nav context
    const hasImageNav = isImage && this.imageNav !== null
    this.activeTarget.prevBtn.hidden = !hasImageNav
    this.activeTarget.nextBtn.hidden = !hasImageNav
    if (hasImageNav) {
      this.activeTarget.prevBtn.disabled = this.imageNav!.index <= 0
      this.activeTarget.nextBtn.disabled = this.imageNav!.index >= this.imageNav!.paths.length - 1
    }

    // Font controls: show only for text content
    this.activeTarget.fontDecreaseBtn.hidden = !isText
    this.activeTarget.fontIncreaseBtn.hidden = !isText
    if (isText) {
      this.updateFontButtons()
    }
  }

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
    const textContent = this.activeTarget.content.querySelector('.viewer-text, .viewer-markdown') as HTMLElement | null
    if (textContent) {
      textContent.style.fontSize = `${size}px`
    }
  }

  private updateFontButtons(): void {
    this.activeTarget.fontDecreaseBtn.disabled = this.currentFontLevel <= 1
    this.activeTarget.fontIncreaseBtn.disabled = this.currentFontLevel >= this.FONT_SIZES.length
  }

  private setupMarked(): void {
    // Configure marked to use highlight.js for code blocks
    marked.use(
      markedHighlight({
        langPrefix: 'hljs language-',
        highlight: (code: string, lang: string) => {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value
          }
          return hljs.highlightAuto(code).value
        },
      })
    )
  }

  async open(path: string, imageNav?: ImageNavContext, inline = false): Promise<void> {
    this.activeTarget = inline ? this.previewTarget : this.overlayTarget
    this.currentPath = path
    this.imageNav = imageNav ?? null
    this.currentContentType = null
    this.activeTarget.container.hidden = false
    this.activeTarget.content.innerHTML = '<div class="viewer-loading">Loading...</div>'
    this.activeTarget.filename.textContent = path.split('/').pop() || ''
    this.hideAllControlButtons()

    const cached = this.viewCache.get(path)
    if (cached) {
      this.render(cached)
      return
    }

    try {
      const response = await fetch(apiUrl(`/api/view?path=${encodeURIComponent(path)}`))
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load file')
      }

      const data: ViewResponse = await response.json()
      this.render(data)
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : 'Failed to load file')
    }
  }

  private render(data: ViewResponse): void {
    if (data.type === 'text') {
      this.renderText(data.content, data.extension, data.filename)
    } else if (data.type === 'image') {
      this.renderImage(data.url, data.filename, data.size)
    }
  }

  private renderText(content: string, extension: string | null, filename: string): void {
    this.currentContentType = 'text'
    const size = this.getCurrentFontSize()
    const isMarkdown = extension?.toLowerCase() === 'md' || extension?.toLowerCase() === 'markdown'

    if (isMarkdown) {
      // Extract YAML frontmatter and render it as a code block
      let frontmatterHtml = ''
      let body = content
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
      if (fmMatch) {
        const yaml = fmMatch[1] ?? ''
        const highlighted = hljs.getLanguage('yaml')
          ? hljs.highlight(yaml, { language: 'yaml' }).value
          : hljs.highlightAuto(yaml).value
        frontmatterHtml = `<div class="frontmatter"><pre><code class="hljs language-yaml">${highlighted}</code></pre></div>`
        body = content.slice(fmMatch[0].length)
      }
      // Render markdown
      const html = frontmatterHtml + (marked.parse(body) as string)
      this.activeTarget.content.innerHTML = `<div class="viewer-markdown" style="font-size: ${size}px">${html}</div>`
    } else {
      // Render with syntax highlighting
      const language = getLanguage(extension)
      let highlighted: string

      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(content, { language }).value
      } else {
        highlighted = hljs.highlightAuto(content).value
      }

      this.activeTarget.content.innerHTML = `<div class="viewer-text" style="font-size: ${size}px"><code class="hljs">${highlighted}</code></div>`
    }

    this.updateControlButtons()
  }

  private renderImage(url: string, filename: string, size: number): void {
    this.currentContentType = 'image'
    const imgSrc = apiUrl(url)
    const hasNav = this.imageNav !== null
    const prevDisabled = !hasNav || this.imageNav!.index <= 0
    const nextDisabled = !hasNav || this.imageNav!.index >= this.imageNav!.paths.length - 1
    this.activeTarget.content.innerHTML = `
      <div class="viewer-image">
        ${hasNav ? `<button class="image-nav-overlay image-nav-prev" aria-label="Previous image"${prevDisabled ? ' disabled' : ''}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>` : ''}
        <img src="${imgSrc}" alt="${this.escapeHtml(filename)}" />
        ${hasNav ? `<button class="image-nav-overlay image-nav-next" aria-label="Next image"${nextDisabled ? ' disabled' : ''}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>` : ''}
        <div class="image-info" id="image-info"></div>
      </div>
    `

    if (hasNav) {
      const prevBtn = this.activeTarget.content.querySelector('.image-nav-prev')
      const nextBtn = this.activeTarget.content.querySelector('.image-nav-next')
      prevBtn?.addEventListener('click', () => this.navigatePrev())
      nextBtn?.addEventListener('click', () => this.navigateNext())
    }

    const image = this.activeTarget.content.querySelector('img') as HTMLImageElement | null
    const infoEl = this.activeTarget.content.querySelector('.image-info')
    if (!image) return

    image.addEventListener('load', () => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (!width || !height) return
      if (infoEl) {
        infoEl.textContent = `${width} × ${height} · ${this.formatSize(size)}`
      }
    }, { once: true })

    // Reset zoom/pan state
    this.imageZoom = 1
    this.panX = 0
    this.panY = 0
    this.navHidden = false

    const CONTAINER_PADDING = 16

    const clampPan = () => {
      const container = image.parentElement!
      const cw = container.clientWidth
      const ch = container.clientHeight
      const iw = image.offsetWidth * this.imageZoom
      const ih = image.offsetHeight * this.imageZoom

      if (iw <= cw) {
        this.panX = 0
      } else {
        const maxPan = (iw - cw) / 2 + CONTAINER_PADDING
        this.panX = Math.max(-maxPan, Math.min(maxPan, this.panX))
      }

      if (ih <= ch) {
        this.panY = 0
      } else {
        const maxPan = (ih - ch) / 2 + CONTAINER_PADDING
        this.panY = Math.max(-maxPan, Math.min(maxPan, this.panY))
      }
    }

    const applyTransform = (animate = false) => {
      clampPan()
      image.style.transition = animate ? 'transform 0.2s ease' : 'none'
      if (this.imageZoom === 1 && this.panX === 0 && this.panY === 0) {
        image.style.transform = ''
      } else {
        image.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.imageZoom})`
      }
    }

    const resetZoomAndPan = () => {
      stopInertia()
      this.imageZoom = 1
      this.panX = 0
      this.panY = 0
      applyTransform(true)
    }

    const zoomTo2x = () => {
      stopInertia()
      this.imageZoom = 2
      this.panX = 0
      this.panY = 0
      applyTransform(true)
    }

    const toggleNav = () => {
      this.navHidden = !this.navHidden
      this.activeTarget.content.querySelectorAll('.image-nav-overlay').forEach((btn) => {
        btn.classList.toggle('nav-hidden', this.navHidden)
      })
      infoEl?.classList.toggle('info-hidden', this.navHidden)
    }

    // --- Gesture recognizer ---
    // Tracks taps, drags, and pinches on the image using raw touch/mouse events.
    // A "tap" is a pointer down+up with <6px movement and <300ms duration.
    // Two taps within 300ms = double-tap → zoom toggle.
    // Single tap (after 300ms timeout) → toggle nav arrows.
    // Drag (when zoomed) = pointer down + move >6px.
    // Pinch = two-finger touch.

    const TAP_THRESHOLD = 6
    const DOUBLE_TAP_MS = 300
    const INERTIA_FRICTION = 0.92
    const INERTIA_MIN_VELOCITY = 0.5
    let lastTapTime = 0
    let pointerDownX = 0
    let pointerDownY = 0
    let pointerDownTime = 0
    let didDrag = false
    let isPointerDown = false
    let lastTouchEnd = 0 // track touch→mouse suppression

    // Velocity tracking for inertia
    let lastMoveX = 0
    let lastMoveY = 0
    let lastMoveTime = 0
    let velocityX = 0
    let velocityY = 0
    let inertiaRaf = 0

    const stopInertia = () => {
      if (inertiaRaf) {
        cancelAnimationFrame(inertiaRaf)
        inertiaRaf = 0
      }
    }

    const startInertia = () => {
      stopInertia()
      if (Math.abs(velocityX) < INERTIA_MIN_VELOCITY && Math.abs(velocityY) < INERTIA_MIN_VELOCITY) return
      const step = () => {
        velocityX *= INERTIA_FRICTION
        velocityY *= INERTIA_FRICTION
        if (Math.abs(velocityX) < INERTIA_MIN_VELOCITY && Math.abs(velocityY) < INERTIA_MIN_VELOCITY) {
          inertiaRaf = 0
          return
        }
        this.panX += velocityX
        this.panY += velocityY
        applyTransform()
        inertiaRaf = requestAnimationFrame(step)
      }
      inertiaRaf = requestAnimationFrame(step)
    }

    const trackVelocity = (x: number, y: number) => {
      const now = performance.now()
      const dt = now - lastMoveTime
      if (dt > 0 && dt < 100) {
        velocityX = (x - lastMoveX) / dt * 16 // normalize to ~per-frame
        velocityY = (y - lastMoveY) / dt * 16
      } else {
        velocityX = 0
        velocityY = 0
      }
      lastMoveX = x
      lastMoveY = y
      lastMoveTime = now
    }

    const handleTap = () => {
      const now = Date.now()
      if (now - lastTapTime < DOUBLE_TAP_MS) {
        // Double-tap
        lastTapTime = 0
        if (this.imageZoom > 1) {
          resetZoomAndPan()
        } else {
          zoomTo2x()
        }
      } else {
        // Possible single-tap — wait to see if a second tap comes
        lastTapTime = now
        setTimeout(() => {
          if (lastTapTime === now) {
            lastTapTime = 0
            toggleNav()
          }
        }, DOUBLE_TAP_MS)
      }
    }

    // -- Mouse events (desktop, skip synthesized events from touch) --
    image.addEventListener('mousedown', (e) => {
      if (Date.now() - lastTouchEnd < 500) return // ignore synthesized mouse after touch
      e.preventDefault() // prevent native image drag
      pointerDownX = e.clientX
      pointerDownY = e.clientY
      pointerDownTime = Date.now()
      didDrag = false
      isPointerDown = true

      if (this.imageZoom > 1) {
        stopInertia()
        this.dragStartPanX = this.panX
        this.dragStartPanY = this.panY
        image.style.cursor = 'grabbing'
        lastMoveX = e.clientX
        lastMoveY = e.clientY
        lastMoveTime = performance.now()
        velocityX = 0
        velocityY = 0
      }

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - pointerDownX
        const dy = ev.clientY - pointerDownY
        if (!didDrag && Math.hypot(dx, dy) > TAP_THRESHOLD) didDrag = true
        if (didDrag && this.imageZoom > 1) {
          trackVelocity(ev.clientX, ev.clientY)
          this.panX = this.dragStartPanX + dx
          this.panY = this.dragStartPanY + dy
          applyTransform()
        }
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        isPointerDown = false
        image.style.cursor = this.imageZoom > 1 ? 'grab' : ''
        image.style.transition = ''

        if (!didDrag && Date.now() - pointerDownTime < 300) {
          handleTap()
        } else if (didDrag && this.imageZoom > 1) {
          startInertia()
        }
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    })

    // Suppress native click/dblclick — we handle taps ourselves
    image.addEventListener('click', (e) => e.preventDefault())
    image.addEventListener('dblclick', (e) => e.preventDefault())

    // -- Touch events (mobile) --
    let touchDragActive = false

    image.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        // Pinch start
        e.preventDefault()
        touchDragActive = false
        this.pinchStartDist = this.getTouchDistance(e.touches)
        this.pinchStartZoom = this.imageZoom
        this.pinchStartPanX = this.panX
        this.pinchStartPanY = this.panY
        this.pinchMidX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
        this.pinchMidY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
      } else if (e.touches.length === 1) {
        pointerDownX = e.touches[0]!.clientX
        pointerDownY = e.touches[0]!.clientY
        pointerDownTime = Date.now()
        didDrag = false
        touchDragActive = false
        if (this.imageZoom > 1) {
          stopInertia()
          this.dragStartPanX = this.panX
          this.dragStartPanY = this.panY
          lastMoveX = e.touches[0]!.clientX
          lastMoveY = e.touches[0]!.clientY
          lastMoveTime = performance.now()
          velocityX = 0
          velocityY = 0
        }
      }
    }, { passive: false })

    image.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        const dist = this.getTouchDistance(e.touches)
        const scale = dist / this.pinchStartDist
        this.imageZoom = Math.min(Math.max(this.pinchStartZoom * scale, 0.5), 5)
        const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
        const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
        this.panX = this.pinchStartPanX + (midX - this.pinchMidX)
        this.panY = this.pinchStartPanY + (midY - this.pinchMidY)
        applyTransform()
      } else if (e.touches.length === 1) {
        const dx = e.touches[0]!.clientX - pointerDownX
        const dy = e.touches[0]!.clientY - pointerDownY
        if (!didDrag && Math.hypot(dx, dy) > TAP_THRESHOLD) didDrag = true
        if (didDrag && this.imageZoom > 1) {
          if (!touchDragActive) {
            touchDragActive = true
          }
          e.preventDefault()
          trackVelocity(e.touches[0]!.clientX, e.touches[0]!.clientY)
          this.panX = this.dragStartPanX + dx
          this.panY = this.dragStartPanY + dy
          applyTransform()
        }
      }
    }, { passive: false })

    image.addEventListener('touchend', (e) => {
      lastTouchEnd = Date.now()
      if (e.touches.length === 0) {
        // Snap back if pinched below 1x
        if (this.imageZoom < 1) {
          resetZoomAndPan()
        } else if (this.imageZoom === 1) {
          this.panX = 0
          this.panY = 0
          applyTransform(true)
        }

        // Detect tap (no drag, short duration)
        if (!didDrag && !touchDragActive && Date.now() - pointerDownTime < 300) {
          handleTap()
        } else if (touchDragActive && this.imageZoom > 1) {
          startInertia()
        }
        touchDragActive = false
      }
    }, { passive: true })

    this.updateControlButtons()
    this.preloadAdjacentImages()
  }

  private getTouchDistance(touches: TouchList): number {
    const [a, b] = [touches[0]!, touches[1]!]
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  private preloadAdjacentImages(): void {
    if (!this.imageNav) return
    const { paths, index } = this.imageNav
    const neighbors = [paths[index - 1], paths[index + 1]].filter(
      (p): p is string => p !== undefined && !this.viewCache.has(p)
    )
    for (const path of neighbors) {
      fetch(apiUrl(`/api/view?path=${encodeURIComponent(path)}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((data: ViewResponse | null) => {
          if (!data || !this.imageNav) return
          this.viewCache.set(path, data)
          if (data.type === 'image') {
            const img = document.createElement('img')
            img.src = apiUrl(data.url)
          }
        })
        .catch(() => {})
    }
  }

  private renderError(message: string): void {
    this.activeTarget.content.innerHTML = `
      <div class="viewer-error">
        <div class="viewer-error-icon">${TriangleAlert}</div>
        <div>${this.escapeHtml(message)}</div>
      </div>
    `
  }

  close(): void {
    this.closeInternal(true)
  }

  closeSilently(): void {
    this.closeInternal(false)
  }

  private closeInternal(shouldNotify: boolean): void {
    this.activeTarget.container.hidden = true
    this.currentPath = null
    this.imageNav = null
    this.currentContentType = null
    this.viewCache.clear()
    this.activeTarget.content.innerHTML = ''
    this.updateControlButtons()
    if (!shouldNotify) return
    this.onClose?.()
  }

  get isInlineOpen(): boolean {
    return !this.previewTarget.container.hidden
  }

  get isOverlayOpen(): boolean {
    return !this.overlayTarget.container.hidden
  }

  get filePath(): string | null {
    return this.currentPath
  }

  private download(): void {
    if (!this.currentPath) return
    const a = document.createElement('a')
    a.href = apiUrl(`/api/file?path=${encodeURIComponent(this.currentPath)}`)
    a.download = this.currentPath.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

class InfoModal {
  private overlay: HTMLElement
  private content: HTMLElement
  private title: HTMLElement
  private closeBtn: HTMLElement

  constructor() {
    this.overlay = document.getElementById('info-overlay')!
    this.content = document.getElementById('info-content')!
    this.title = document.getElementById('info-title')!
    this.closeBtn = document.getElementById('info-close')!

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
    })
    this.overlay.addEventListener('click', (event) => {
      const modal = this.overlay.querySelector('.info-modal')
      if (modal && modal.contains(event.target as Node)) return
      this.close()
    })

    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.info-favorite-btn') as HTMLElement | null
      if (!btn) return
      const absPath = btn.getAttribute('data-absolute-path')
      if (!absPath) return
      const nowFav = toggleFavorite(absPath)
      btn.classList.toggle('active', nowFav)
      btn.querySelector('span')!.textContent = nowFav ? 'Remove from Favorites' : 'Add to Favorites'
      window.dispatchEvent(new CustomEvent('browsey-favorites-changed'))
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.hidden) {
        e.stopPropagation()
        this.close()
      }
    })
  }

  async open(path: string, absolutePath?: string): Promise<void> {
    if (!path) return

    this.overlay.hidden = false
    this.title.textContent = path.split('/').pop() || 'Info'
    this.content.innerHTML = '<div class="info-loading">Loading...</div>'

    try {
      const response = await fetch(apiUrl(`/api/stat?path=${encodeURIComponent(path)}`))
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load info')
      }

      const data: StatResponse = await response.json()
      this.render(data, absolutePath)
    } catch (error) {
      this.content.innerHTML = `<div class="info-error">${this.escapeHtml(error instanceof Error ? error.message : 'Failed to load')}</div>`
    }
  }

  private render(data: StatResponse, absolutePath?: string): void {
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Name', value: data.name },
      { label: 'Type', value: data.type === 'directory' ? 'Folder' : 'File' },
    ]

    if (data.type === 'file') {
      rows.push({ label: 'Size', value: this.formatSize(data.size) })
    }

    if (data.extension) {
      rows.push({ label: 'Extension', value: data.extension })
    }

    rows.push({ label: 'Modified', value: this.formatDateTime(data.modified) })
    rows.push({ label: 'Created', value: this.formatDateTime(data.created) })

    if (absolutePath) {
      rows.push({ label: 'Path', value: absolutePath })
    }

    this.content.innerHTML = rows
      .map(
        (row) => `
        <div class="info-row">
          <div class="info-label">${this.escapeHtml(row.label)}</div>
          <div class="info-value">${this.escapeHtml(row.value)}</div>
        </div>
      `
      )
      .join('')

    if (data.type === 'directory' && absolutePath) {
      const isFav = isFavorite(absolutePath)
      this.content.insertAdjacentHTML(
        'beforeend',
        `<button class="info-favorite-btn${isFav ? ' active' : ''}" data-absolute-path="${this.escapeHtml(absolutePath)}">
          ${Star}
          <span>${isFav ? 'Remove from Favorites' : 'Add to Favorites'}</span>
        </button>`
      )
    }
  }

  private close(): void {
    this.overlay.hidden = true
    this.content.innerHTML = ''
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  private formatDateTime(iso: string): string {
    const date = new Date(iso)
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

class SettingsModal {
  private overlay: HTMLElement
  private content: HTMLElement
  private closeBtn: HTMLElement
  private dynamicMode: boolean
  private onServerChange: () => void
  private onCompactModeChange: (compact: boolean) => void
  private onShowHiddenChange: (show: boolean) => void

  private static readonly COMPACT_MODE_KEY = 'browsey-compact-mode'
  private static readonly SHOW_HIDDEN_KEY = 'browsey-show-hidden'

  constructor(
    dynamicMode: boolean,
    onServerChange: () => void,
    onCompactModeChange: (compact: boolean) => void,
    onShowHiddenChange: (show: boolean) => void
  ) {
    this.dynamicMode = dynamicMode
    this.onServerChange = onServerChange
    this.onCompactModeChange = onCompactModeChange
    this.onShowHiddenChange = onShowHiddenChange
    this.overlay = document.getElementById('settings-overlay')!
    this.content = document.getElementById('settings-content')!
    this.closeBtn = document.getElementById('settings-close')!

    this.setupEventListeners()
  }

  static isCompactMode(): boolean {
    return localStorage.getItem(SettingsModal.COMPACT_MODE_KEY) === '1'
  }

  static isShowHidden(): boolean {
    return localStorage.getItem(SettingsModal.SHOW_HIDDEN_KEY) === '1'
  }

  private setCompactMode(compact: boolean): void {
    localStorage.setItem(SettingsModal.COMPACT_MODE_KEY, compact ? '1' : '0')
    this.onCompactModeChange(compact)
  }

  private setShowHidden(show: boolean): void {
    localStorage.setItem(SettingsModal.SHOW_HIDDEN_KEY, show ? '1' : '0')
    this.onShowHiddenChange(show)
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
    })
    this.overlay.addEventListener('click', (event) => {
      const modal = this.overlay.querySelector('.settings-modal')
      if (modal && modal.contains(event.target as Node)) return
      this.close()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.hidden) {
        e.stopPropagation()
        this.close()
      }
    })
  }

  open(): void {
    this.render()
    this.overlay.hidden = false
  }

  close(): void {
    this.overlay.hidden = true
    this.content.innerHTML = ''
  }

  private render(): void {
    const serverUrl = window.__BROWSEY_API_BASE__ || '—'
    const changeBtn = this.dynamicMode
      ? `<button class="settings-server-change" id="settings-change-server">Change</button>`
      : ''
    const isCompact = SettingsModal.isCompactMode()
    const isShowHidden = SettingsModal.isShowHidden()

    this.content.innerHTML = `
      <div class="settings-section-title">Server</div>
      <div class="settings-server-row">
        <span class="settings-server-dot"></span>
        <span class="settings-server-url">${this.escapeHtml(serverUrl)}</span>
        ${changeBtn}
      </div>
      <div class="settings-section-title" style="margin-top: 20px;">Display</div>
      <div class="settings-toggle-row">
        <span class="settings-toggle-label">Compact mode</span>
        <button class="settings-toggle ${isCompact ? 'active' : ''}" id="settings-compact-toggle" aria-pressed="${isCompact}">
          <span class="settings-toggle-knob"></span>
        </button>
      </div>
      <div class="settings-toggle-row">
        <span class="settings-toggle-label">Show hidden files</span>
        <button class="settings-toggle ${isShowHidden ? 'active' : ''}" id="settings-hidden-toggle" aria-pressed="${isShowHidden}">
          <span class="settings-toggle-knob"></span>
        </button>
      </div>
    `

    if (this.dynamicMode) {
      document.getElementById('settings-change-server')?.addEventListener('click', () => {
        this.close()
        this.onServerChange()
      })
    }

    document.getElementById('settings-compact-toggle')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      const isActive = btn.classList.toggle('active')
      btn.setAttribute('aria-pressed', String(isActive))
      this.setCompactMode(isActive)
    })

    document.getElementById('settings-hidden-toggle')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      const isActive = btn.classList.toggle('active')
      btn.setAttribute('aria-pressed', String(isActive))
      this.setShowHidden(isActive)
    })
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

class SearchOverlay {
  private overlay: HTMLElement
  private input: HTMLInputElement
  private results: HTMLElement
  private closeBtn: HTMLElement
  private debounceTimer: number | null = null
  private currentQuery = ''
  private searchPath = '/'
  private onNavigate: (path: string, highlightFile?: string) => void

  constructor(onNavigate: (path: string, highlightFile?: string) => void) {
    this.onNavigate = onNavigate
    this.overlay = document.getElementById('search-overlay')!
    this.input = document.getElementById('search-input') as HTMLInputElement
    this.results = document.getElementById('search-results')!
    this.closeBtn = document.getElementById('search-close')!

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.close())

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })

    this.input.addEventListener('input', () => {
      this.debounceSearch()
    })

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        this.selectFocusedResult()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.focusNextResult()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.focusPrevResult()
      }
    })

    this.results.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.search-result-item')
      if (item) {
        const path = item.getAttribute('data-path')
        const type = item.getAttribute('data-type')
        if (path) this.selectResult(path, type as 'file' | 'directory')
      }
    })

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (this.overlay.hidden) {
          this.open(this.searchPath)
        } else {
          this.close()
        }
      }
    })
  }

  open(currentPath: string): void {
    this.searchPath = currentPath
    this.overlay.hidden = false
    this.input.value = ''
    this.currentQuery = ''
    this.results.innerHTML = '<div class="search-hint">Type to search files...</div>'
    this.input.focus()
  }

  close(): void {
    this.overlay.hidden = true
    this.input.value = ''
    this.currentQuery = ''
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  setSearchPath(path: string): void {
    this.searchPath = path
  }

  private debounceSearch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = window.setTimeout(() => {
      this.performSearch()
    }, 150)
  }

  private async performSearch(): Promise<void> {
    const query = this.input.value.trim()

    if (query.length === 0) {
      this.results.innerHTML = '<div class="search-hint">Type to search files...</div>'
      this.currentQuery = ''
      return
    }

    if (query === this.currentQuery) return
    this.currentQuery = query

    this.results.innerHTML = '<div class="search-loading">Searching...</div>'

    try {
      const response = await fetch(
        apiUrl(`/api/search?path=${encodeURIComponent(this.searchPath)}&q=${encodeURIComponent(query)}&limit=50`)
      )

      if (!response.ok) {
        throw new Error('Search failed')
      }

      const data = await response.json()
      this.renderResults(data.results, query)
    } catch {
      this.results.innerHTML = '<div class="search-error">Search failed</div>'
    }
  }

  private renderResults(results: SearchResult[], query: string): void {
    if (results.length === 0) {
      this.results.innerHTML = '<div class="search-empty">No results found</div>'
      return
    }

    this.results.innerHTML = results
      .map((result, index) => {
        const icon = result.type === 'directory' ? Folder : File
        const highlightedName = this.highlightMatches(result.name, query)
        const parentPath = this.getParentPath(result.path)

        return `
          <div class="search-result-item"
               data-path="${this.escapeHtml(result.path)}"
               data-type="${result.type}"
               tabindex="0"
               ${index === 0 ? 'data-focused="true"' : ''}>
            <span class="search-result-icon" data-type="${result.type}">${icon}</span>
            <div class="search-result-info">
              <div class="search-result-name">${highlightedName}</div>
              <div class="search-result-path">${this.escapeHtml(parentPath)}</div>
            </div>
          </div>
        `
      })
      .join('')
  }

  private highlightMatches(text: string, query: string): string {
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let result = ''
    let queryIndex = 0

    for (let i = 0; i < text.length; i++) {
      if (queryIndex < lowerQuery.length && lowerText[i] === lowerQuery[queryIndex]) {
        result += `<mark>${this.escapeHtml(text[i]!)}</mark>`
        queryIndex++
      } else {
        result += this.escapeHtml(text[i]!)
      }
    }

    return result
  }

  private getParentPath(path: string): string {
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    return parts.length > 0 ? '/' + parts.join('/') : '/'
  }

  private selectResult(path: string, type: 'file' | 'directory'): void {
    this.close()

    // path is relative to searchPath, so we need to combine them
    const fullPath = this.searchPath === '/'
      ? path
      : this.searchPath + path

    if (type === 'directory') {
      this.onNavigate(fullPath)
    } else {
      const parentPath = this.getParentPath(fullPath)
      const fileName = fullPath.split('/').pop() || ''
      this.onNavigate(parentPath, fileName)
    }
  }

  private selectFocusedResult(): void {
    const focusedItem = this.results.querySelector('.search-result-item[data-focused="true"]')
    if (focusedItem) {
      const path = focusedItem.getAttribute('data-path')
      const type = focusedItem.getAttribute('data-type') as 'file' | 'directory'
      if (path) this.selectResult(path, type)
    }
  }

  private focusNextResult(): void {
    const items = this.results.querySelectorAll('.search-result-item')
    const focused = this.results.querySelector('[data-focused="true"]')
    const focusedIndex = Array.from(items).indexOf(focused as Element)
    const nextIndex = Math.min(focusedIndex + 1, items.length - 1)
    this.setFocusedResult(items, nextIndex)
  }

  private focusPrevResult(): void {
    const items = this.results.querySelectorAll('.search-result-item')
    const focused = this.results.querySelector('[data-focused="true"]')
    const focusedIndex = Array.from(items).indexOf(focused as Element)
    const prevIndex = Math.max(focusedIndex - 1, 0)
    this.setFocusedResult(items, prevIndex)
  }

  private setFocusedResult(items: NodeListOf<Element>, index: number): void {
    items.forEach((item, i) => {
      if (i === index) {
        item.setAttribute('data-focused', 'true')
        ;(item as HTMLElement).scrollIntoView({ block: 'nearest' })
      } else {
        item.removeAttribute('data-focused')
      }
    })
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

type CommitInfo = {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

type GitLogResponse = {
  commits: CommitInfo[]
  hasMore: boolean
}

class GitHistoryOverlay {
  private overlay: HTMLElement
  private list: HTMLElement
  private closeBtn: HTMLElement
  private currentPath: string = '/'
  private commits: CommitInfo[] = []
  private isLoading = false
  private hasMore = true
  private onCopyHash?: (hash: string) => void

  constructor(onCopyHash?: (hash: string) => void) {
    this.onCopyHash = onCopyHash
    this.overlay = document.getElementById('git-history-overlay')!
    this.list = document.getElementById('git-history-list')!
    this.closeBtn = document.getElementById('git-history-close')!

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.hidden) {
        this.close()
      }
    })

    // Copy hash on click
    this.list.addEventListener('click', (e) => {
      const hashBtn = (e.target as HTMLElement).closest('.git-history-hash')
      if (hashBtn) {
        const hash = hashBtn.getAttribute('data-hash')
        if (hash) this.onCopyHash?.(hash)
      }
    })

    // Infinite scroll
    this.list.addEventListener('scroll', () => {
      if (this.isLoading || !this.hasMore) return
      const { scrollTop, scrollHeight, clientHeight } = this.list
      if (scrollHeight - scrollTop - clientHeight < 100) {
        this.loadMore()
      }
    })
  }

  async open(path: string): Promise<void> {
    this.currentPath = path
    this.commits = []
    this.hasMore = true
    this.overlay.hidden = false
    this.list.innerHTML = '<div class="git-history-loading">Loading commits...</div>'

    await this.loadMore()
  }

  close(): void {
    this.overlay.hidden = true
    this.commits = []
    this.hasMore = true
    this.isLoading = false
  }

  private async loadMore(): Promise<void> {
    if (this.isLoading || !this.hasMore) return
    this.isLoading = true

    // Show loading indicator if we already have commits
    if (this.commits.length > 0) {
      this.list.insertAdjacentHTML('beforeend', '<div class="git-history-loading-more" id="git-history-loading-more">Loading more...</div>')
    }

    try {
      const skip = this.commits.length
      const response = await fetch(apiUrl(`/api/git/log?path=${encodeURIComponent(this.currentPath)}&limit=25&skip=${skip}`))

      if (!response.ok) {
        throw new Error('Failed to load commits')
      }

      const data: GitLogResponse = await response.json()
      this.commits.push(...data.commits)
      this.hasMore = data.hasMore

      this.render()
    } catch (error) {
      if (this.commits.length === 0) {
        this.list.innerHTML = `<div class="git-history-error">${error instanceof Error ? error.message : 'Failed to load commits'}</div>`
      } else {
        // Remove loading indicator on error
        document.getElementById('git-history-loading-more')?.remove()
      }
    } finally {
      this.isLoading = false
    }
  }

  private render(): void {
    if (this.commits.length === 0) {
      this.list.innerHTML = '<div class="git-history-empty">No commits found</div>'
      return
    }

    const html = this.commits.map((commit) => {
      const date = new Date(commit.date)
      const formattedDate = date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

      return `
        <div class="git-history-item">
          <div class="git-history-message">${this.escapeHtml(commit.message)}</div>
          <div class="git-history-meta">
            <button class="git-history-hash" data-hash="${this.escapeHtml(commit.hash)}">${this.escapeHtml(commit.shortHash)}</button>
            <span class="git-history-author">${this.escapeHtml(commit.author)}</span>
            <span class="git-history-date">${formattedDate}</span>
          </div>
        </div>
      `
    }).join('')

    this.list.innerHTML = html
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

type GitChangeFile = {
  path: string
  indexStatus: string
  workTreeStatus: string
}

type GitChangesResponse = {
  staged: GitChangeFile[]
  unstaged: GitChangeFile[]
  untracked: GitChangeFile[]
}

type TreeNode = {
  name: string
  isDir: boolean
  children: Map<string, TreeNode>
  file?: GitChangeFile
  statusLabel?: string
}

class GitChangesOverlay {
  private overlay: HTMLElement
  private content: HTMLElement
  private closeBtn: HTMLElement
  private currentPath: string = '/'

  constructor() {
    this.overlay = document.getElementById('git-changes-overlay')!
    this.content = document.getElementById('git-changes-content')!
    this.closeBtn = document.getElementById('git-changes-close')!

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.hidden) {
        this.close()
      }
    })

    // Delegate click events for collapsible sections and directories
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement

      // Section header toggle
      const sectionHeader = target.closest('.git-changes-section-header')
      if (sectionHeader) {
        const section = sectionHeader.closest('.git-changes-section')
        if (!section) return
        const body = section.querySelector('.git-changes-section-body')
        const chevron = sectionHeader.querySelector('.git-changes-section-chevron')
        if (body && chevron) {
          body.classList.toggle('collapsed')
          chevron.classList.toggle('collapsed')
        }
        return
      }

      // Directory tree item toggle
      const dirItem = target.closest('.git-changes-tree-item.directory')
      if (dirItem) {
        const childContainer = dirItem.nextElementSibling
        const chevron = dirItem.querySelector('.git-changes-tree-chevron')
        if (childContainer && chevron) {
          childContainer.classList.toggle('collapsed')
          chevron.classList.toggle('collapsed')
        }
      }
    })
  }

  async open(path: string): Promise<void> {
    this.currentPath = path
    this.overlay.hidden = false
    this.content.innerHTML = '<div class="git-changes-loading">Loading changes...</div>'

    try {
      const response = await fetch(apiUrl(`/api/git/changes?path=${encodeURIComponent(path)}`))
      if (!response.ok) {
        throw new Error('Failed to load changes')
      }

      const data: GitChangesResponse = await response.json()
      this.render(data)
    } catch (error) {
      this.content.innerHTML = `<div class="git-changes-error">${error instanceof Error ? error.message : 'Failed to load changes'}</div>`
    }
  }

  close(): void {
    this.overlay.hidden = true
    this.content.innerHTML = ''
  }

  private render(data: GitChangesResponse): void {
    const hasAny = data.staged.length > 0 || data.unstaged.length > 0 || data.untracked.length > 0

    if (!hasAny) {
      this.content.innerHTML = '<div class="git-changes-empty">No changes</div>'
      return
    }

    const sections: string[] = []

    if (data.staged.length > 0) {
      sections.push(this.renderSection('Staged', 'staged', data.staged, (f) => f.indexStatus))
    }
    if (data.unstaged.length > 0) {
      sections.push(this.renderSection('Modified', 'unstaged', data.unstaged, (f) => f.workTreeStatus))
    }
    if (data.untracked.length > 0) {
      sections.push(this.renderSection('Untracked', 'untracked', data.untracked, () => '?'))
    }

    this.content.innerHTML = sections.join('')
  }

  private renderSection(
    label: string,
    cssClass: string,
    files: GitChangeFile[],
    getStatus: (f: GitChangeFile) => string
  ): string {
    const tree = this.buildTree(files, getStatus)
    const treeHtml = this.renderTree(tree, 0, cssClass === 'untracked')

    return `
      <div class="git-changes-section">
        <div class="git-changes-section-header">
          <svg class="git-changes-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span class="git-changes-section-label ${cssClass}">${label}</span>
          <span class="git-changes-section-count">${files.length}</span>
        </div>
        <div class="git-changes-section-body">
          ${treeHtml}
        </div>
      </div>
    `
  }

  private buildTree(files: GitChangeFile[], getStatus: (f: GitChangeFile) => string): TreeNode {
    const root: TreeNode = { name: '', isDir: true, children: new Map() }

    for (const file of files) {
      const parts = file.path.split('/')
      let current = root

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        const isLast = i === parts.length - 1

        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            isDir: !isLast,
            children: new Map(),
            file: isLast ? file : undefined,
            statusLabel: isLast ? getStatus(file) : undefined,
          })
        }

        current = current.children.get(part)!
      }
    }

    // Collapse single-child directory chains
    this.collapseTree(root)
    return root
  }

  private collapseTree(node: TreeNode): void {
    for (const [key, child] of node.children) {
      this.collapseTree(child)

      // Collapse: if a directory has exactly one child that is also a directory
      if (child.isDir && child.children.size === 1) {
        const [grandchildKey, grandchild] = child.children.entries().next().value as [string, TreeNode]
        if (grandchild.isDir) {
          // Merge names: "src" + "ui" -> "src/ui"
          const mergedName = child.name + '/' + grandchild.name
          grandchild.name = mergedName
          node.children.delete(key)
          node.children.set(mergedName, grandchild)
        }
      }
    }
  }

  private renderTree(node: TreeNode, depth: number, isUntracked: boolean): string {
    // Sort: directories first, then alphabetically
    const entries = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return entries.map((child) => {
      if (child.isDir) {
        return this.renderDirNode(child, depth, isUntracked)
      }
      return this.renderFileNode(child, depth, isUntracked)
    }).join('')
  }

  private renderDirNode(node: TreeNode, depth: number, isUntracked: boolean): string {
    const indentHtml = Array(depth).fill('<span class="git-changes-tree-indent"></span>').join('')
    const childrenHtml = this.renderTree(node, depth + 1, isUntracked)

    return `
      <div class="git-changes-tree-item directory" style="padding-left: ${16 + depth * 16}px">
        ${indentHtml}
        <svg class="git-changes-tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        <svg class="git-changes-tree-icon folder" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="git-changes-tree-name directory">${this.escapeHtml(node.name)}</span>
      </div>
      <div class="git-changes-tree-children">
        ${childrenHtml}
      </div>
    `
  }

  private renderFileNode(node: TreeNode, depth: number, isUntracked: boolean): string {
    const indentHtml = Array(depth).fill('<span class="git-changes-tree-indent"></span>').join('')
    const status = node.statusLabel || '?'
    const statusClass = isUntracked ? 'untracked' : status

    return `
      <div class="git-changes-tree-item" style="padding-left: ${16 + depth * 16}px">
        ${indentHtml}
        <span class="git-changes-tree-indent"></span>
        <svg class="git-changes-tree-icon file" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="git-changes-tree-name">${this.escapeHtml(node.name)}</span>
        <span class="git-changes-tree-status ${this.escapeHtml(statusClass)}">${this.escapeHtml(status)}</span>
      </div>
    `
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

class GitStatusBar {
  private statusBar: HTMLElement
  private branchEl: HTMLElement
  private stateEl: HTMLElement
  private lastCommitEl: HTMLElement
  private infoBtn: HTMLElement
  private historyBtn: HTMLElement
  private modalOverlay: HTMLElement
  private modalContent: HTMLElement
  private modalCloseBtn: HTMLElement
  private currentStatus: GitStatusResponse | null = null
  private currentPath: string = '/'
  private onOpenHistory?: (path: string) => void
  private onOpenChanges?: (path: string) => void
  private gitIcon: HTMLElement

  constructor(onOpenHistory?: (path: string) => void, onOpenChanges?: (path: string) => void) {
    this.statusBar = document.getElementById('git-status-bar')!
    this.branchEl = document.getElementById('git-branch')!
    this.stateEl = document.getElementById('git-state')!
    this.lastCommitEl = document.getElementById('git-last-commit')!
    this.infoBtn = document.getElementById('git-info-btn')!
    this.historyBtn = document.getElementById('git-history-btn')!
    this.modalOverlay = document.getElementById('git-modal-overlay')!
    this.modalContent = document.getElementById('git-modal-content')!
    this.modalCloseBtn = document.getElementById('git-modal-close')!
    this.gitIcon = this.statusBar.querySelector('.git-icon')!
    this.onOpenHistory = onOpenHistory
    this.onOpenChanges = onOpenChanges

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.infoBtn.addEventListener('click', () => this.openModal())
    this.historyBtn.addEventListener('click', () => this.openHistory())
    this.modalCloseBtn.addEventListener('click', () => this.closeModal())
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.closeModal()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modalOverlay.hidden) {
        this.closeModal()
      }
    })

    // Delegate click for history button in modal
    this.modalContent.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.git-modal-history-btn')) {
        this.closeModal()
        this.openHistory()
      }
    })

    // Click git icon or dirty state to open changes overlay
    this.gitIcon.addEventListener('click', () => this.openChanges())
    this.stateEl.addEventListener('click', () => {
      if (this.currentStatus?.isDirty) {
        this.openChanges()
      }
    })
  }

  private openHistory(): void {
    if (this.onOpenHistory) {
      this.onOpenHistory(this.currentPath)
    }
  }

  private openChanges(): void {
    if (this.onOpenChanges && this.currentStatus?.isDirty) {
      this.onOpenChanges(this.currentPath)
    }
  }

  async update(path: string): Promise<void> {
    this.currentPath = path
    try {
      const response = await fetch(apiUrl(`/api/git?path=${encodeURIComponent(path)}`))
      if (!response.ok) {
        this.hide()
        return
      }

      const status: GitStatusResponse = await response.json()
      this.currentStatus = status

      if (!status.isRepo) {
        this.hide()
        return
      }

      this.render(status)
      this.show()
    } catch {
      this.hide()
    }
  }

  private render(status: GitStatusResponse): void {
    this.branchEl.textContent = status.branch || 'unknown'

    if (status.isDirty) {
      const parts: string[] = []
      if (status.staged > 0) parts.push(`+${status.staged}`)
      if (status.unstaged > 0) parts.push(`~${status.unstaged}`)
      if (status.untracked > 0) parts.push(`?${status.untracked}`)
      this.stateEl.textContent = parts.join(' ')
      this.stateEl.className = 'git-state dirty'
    } else {
      this.stateEl.textContent = 'clean'
      this.stateEl.className = 'git-state clean'
    }

    if (status.lastCommit) {
      this.lastCommitEl.innerHTML =
        `<span class="git-last-hash">${this.escapeHtml(status.lastCommit.shortHash)}</span> ` +
        `<span class="git-last-message">${this.escapeHtml(status.lastCommit.message)}</span>`
      this.lastCommitEl.hidden = false
    } else {
      this.lastCommitEl.hidden = true
    }
  }

  private show(): void {
    this.statusBar.hidden = false
  }

  private hide(): void {
    this.statusBar.hidden = true
    this.currentStatus = null
  }

  private openModal(): void {
    if (!this.currentStatus) return
    this.renderModal(this.currentStatus)
    this.modalOverlay.hidden = false
  }

  private closeModal(): void {
    this.modalOverlay.hidden = true
  }

  private renderModal(status: GitStatusResponse): void {
    const sections: string[] = []

    // Branch section
    sections.push(`
      <div class="git-section">
        <div class="git-section-title">Branch</div>
        <div class="git-section-content">${this.escapeHtml(status.branch || 'unknown')}</div>
      </div>
    `)

    // Status section
    const hasChanges = status.staged > 0 || status.unstaged > 0 || status.untracked > 0
    sections.push(`
      <div class="git-section">
        <div class="git-section-title">Working Tree</div>
        <div class="git-section-content">
          ${hasChanges ? `
            <div class="git-status-counts">
              ${status.staged > 0 ? `<span class="git-status-count staged">${status.staged} staged</span>` : ''}
              ${status.unstaged > 0 ? `<span class="git-status-count unstaged">${status.unstaged} modified</span>` : ''}
              ${status.untracked > 0 ? `<span class="git-status-count untracked">${status.untracked} untracked</span>` : ''}
            </div>
          ` : '<span class="git-state clean">Clean</span>'}
        </div>
      </div>
    `)

    // Last commit section
    if (status.lastCommit) {
      const commitDate = new Date(status.lastCommit.date)
      const formattedDate = commitDate.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

      sections.push(`
        <div class="git-section">
          <div class="git-section-title">Last Commit</div>
          <div class="git-section-content">
            <div class="git-row">
              <span class="git-row-label">Hash</span>
              <span class="git-row-value">${this.escapeHtml(status.lastCommit.shortHash)}</span>
            </div>
            <div class="git-row">
              <span class="git-row-label">Author</span>
              <span class="git-row-value">${this.escapeHtml(status.lastCommit.author)}</span>
            </div>
            <div class="git-row">
              <span class="git-row-label">Date</span>
              <span class="git-row-value">${formattedDate}</span>
            </div>
            <div class="git-row">
              <span class="git-row-label">Message</span>
              <span class="git-row-value git-commit-message">${this.escapeHtml(status.lastCommit.message)}</span>
            </div>
          </div>
        </div>
      `)
    }

    // Remote URL section
    if (status.remoteUrl) {
      sections.push(`
        <div class="git-section">
          <div class="git-section-title">Remote</div>
          <div class="git-section-content">
            <div class="git-remote-url">${this.escapeHtml(status.remoteUrl)}</div>
          </div>
        </div>
      `)
    }

    // View History button
    sections.push(`
      <button class="git-modal-history-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        View Commit History
      </button>
    `)

    this.modalContent.innerHTML = sections.join('')
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

class QRScanner {
  private overlay: HTMLElement
  private video: HTMLVideoElement
  private cancelBtn: HTMLElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private stream: MediaStream | null = null
  private scanTimer: number | null = null
  private onDetect: (url: string) => void
  private onCancel: () => void

  constructor(onDetect: (url: string) => void, onCancel: () => void) {
    this.onDetect = onDetect
    this.onCancel = onCancel
    this.overlay = document.getElementById('qr-overlay')!
    this.video = document.getElementById('qr-video') as HTMLVideoElement
    this.cancelBtn = document.getElementById('qr-cancel-btn')!
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!

    this.cancelBtn.addEventListener('click', () => this.close())
  }

  static isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia)
  }

  async open(): Promise<void> {
    this.overlay.hidden = false

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      this.video.srcObject = this.stream
      await this.video.play()
      this.startDetection()
    } catch {
      this.close()
    }
  }

  close(): void {
    this.stopScanning()
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    this.video.srcObject = null
    this.overlay.hidden = true
    this.onCancel()
  }

  private startDetection(): void {
    const scan = () => {
      if (!this.stream || this.video.readyState < this.video.HAVE_ENOUGH_DATA) {
        this.scanTimer = window.setTimeout(scan, 100)
        return
      }

      this.canvas.width = this.video.videoWidth
      this.canvas.height = this.video.videoHeight
      this.ctx.drawImage(this.video, 0, 0)
      const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)

      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      })

      if (code?.data) {
        this.stopAndNotify(code.data)
        return
      }

      this.scanTimer = window.setTimeout(scan, 100)
    }

    scan()
  }

  private stopScanning(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }

  private stopAndNotify(url: string): void {
    this.stopScanning()
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    this.video.srcObject = null
    this.overlay.hidden = true
    this.onDetect(url)
  }
}

class ConnectScreen {
  private screen: HTMLElement
  private form: HTMLFormElement
  private input: HTMLInputElement
  private connectBtn: HTMLButtonElement
  private scanBtn: HTMLElement
  private errorEl: HTMLElement
  private savedContainer: HTMLElement
  private savedBtn: HTMLElement
  private savedUrlEl: HTMLElement
  private scanner: QRScanner | null = null
  private onConnect: (url: string) => void

  private static readonly STORAGE_KEY = 'browsey-api-url'

  constructor(onConnect: (url: string) => void) {
    this.onConnect = onConnect
    this.screen = document.getElementById('connect-screen')!
    this.form = document.getElementById('connect-form') as HTMLFormElement
    this.input = document.getElementById('connect-input') as HTMLInputElement
    this.connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
    this.scanBtn = document.getElementById('connect-scan-btn')!
    this.errorEl = document.getElementById('connect-error')!
    this.savedContainer = document.getElementById('connect-saved-container')!
    this.savedBtn = document.getElementById('connect-saved-btn')!
    this.savedUrlEl = document.getElementById('connect-saved-url')!

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault()
      this.connect(this.input.value)
    })

    this.savedBtn.addEventListener('click', () => {
      const saved = ConnectScreen.getSavedUrl()
      if (saved) this.connect(saved)
    })

    if (QRScanner.isSupported()) {
      this.scanBtn.hidden = false
      this.scanBtn.addEventListener('click', () => this.openScanner())
    }
  }

  show(error?: string): void {
    // Hide main UI elements
    document.querySelector('.header')?.setAttribute('hidden', '')
    document.getElementById('git-status-bar')?.setAttribute('hidden', '')
    document.getElementById('file-list')?.setAttribute('hidden', '')

    this.screen.hidden = false
    this.errorEl.hidden = !error
    if (error) {
      this.errorEl.textContent = error
    }

    // Show saved URL as quick-connect option
    const saved = ConnectScreen.getSavedUrl()
    if (saved) {
      this.savedContainer.hidden = false
      this.savedUrlEl.textContent = saved
    } else {
      this.savedContainer.hidden = true
    }

    this.input.focus()
  }

  hide(): void {
    this.screen.hidden = true

    // Restore main UI elements
    document.querySelector('.header')?.removeAttribute('hidden')
    document.getElementById('file-list')?.removeAttribute('hidden')
  }

  private async connect(rawUrl: string): Promise<void> {
    const url = this.normalizeUrl(rawUrl)
    if (!url) {
      this.showError('Please enter a valid URL')
      return
    }

    this.setLoading(true)
    this.hideError()

    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new Error('Server responded with an error')
      }
    } catch {
      this.setLoading(false)
      this.showError('Could not connect to API server')
      return
    }

    this.setLoading(false)
    ConnectScreen.saveUrl(url)
    window.__BROWSEY_API_BASE__ = url
    this.hide()
    this.onConnect(url)
  }

  private openScanner(): void {
    this.scanner = new QRScanner(
      (detectedUrl) => {
        this.scanner = null
        this.connect(detectedUrl)
      },
      () => {
        this.scanner = null
      }
    )
    this.scanner.open()
  }

  private normalizeUrl(raw: string): string {
    let url = raw.trim()
    if (!url) return ''
    url = url.replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url
    }
    try {
      new URL(url) // validate
      return url
    } catch {
      return ''
    }
  }

  private setLoading(loading: boolean): void {
    this.connectBtn.disabled = loading
    this.connectBtn.textContent = loading ? 'Connecting...' : 'Connect'
  }

  private showError(message: string): void {
    this.errorEl.textContent = message
    this.errorEl.hidden = false
  }

  private hideError(): void {
    this.errorEl.hidden = true
  }

  static getSavedUrl(): string | null {
    return localStorage.getItem(ConnectScreen.STORAGE_KEY)
  }

  static saveUrl(url: string): void {
    localStorage.setItem(ConnectScreen.STORAGE_KEY, url)
  }

  static clearUrl(): void {
    localStorage.removeItem(ConnectScreen.STORAGE_KEY)
  }
}

class FileBrowser {
  private currentPath = '/'
  private currentAbsolutePath = ''
  private currentItems: FileItem[] = []
  private scrollPositions = new Map<string, number>()
  private fileList: HTMLElement
  private pathDisplay: HTMLElement
  private loading: HTMLElement
  private toast: HTMLElement
  private useQueryRouting = false
  private pullStartY: number | null = null
  private pullTriggered = false
  private pullRefreshIndicator: HTMLElement
  private isRefreshing = false
  private viewer: FileViewer
  private infoModal: InfoModal
  private searchOverlay: SearchOverlay
  private gitHistoryOverlay: GitHistoryOverlay
  private gitChangesOverlay: GitChangesOverlay
  private gitStatusBar: GitStatusBar
  private settingsModal: SettingsModal
  private highlightedFile: string | null = null
  private dynamicMode: boolean
  private selectedFilePath: string | null = null
  private previewPane: HTMLElement
  private previewHeader: HTMLElement

  constructor(dynamicMode = false) {
    this.dynamicMode = dynamicMode
    this.fileList = document.getElementById('file-list')!
    this.pathDisplay = document.getElementById('path-display')!
    this.loading = document.getElementById('loading')!
    this.toast = document.getElementById('toast')!
    this.previewPane = document.getElementById('preview-pane')!
    this.previewHeader = document.getElementById('preview-header')!
    this.pullRefreshIndicator = document.getElementById('pull-refresh-indicator')!
    this.useQueryRouting = isIosStandalone()
    this.viewer = new FileViewer(
      () => this.handleViewerClose(),
      (path) => this.handleViewerNavigate(path)
    )
    this.infoModal = new InfoModal()
    this.searchOverlay = new SearchOverlay(
      (path, highlightFile) => this.handleSearchNavigation(path, highlightFile)
    )
    this.gitHistoryOverlay = new GitHistoryOverlay((hash) => this.copyToClipboard(hash, 'Hash copied'))
    this.gitChangesOverlay = new GitChangesOverlay()
    this.gitStatusBar = new GitStatusBar(
      (path) => this.gitHistoryOverlay.open(path),
      (path) => this.gitChangesOverlay.open(path)
    )
    this.settingsModal = new SettingsModal(
      this.dynamicMode,
      () => this.handleServerChange(),
      (compact) => this.applyCompactMode(compact),
      () => this.navigate(this.currentPath, { updateHistory: false })
    )
    this.applyCompactMode(SettingsModal.isCompactMode())

    this.setupEventListeners()
    this.setupPullToRefresh()
    window.addEventListener('popstate', () => this.handlePopState())
    window.matchMedia('(min-width: 1024px)').addEventListener('change', (e) => {
      this.handleLayoutChange(e.matches)
    })
    this.loadFromLocation()
  }

  private handleSearchNavigation(path: string, highlightFile?: string): void {
    this.highlightedFile = highlightFile || null
    this.navigate(path)
  }

  private getImageNavContext(imagePath: string): ImageNavContext | undefined {
    const imagePaths = this.currentItems
      .filter((item) => item.type === 'file' && isViewable(item.extension) === 'image')
      .map((item) => (this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`))

    const index = imagePaths.indexOf(imagePath)
    if (index === -1 || imagePaths.length <= 1) return undefined

    return { paths: imagePaths, index }
  }

  private handleViewerNavigate(path: string): void {
    const nav = this.getImageNavContext(path)
    if (!nav) return
    const inline = isTwoPaneMode()
    this.viewer.open(path, nav, inline)
    if (inline) {
      this.selectedFilePath = path
      this.updateSelectedFileHighlight()
    }
    this.updateHistory(path, true, true)
  }

  private setupEventListeners(): void {
    document.getElementById('btn-back')?.addEventListener('click', () => this.goUp())
    document.getElementById('btn-settings')?.addEventListener('click', () => this.settingsModal.open())
    document.getElementById('btn-search')?.addEventListener('click', () => {
      this.searchOverlay.open(this.currentPath)
    })

    // File item clicks (delegated)
    this.fileList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement

      // Handle info button
      const infoBtn = target.closest('.info')
      if (infoBtn) {
        e.stopPropagation()
        const path = infoBtn.getAttribute('data-path')
        const absolutePath = infoBtn.getAttribute('data-absolute-path')
        if (path) this.infoModal.open(path, absolutePath || undefined)
        return
      }

      // Handle copy button
      const copyBtn = target.closest('.copy')
      if (copyBtn) {
        e.stopPropagation()
        const absolutePath = copyBtn.getAttribute('data-absolute-path')
        if (absolutePath) this.copyPath(absolutePath)
        return
      }

      // Handle item click (navigate, view, or download)
      const item = target.closest('.file-item') as HTMLElement
      if (item) {
        const path = item.getAttribute('data-path')
        if (!path) return // Virtual "." item has no path, ignore clicks
        const type = item.getAttribute('data-type')!
        const extension = item.getAttribute('data-extension') || null
        this.handleItemClick(path, type as 'file' | 'directory', extension)
      }
    })

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') this.goUp()
    })

    // Re-render when favorites change (toggled from InfoModal)
    window.addEventListener('browsey-favorites-changed', () => {
      if (this.currentItems.length > 0) {
        this.renderItems(this.currentItems)
      }
    })
  }

  private setupPullToRefresh(): void {
    const threshold = 80
    const maxPull = 120
    let currentPullDelta = 0
    let hapticTriggered = false

    this.fileList.addEventListener(
      'touchstart',
      (event) => {
        if (this.fileList.scrollTop !== 0 || this.isRefreshing) return
        this.pullStartY = event.touches[0]?.clientY ?? null
        this.pullTriggered = false
        hapticTriggered = false
        currentPullDelta = 0
        this.pullRefreshIndicator.classList.remove('active', 'refreshing')
      },
      { passive: true }
    )

    this.fileList.addEventListener(
      'touchmove',
      (event) => {
        if (this.pullStartY === null || this.isRefreshing) return
        if (this.fileList.scrollTop > 0) {
          this.pullStartY = null
          this.pullRefreshIndicator.style.transform = 'translateY(-100%)'
          return
        }

        const currentY = event.touches[0]?.clientY ?? 0
        const delta = currentY - this.pullStartY

        if (delta <= 0) {
          this.pullRefreshIndicator.style.transform = 'translateY(-100%)'
          currentPullDelta = 0
          return
        }

        // Calculate progress (0 to 1) with resistance
        const resistance = 0.5
        const adjustedDelta = Math.min(delta * resistance, maxPull)
        currentPullDelta = adjustedDelta
        const progress = Math.min(adjustedDelta / threshold, 1)

        // Position indicator (starts hidden, moves down)
        const translateY = adjustedDelta - 36 // 36 is indicator height
        this.pullRefreshIndicator.style.transform = `translateY(${translateY}px)`

        // Rotate spinner based on progress (0 to 270 degrees)
        const spinner = this.pullRefreshIndicator.querySelector('.pull-refresh-spinner') as HTMLElement
        if (spinner) {
          spinner.style.transform = `rotate(${progress * 270}deg)`
        }

        // Mark as ready to refresh and trigger haptic when threshold reached
        if (adjustedDelta >= threshold) {
          this.pullTriggered = true
          this.pullRefreshIndicator.classList.add('active')
          if (!hapticTriggered) {
            hapticTriggered = true
            this.triggerHaptic()
          }
        } else {
          this.pullTriggered = false
          this.pullRefreshIndicator.classList.remove('active')
        }
      },
      { passive: true }
    )

    this.fileList.addEventListener(
      'touchend',
      () => {
        if (this.isRefreshing) return

        if (this.pullTriggered && currentPullDelta >= threshold) {
          // Start refresh on release
          this.startRefresh()
        } else {
          // Reset indicator if not triggered
          this.pullRefreshIndicator.style.transform = 'translateY(-100%)'
        }
        this.pullStartY = null
        currentPullDelta = 0
      },
      { passive: true }
    )
  }

  private triggerHaptic(): void {
    // Haptic feedback for PWA (Vibration API)
    if ('vibrate' in navigator) {
      navigator.vibrate(10)
    }
  }

  private async startRefresh(): Promise<void> {
    this.isRefreshing = true
    this.pullRefreshIndicator.classList.add('refreshing')

    // Move indicator to fixed position during refresh
    this.pullRefreshIndicator.style.transform = 'translateY(10px)'

    // Reset spinner rotation for continuous animation
    const spinner = this.pullRefreshIndicator.querySelector('.pull-refresh-spinner') as HTMLElement
    if (spinner) {
      spinner.style.transform = ''
    }

    try {
      await this.refresh()
    } finally {
      // Hide indicator after refresh completes
      this.pullRefreshIndicator.classList.remove('refreshing', 'active')
      this.pullRefreshIndicator.style.transform = 'translateY(-100%)'
      this.isRefreshing = false
      this.pullTriggered = false
    }
  }

  private handleServerChange(): void {
    ConnectScreen.clearUrl()
    window.__BROWSEY_API_BASE__ = ''

    const connectScreen = new ConnectScreen(() => {
      this.navigate('/')
    })
    connectScreen.show()
  }

  private applyCompactMode(compact: boolean): void {
    document.body.classList.toggle('compact-mode', compact)
  }

  async navigate(
    path: string,
    options: { updateHistory?: boolean; replaceHistory?: boolean; openViewerPath?: string } = {}
  ): Promise<void> {
    // Save scroll position of current directory before leaving
    if (this.currentPath) {
      this.scrollPositions.set(this.currentPath, this.fileList.scrollTop)
    }

    // Normalize path
    path = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    this.currentPath = path
    this.searchOverlay.setSearchPath(path)
    this.renderBreadcrumbs(path)
    if (options.updateHistory !== false) {
      this.updateHistory(path, false, options.replaceHistory)
    }

    this.showLoading()

    try {
      const showHidden = SettingsModal.isShowHidden()
      const url = apiUrl(`/api/list?path=${encodeURIComponent(path)}${showHidden ? '&hidden=1' : ''}`)
      const response = await fetch(url)
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load directory')
      }

      const data: ListResponse = await response.json()
      this.currentItems = data.items
      this.currentAbsolutePath = data.absolutePath
      this.renderItems(data.items)

      // Restore scroll position if returning to a previously visited directory
      const savedScroll = this.scrollPositions.get(path)
      if (savedScroll !== undefined) {
        this.fileList.scrollTop = savedScroll
      }

      this.gitStatusBar.update(path)
      if (options.openViewerPath) {
        const inline = isTwoPaneMode()
        const nav = this.getImageNavContext(options.openViewerPath)
        this.viewer.open(options.openViewerPath, nav, inline)
        if (inline) {
          this.previewHeader.hidden = false
          this.selectedFilePath = options.openViewerPath
          this.updateSelectedFileHighlight()
        }
      } else if (isTwoPaneMode() && !this.selectedFilePath) {
        this.showPreviewEmptyState()
      }
    } catch (error) {
      this.currentItems = []
      this.showError(error instanceof Error ? error.message : 'Failed to load')
      this.renderEmpty()
    }
  }

  private showLoading(): void {
    this.loading.style.display = 'flex'
    // Remove all file items but keep loading
    const items = this.fileList.querySelectorAll('.file-item, .empty')
    items.forEach((item) => item.remove())
  }

  private renderItems(items: FileItem[]): void {
    this.loading.style.display = 'none'

    // Remove existing items
    const existingItems = this.fileList.querySelectorAll('.file-item, .empty')
    existingItems.forEach((item) => item.remove())

    // Render virtual ".." row for non-root directories
    if (this.currentPath !== '/') {
      const parentPath = this.getParentPath(this.currentPath)
      const parentAbsolutePath = this.getParentPath(this.currentAbsolutePath)
      this.fileList.insertAdjacentHTML(
        'beforeend',
        `
        <div class="file-item" data-path="${this.escapeHtml(parentPath)}" data-type="directory" data-extension="">
          <span class="file-icon">${Folder}</span>
          <div class="file-info">
            <div class="file-name">..</div>
          </div>
          <div class="file-actions">
            <button class="btn-file-action info" data-path="${this.escapeHtml(parentPath)}" data-absolute-path="${this.escapeHtml(parentAbsolutePath)}" aria-label="Info">
              ${Info}
            </button>
            <button class="btn-file-action copy" data-absolute-path="${this.escapeHtml(parentAbsolutePath)}" aria-label="Copy path">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
          </div>
        </div>
      `
      )
    }

    // Render virtual "." row for current directory (alias)
    this.fileList.insertAdjacentHTML(
      'beforeend',
      `
      <div class="file-item file-item-current" data-type="directory" data-extension="">
        <span class="file-icon">${FolderOpen}</span>
        <div class="file-info">
          <div class="file-name">.</div>
        </div>
        <div class="file-actions">
          <button class="btn-file-action info" data-path="${this.escapeHtml(this.currentPath)}" data-absolute-path="${this.escapeHtml(this.currentAbsolutePath)}" aria-label="Info">
            ${Info}
          </button>
          <button class="btn-file-action copy" data-absolute-path="${this.escapeHtml(this.currentAbsolutePath)}" aria-label="Copy path">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>
      </div>
    `
    )

    if (items.length === 0 && this.currentPath === '/') {
      this.renderEmpty()
      return
    }

    // Sort favorite directories to top
    const favs = getFavorites()
    const sorted = [...items].sort((a, b) => {
      const aFav = a.type === 'directory' && favs.has(a.absolutePath)
      const bFav = b.type === 'directory' && favs.has(b.absolutePath)
      if (aFav !== bFav) return aFav ? -1 : 1
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const html = sorted
      .map((item) => {
        const itemPath = this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`
        const favClass = item.type === 'directory' && favs.has(item.absolutePath) ? ' favorite' : ''

        return `
        <div class="file-item${favClass}" data-path="${this.escapeHtml(itemPath)}" data-type="${item.type}" data-extension="${item.extension || ''}">
          <span class="file-icon">${this.getIcon(item)}</span>
          <div class="file-info">
            <div class="file-name">${this.escapeHtml(item.name)}</div>
            <div class="file-meta">${this.formatMeta(item)}</div>
          </div>
          <div class="file-actions">
            <button class="btn-file-action info" data-path="${this.escapeHtml(itemPath)}" data-absolute-path="${this.escapeHtml(item.absolutePath)}" aria-label="Info">
              ${Info}
            </button>
            <button class="btn-file-action copy" data-absolute-path="${this.escapeHtml(item.absolutePath)}" aria-label="Copy path">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
          </div>
        </div>
      `
      })
      .join('')

    this.fileList.insertAdjacentHTML('beforeend', html)

    // Handle file highlighting from search navigation
    if (this.highlightedFile) {
      const fileToHighlight = this.highlightedFile
      this.highlightedFile = null

      requestAnimationFrame(() => {
        const items = this.fileList.querySelectorAll('.file-item')
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!
          const itemPath = item.getAttribute('data-path')
          if (itemPath && itemPath.endsWith('/' + fileToHighlight)) {
            ;(item as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' })
            item.classList.add('highlighted')

            setTimeout(() => {
              item.classList.remove('highlighted')
            }, 2000)
            break
          }
        }
      })
    }
  }

  private renderEmpty(): void {
    this.loading.style.display = 'none'
    const existingItems = this.fileList.querySelectorAll('.file-item, .empty')
    existingItems.forEach((item) => item.remove())

    this.fileList.insertAdjacentHTML(
      'beforeend',
      `
      <div class="empty">
        <div class="empty-icon">${FolderOpen}</div>
        <div>This folder is empty</div>
      </div>
    `
    )
  }

  private renderBreadcrumbs(path: string): void {
    const parts = path.split('/').filter(Boolean)
    const crumbs = parts.map((part, index) => {
      const crumbPath = '/' + parts.slice(0, index + 1).join('/')
      return `
        <button class="breadcrumb" data-path="${this.escapeHtml(crumbPath)}" aria-label="Go to ${this.escapeHtml(part)}">
          ${this.escapeHtml(part)}
        </button>
      `
    })

    this.pathDisplay.innerHTML = crumbs.length
      ? crumbs.join('<span class="breadcrumb-sep">/</span>')
      : `<button class="breadcrumb" data-path="/" aria-label="Go to root">/</button>`

    this.pathDisplay.querySelectorAll<HTMLButtonElement>('.breadcrumb').forEach((crumb) => {
      crumb.addEventListener('click', (event) => {
        event.preventDefault()
        const targetPath = crumb.getAttribute('data-path')
        if (!targetPath) return
        this.navigate(targetPath)
      })
    })
  }

  private handleItemClick(path: string, type: 'file' | 'directory', extension: string | null): void {
    if (type === 'directory') {
      if (isTwoPaneMode()) {
        this.closePreview()
      }
      this.navigate(path)
    } else {
      // Check if file is viewable
      const viewableType = isViewable(extension)
      if (viewableType) {
        if (isTwoPaneMode()) {
          this.openInlineViewer(path)
        } else {
          this.openViewer(path)
        }
      } else {
        this.downloadFile(path)
      }
    }
  }

  private downloadFile(path: string): void {
    const a = document.createElement('a')
    a.href = apiUrl(`/api/file?path=${encodeURIComponent(path)}`)
    a.download = path.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  private goUp(): void {
    if (this.currentPath === '/') return
    if (isTwoPaneMode()) {
      this.closePreview()
    }
    const parts = this.currentPath.split('/').filter(Boolean)
    parts.pop()
    const parent = parts.length > 0 ? '/' + parts.join('/') : '/'
    this.navigate(parent)
  }

  private refresh(): Promise<void> {
    return this.navigate(this.currentPath)
  }

  private handleViewerClose(): void {
    if (isTwoPaneMode()) {
      this.selectedFilePath = null
      this.updateSelectedFileHighlight()
      this.showPreviewEmptyState()
    }
    this.updateHistory(this.currentPath, false, false)
  }

  private openViewer(
    path: string,
    options: { updateHistory?: boolean; replaceHistory?: boolean } = {}
  ): void {
    const nav = this.getImageNavContext(path)
    this.viewer.open(path, nav)
    if (options.updateHistory === false) return
    this.updateHistory(path, true, options.replaceHistory)
  }

  private openInlineViewer(path: string): void {
    this.previewHeader.hidden = false
    this.selectedFilePath = path
    this.updateSelectedFileHighlight()
    const nav = this.getImageNavContext(path)
    this.viewer.open(path, nav, true)
    this.updateHistory(path, true, false)
  }

  private closePreview(): void {
    this.selectedFilePath = null
    this.updateSelectedFileHighlight()
    this.viewer.closeSilently()
    this.showPreviewEmptyState()
  }

  private updateSelectedFileHighlight(): void {
    this.fileList.querySelectorAll('.file-item.selected').forEach((item) => {
      item.classList.remove('selected')
    })

    if (!this.selectedFilePath) return

    const items = this.fileList.querySelectorAll('.file-item')
    for (let i = 0; i < items.length; i++) { const item = items[i]!;
      if (item.getAttribute('data-path') === this.selectedFilePath) {
        item.classList.add('selected')
        break
      }
    }
  }

  private showPreviewEmptyState(): void {
    this.previewPane.hidden = true
  }

  private handleLayoutChange(isTwoPane: boolean): void {
    if (isTwoPane) {
      // Switching from narrow to wide
      if (this.viewer.isOverlayOpen && this.viewer.filePath) {
        const path = this.viewer.filePath
        this.viewer.closeSilently()
        this.selectedFilePath = path
        this.updateSelectedFileHighlight()
        const nav = this.getImageNavContext(path)
        this.viewer.open(path, nav, true)
      } else {
        this.showPreviewEmptyState()
      }
    } else {
      // Switching from wide to narrow
      if (this.viewer.isInlineOpen && this.viewer.filePath) {
        const path = this.viewer.filePath
        this.viewer.closeSilently()
        this.selectedFilePath = null
        this.updateSelectedFileHighlight()
        const nav = this.getImageNavContext(path)
        this.viewer.open(path, nav, false)
      } else {
        this.previewPane.hidden = true
      }
    }
  }

  private loadFromLocation(): void {
    const { path, view } = this.parseLocation()
    if (!view || path === '/') {
      this.navigate(path, { replaceHistory: true })
      return
    }

    const parentPath = this.getParentPath(path)
    this.navigate(parentPath, { replaceHistory: true, updateHistory: false, openViewerPath: path })
  }

  private handlePopState(): void {
    const { path, view } = this.parseLocation()
    if (!view || path === '/') {
      this.viewer.closeSilently()
      if (isTwoPaneMode()) {
        this.selectedFilePath = null
        this.updateSelectedFileHighlight()
      }
      this.navigate(path, { updateHistory: false })
      return
    }

    const parentPath = this.getParentPath(path)
    this.navigate(parentPath, { updateHistory: false, openViewerPath: path })
  }

  private parseLocation(): { path: string; view: boolean } {
    const url = new URL(window.location.href)
    const view = url.searchParams.get('view') === '1'
    const queryPath = url.searchParams.get('path')
    if (queryPath) {
      const normalized = queryPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
      return { path: normalized, view }
    }
    const pathname = decodeURIComponent(url.pathname)
    const path = pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    return { path, view }
  }

  private updateHistory(path: string, view: boolean, replaceHistory = false): void {
    const url = new URL(window.location.href)
    if (this.useQueryRouting) {
      if (path === '/') {
        url.searchParams.delete('path')
      } else {
        url.searchParams.set('path', path)
      }
    } else {
      url.pathname = path === '/' ? '/' : path
    }
    if (view) {
      url.searchParams.set('view', '1')
    } else {
      url.searchParams.delete('view')
    }
    const state = { path, view }
    if (replaceHistory) {
      history.replaceState(state, '', url)
      return
    }
    history.pushState(state, '', url)
  }

  private getParentPath(path: string): string {
    if (path === '/') return '/'
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    if (parts.length === 0) return '/'
    return `/${parts.join('/')}`
  }

  private async copyToClipboard(text: string, successMessage: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      this.showToast(successMessage)
    } catch {
      this.showError('Failed to copy')
    }
  }

  private async copyPath(path: string): Promise<void> {
    this.copyToClipboard(path, 'Path copied')
  }

  private showToast(message: string, isError = false): void {
    this.toast.textContent = message
    this.toast.className = isError ? 'toast error' : 'toast'
    this.toast.hidden = false

    setTimeout(() => {
      this.toast.hidden = true
    }, 3000)
  }

  private showError(message: string): void {
    this.showToast(message, true)
  }

  private getIcon(item: FileItem): string {
    if (item.type === 'directory') return isFavorite(item.absolutePath) ? FolderHeart : Folder

    const iconMap: Record<string, string> = {
      // Documents
      pdf: FileText,
      doc: FileText,
      docx: FileText,
      txt: FileText,
      md: FileText,
      markdown: FileText,
      rtf: FileText,

      // Spreadsheets
      xls: FileText,
      xlsx: FileText,
      csv: FileText,

      // Presentations
      ppt: FileText,
      pptx: FileText,

      // Images
      jpg: Image,
      jpeg: Image,
      png: Image,
      gif: Image,
      svg: Image,
      webp: Image,
      bmp: Image,
      ico: Image,
      avif: Image,

      // Audio
      mp3: Music,
      wav: Music,
      ogg: Music,
      flac: Music,
      m4a: Music,

      // Video
      mp4: Video,
      webm: Video,
      avi: Video,
      mov: Video,
      mkv: Video,

      // Archives
      zip: Archive,
      rar: Archive,
      tar: Archive,
      gz: Archive,
      '7z': Archive,

      // Code
      js: FileCode,
      ts: FileCode,
      jsx: FileCode,
      tsx: FileCode,
      mjs: FileCode,
      cjs: FileCode,
      json: FileCode,
      html: FileCode,
      css: FileCode,
      py: FileCode,
      rb: FileCode,
      go: FileCode,
      rs: FileCode,
      java: FileCode,
      c: FileCode,
      cpp: FileCode,
      h: FileCode,
      sh: FileCode,
      yaml: FileCode,
      yml: FileCode,
      xml: FileCode,
      toml: FileCode,

      // Config
      env: FileCog,
      gitignore: FileCog,
      dockerignore: FileCog,
      dockerfile: FileCog,
    }

    return iconMap[item.extension?.toLowerCase() || ''] || File
  }

  private formatMeta(item: FileItem): string {
    if (item.type === 'directory') {
      return this.formatDate(item.modified)
    }
    const size = this.formatSize(item.size)
    const date = this.formatDate(item.modified)
    return `${size} • ${date}`
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  private formatDate(iso: string): string {
    const date = new Date(iso)
    const datePart = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const timePart = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return `${datePart} ${timePart}`
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

// Initialize
const serverApiUrl = window.__BROWSEY_API_BASE__
if (serverApiUrl) {
  // API URL baked in by server (--api was provided)
  new FileBrowser()
} else {
  // No API URL — check localStorage or show connect screen
  const saved = ConnectScreen.getSavedUrl()
  if (saved) {
    // Try saved URL, fall back to connect screen if it fails
    fetch(`${saved}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((response) => {
        if (response.ok) {
          window.__BROWSEY_API_BASE__ = saved
          new FileBrowser(true)
        } else {
          showConnectScreen('Saved server is not responding')
        }
      })
      .catch(() => {
        showConnectScreen('Could not reach saved server')
      })
  } else {
    showConnectScreen()
  }
}

function showConnectScreen(error?: string): void {
  // Hide loading indicator
  const loading = document.getElementById('loading')
  if (loading) loading.style.display = 'none'

  const connectScreen = new ConnectScreen((url) => {
    new FileBrowser(true)
  })
  connectScreen.show(error)
}
