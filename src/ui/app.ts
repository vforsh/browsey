import {
  Archive,
  File,
  FileCode,
  FileCog,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Info,
  Music,
  Video,
  TriangleAlert,
} from 'lucide-static'
import hljs from 'highlight.js'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'

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

type ImageNavContext = {
  paths: string[]
  index: number
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
  private overlay: HTMLElement
  private content: HTMLElement
  private filename: HTMLElement
  private downloadBtn: HTMLElement
  private closeBtn: HTMLElement
  private prevBtn: HTMLButtonElement
  private nextBtn: HTMLButtonElement
  private fontDecreaseBtn: HTMLButtonElement
  private fontIncreaseBtn: HTMLButtonElement
  private currentPath: string | null = null
  private imageNav: ImageNavContext | null = null
  private currentContentType: 'text' | 'image' | null = null
  private currentFontLevel: number = 3 // Default: 16px
  private readonly FONT_SIZES = [12, 14, 16, 18, 20, 22, 24]
  private readonly STORAGE_KEY = 'browsey-font-size'
  private onClose?: () => void
  private onNavigate?: (path: string) => void

  constructor(onClose?: () => void, onNavigate?: (path: string) => void) {
    this.overlay = document.getElementById('viewer-overlay')!
    this.content = document.getElementById('viewer-content')!
    this.filename = document.getElementById('viewer-filename')!
    this.downloadBtn = document.getElementById('viewer-download')!
    this.closeBtn = document.getElementById('viewer-close')!
    this.prevBtn = document.getElementById('viewer-prev') as HTMLButtonElement
    this.nextBtn = document.getElementById('viewer-next') as HTMLButtonElement
    this.fontDecreaseBtn = document.getElementById('viewer-font-decrease') as HTMLButtonElement
    this.fontIncreaseBtn = document.getElementById('viewer-font-increase') as HTMLButtonElement
    this.onClose = onClose
    this.onNavigate = onNavigate

    this.loadFontPreference()
    this.setupEventListeners()
    this.setupMarked()
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.close())
    this.downloadBtn.addEventListener('click', () => this.download())
    this.prevBtn.addEventListener('click', () => this.navigatePrev())
    this.nextBtn.addEventListener('click', () => this.navigateNext())
    this.fontDecreaseBtn.addEventListener('click', () => this.decreaseFontSize())
    this.fontIncreaseBtn.addEventListener('click', () => this.increaseFontSize())
    this.overlay.addEventListener('click', (event) => {
      if (event.target !== this.overlay) return
      this.close()
    })

    // Close on ESC, navigate on arrows, font size with +/-
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

    // Swipe handling for mobile
    let touchStartX = 0
    let touchStartY = 0
    this.overlay.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0]?.clientX ?? 0
      touchStartY = e.touches[0]?.clientY ?? 0
    }, { passive: true })

    this.overlay.addEventListener('touchend', (e) => {
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
      if (deltaY > 100 && this.content.scrollTop === 0) {
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
    this.prevBtn.hidden = true
    this.nextBtn.hidden = true
    this.fontDecreaseBtn.hidden = true
    this.fontIncreaseBtn.hidden = true
  }

  private updateControlButtons(): void {
    const isImage = this.currentContentType === 'image'
    const isText = this.currentContentType === 'text'

    // Image navigation: show only for images with nav context
    const hasImageNav = this.imageNav !== null
    this.prevBtn.hidden = !(isImage && hasImageNav)
    this.nextBtn.hidden = !(isImage && hasImageNav)
    if (isImage && hasImageNav) {
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
    const textContent = this.content.querySelector('.viewer-text, .viewer-markdown') as HTMLElement | null
    if (textContent) {
      textContent.style.fontSize = `${size}px`
    }
  }

  private updateFontButtons(): void {
    this.fontDecreaseBtn.disabled = this.currentFontLevel <= 1
    this.fontIncreaseBtn.disabled = this.currentFontLevel >= this.FONT_SIZES.length
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

  async open(path: string, imageNav?: ImageNavContext): Promise<void> {
    this.currentPath = path
    this.imageNav = imageNav ?? null
    this.currentContentType = null
    this.overlay.hidden = false
    this.content.innerHTML = '<div class="viewer-loading">Loading...</div>'
    this.filename.textContent = path.split('/').pop() || ''
    this.hideAllControlButtons()

    try {
      const response = await fetch(`/api/view?path=${encodeURIComponent(path)}`)
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
      this.renderImage(data.url, data.filename)
    }
  }

  private renderText(content: string, extension: string | null, filename: string): void {
    this.currentContentType = 'text'
    const size = this.getCurrentFontSize()
    const isMarkdown = extension?.toLowerCase() === 'md' || extension?.toLowerCase() === 'markdown'

    if (isMarkdown) {
      // Render markdown
      const html = marked.parse(content) as string
      this.content.innerHTML = `<div class="viewer-markdown" style="font-size: ${size}px">${html}</div>`
    } else {
      // Render with syntax highlighting
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

  private renderImage(url: string, filename: string): void {
    this.currentContentType = 'image'
    this.content.innerHTML = `
      <div class="viewer-image">
        <img src="${url}" alt="${this.escapeHtml(filename)}" />
      </div>
    `
    const image = this.content.querySelector('img')
    if (!image) return
    image.addEventListener('load', () => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (!width || !height) return
      this.filename.textContent = `${filename} • ${width}x${height}`
    }, { once: true })

    this.updateControlButtons()
  }

  private renderError(message: string): void {
    this.content.innerHTML = `
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
    this.overlay.hidden = true
    this.currentPath = null
    this.imageNav = null
    this.currentContentType = null
    this.content.innerHTML = ''
    this.updateControlButtons()
    if (!shouldNotify) return
    this.onClose?.()
  }

  private download(): void {
    if (!this.currentPath) return
    const a = document.createElement('a')
    a.href = `/api/file?path=${encodeURIComponent(this.currentPath)}`
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
      const response = await fetch(`/api/stat?path=${encodeURIComponent(path)}`)
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

class FileBrowser {
  private currentPath = '/'
  private currentItems: FileItem[] = []
  private fileList: HTMLElement
  private pathDisplay: HTMLElement
  private loading: HTMLElement
  private toast: HTMLElement
  private useQueryRouting = false
  private pullStartY: number | null = null
  private pullTriggered = false
  private viewer: FileViewer
  private infoModal: InfoModal

  constructor() {
    this.fileList = document.getElementById('file-list')!
    this.pathDisplay = document.getElementById('path-display')!
    this.loading = document.getElementById('loading')!
    this.toast = document.getElementById('toast')!
    this.useQueryRouting = isIosStandalone()
    this.viewer = new FileViewer(
      () => this.handleViewerClose(),
      (path) => this.handleViewerNavigate(path)
    )
    this.infoModal = new InfoModal()

    this.setupEventListeners()
    this.setupPullToRefresh()
    window.addEventListener('popstate', () => this.handlePopState())
    this.loadFromLocation()
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
    this.viewer.open(path, nav)
    this.updateHistory(path, true, true)
  }

  private setupEventListeners(): void {
    document.getElementById('btn-back')?.addEventListener('click', () => this.goUp())
    document.getElementById('btn-refresh')?.addEventListener('click', () => this.refresh())

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
        const path = item.getAttribute('data-path')!
        const type = item.getAttribute('data-type')!
        const extension = item.getAttribute('data-extension') || null
        this.handleItemClick(path, type as 'file' | 'directory', extension)
      }
    })

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') this.goUp()
    })
  }

  private setupPullToRefresh(): void {
    const threshold = 80

    this.fileList.addEventListener(
      'touchstart',
      (event) => {
        if (this.fileList.scrollTop !== 0) return
        this.pullStartY = event.touches[0]?.clientY ?? null
        this.pullTriggered = false
      },
      { passive: true }
    )

    this.fileList.addEventListener(
      'touchmove',
      (event) => {
        if (this.pullStartY === null || this.pullTriggered) return
        const currentY = event.touches[0]?.clientY ?? 0
        const delta = currentY - this.pullStartY
        if (delta > threshold) {
          this.pullTriggered = true
          this.showToast('Refreshing...')
          this.refresh()
        }
      },
      { passive: true }
    )

    this.fileList.addEventListener(
      'touchend',
      () => {
        this.pullStartY = null
        this.pullTriggered = false
      },
      { passive: true }
    )
  }

  async navigate(
    path: string,
    options: { updateHistory?: boolean; replaceHistory?: boolean; openViewerPath?: string } = {}
  ): Promise<void> {
    // Normalize path
    path = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    this.currentPath = path
    this.renderBreadcrumbs(path)
    if (options.updateHistory !== false) {
      this.updateHistory(path, false, options.replaceHistory)
    }

    this.showLoading()

    try {
      const response = await fetch(`/api/list?path=${encodeURIComponent(path)}`)
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load directory')
      }

      const data: ListResponse = await response.json()
      this.currentItems = data.items
      this.renderItems(data.items)
      if (options.openViewerPath) {
        const nav = this.getImageNavContext(options.openViewerPath)
        this.viewer.open(options.openViewerPath, nav)
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
      this.fileList.insertAdjacentHTML(
        'beforeend',
        `
        <div class="file-item" data-path="${this.escapeHtml(parentPath)}" data-type="directory" data-extension="">
          <span class="file-icon">${Folder}</span>
          <div class="file-info">
            <div class="file-name">..</div>
          </div>
        </div>
      `
      )
    }

    if (items.length === 0 && this.currentPath === '/') {
      this.renderEmpty()
      return
    }

    const html = items
      .map((item) => {
        const itemPath = this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`

        return `
        <div class="file-item" data-path="${this.escapeHtml(itemPath)}" data-type="${item.type}" data-extension="${item.extension || ''}">
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
      this.navigate(path)
    } else {
      // Check if file is viewable
      const viewableType = isViewable(extension)
      if (viewableType) {
        this.openViewer(path)
      } else {
        this.downloadFile(path)
      }
    }
  }

  private downloadFile(path: string): void {
    const a = document.createElement('a')
    a.href = `/api/file?path=${encodeURIComponent(path)}`
    a.download = path.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  private goUp(): void {
    if (this.currentPath === '/') return
    const parts = this.currentPath.split('/').filter(Boolean)
    parts.pop()
    const parent = parts.length > 0 ? '/' + parts.join('/') : '/'
    this.navigate(parent)
  }

  private refresh(): void {
    this.navigate(this.currentPath)
  }

  private handleViewerClose(): void {
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

  private async copyPath(path: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = path
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      this.showToast('Path copied')
    } catch {
      this.showError('Failed to copy path')
    }
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
    if (item.type === 'directory') return Folder

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
new FileBrowser()
