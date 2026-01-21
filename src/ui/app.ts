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

class FileBrowser {
  private currentPath = '/'
  private fileList: HTMLElement
  private pathDisplay: HTMLElement
  private loading: HTMLElement
  private toast: HTMLElement
  private pullStartY: number | null = null
  private pullTriggered = false

  constructor() {
    this.fileList = document.getElementById('file-list')!
    this.pathDisplay = document.getElementById('path-display')!
    this.loading = document.getElementById('loading')!
    this.toast = document.getElementById('toast')!

    this.setupEventListeners()
    this.setupPullToRefresh()
    this.navigate('/')
  }

  private setupEventListeners(): void {
    document.getElementById('btn-back')?.addEventListener('click', () => this.goUp())
    document.getElementById('btn-refresh')?.addEventListener('click', () => this.refresh())

    // File item clicks (delegated)
    this.fileList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement

      // Handle download button
      const downloadBtn = target.closest('.download')
      if (downloadBtn) {
        e.stopPropagation()
        const path = downloadBtn.getAttribute('data-path')
        if (path) this.downloadFile(path)
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

      // Handle item click (navigate or download)
      const item = target.closest('.file-item') as HTMLElement
      if (item) {
        const path = item.getAttribute('data-path')!
        const type = item.getAttribute('data-type')!
        this.handleItemClick(path, type as 'file' | 'directory')
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

  async navigate(path: string): Promise<void> {
    // Normalize path
    path = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    this.currentPath = path
    this.pathDisplay.textContent = path

    this.showLoading()

    try {
      const response = await fetch(`/api/list?path=${encodeURIComponent(path)}`)
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load directory')
      }

      const data: ListResponse = await response.json()
      this.renderItems(data.items)
    } catch (error) {
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

    if (items.length === 0) {
      this.renderEmpty()
      return
    }

    const html = items
      .map((item) => {
        const itemPath = this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`

        return `
        <div class="file-item" data-path="${this.escapeHtml(itemPath)}" data-type="${item.type}">
          <span class="file-icon">${this.getIcon(item)}</span>
          <div class="file-info">
            <div class="file-name">${this.escapeHtml(item.name)}</div>
            <div class="file-meta">${this.formatMeta(item)}</div>
          </div>
          <div class="file-actions">
            ${
              item.type === 'file'
                ? `
              <button class="btn-file-action download" data-path="${this.escapeHtml(itemPath)}" aria-label="Download">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            `
                : ''
            }
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

    // Remove existing items and add new ones
    const existingItems = this.fileList.querySelectorAll('.file-item, .empty')
    existingItems.forEach((item) => item.remove())
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
        <div class="empty-icon">📂</div>
        <div>This folder is empty</div>
      </div>
    `
    )
  }

  private handleItemClick(path: string, type: 'file' | 'directory'): void {
    if (type === 'directory') {
      this.navigate(path)
    } else {
      this.downloadFile(path)
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
    if (item.type === 'directory') return '📁'

    const iconMap: Record<string, string> = {
      // Documents
      pdf: '📄',
      doc: '📝',
      docx: '📝',
      txt: '📄',
      md: '📝',
      rtf: '📝',

      // Spreadsheets
      xls: '📊',
      xlsx: '📊',
      csv: '📊',

      // Presentations
      ppt: '📽️',
      pptx: '📽️',

      // Images
      jpg: '🖼️',
      jpeg: '🖼️',
      png: '🖼️',
      gif: '🖼️',
      svg: '🖼️',
      webp: '🖼️',
      bmp: '🖼️',
      ico: '🖼️',

      // Audio
      mp3: '🎵',
      wav: '🎵',
      ogg: '🎵',
      flac: '🎵',
      m4a: '🎵',

      // Video
      mp4: '🎬',
      webm: '🎬',
      avi: '🎬',
      mov: '🎬',
      mkv: '🎬',

      // Archives
      zip: '📦',
      rar: '📦',
      tar: '📦',
      gz: '📦',
      '7z': '📦',

      // Code
      js: '📜',
      ts: '📜',
      jsx: '📜',
      tsx: '📜',
      json: '📋',
      html: '🌐',
      css: '🎨',
      py: '🐍',
      rb: '💎',
      go: '🔵',
      rs: '🦀',
      java: '☕',
      c: '⚙️',
      cpp: '⚙️',
      h: '⚙️',
      sh: '💻',
      yaml: '📋',
      yml: '📋',
      xml: '📋',
      toml: '📋',

      // Config
      env: '🔒',
      gitignore: '🔧',
      dockerignore: '🐳',
      dockerfile: '🐳',

      // Fonts
      ttf: '🔤',
      otf: '🔤',
      woff: '🔤',
      woff2: '🔤',
    }

    return iconMap[item.extension?.toLowerCase() || ''] || '📄'
  }

  private formatMeta(item: FileItem): string {
    if (item.type === 'directory') {
      return 'Folder'
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
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } else if (diffDays === 1) {
      return 'Yesterday'
    } else if (diffDays < 7) {
      return `${diffDays} days ago`
    } else {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

// Initialize
new FileBrowser()
