# Browsey iOS Companion App - Implementation Plan

## Overview

A fully native iOS app built with SwiftUI that connects to Browsey servers on the local network. The app provides a native file browsing experience with server discovery via manual entry, QR code scanning, and Bonjour auto-discovery.

## Technical Specifications

| Spec | Value |
|------|-------|
| Minimum iOS | 17.0+ |
| UI Framework | SwiftUI |
| Language | Swift 5.9+ |
| Architecture | MVVM |
| Offline Features | None (v1) |
| Authentication | None (v1) |

## Project Structure

```
BrowseyApp/
├── App/
│   ├── BrowseyApp.swift              # App entry point
│   └── ContentView.swift             # Root navigation
├── Models/
│   ├── Server.swift                  # Server connection model
│   ├── FileItem.swift                # File/directory model
│   └── FileContent.swift             # Viewed file content model
├── ViewModels/
│   ├── ServerListViewModel.swift     # Server discovery & management
│   ├── FileBrowserViewModel.swift    # Directory listing logic
│   └── FileViewerViewModel.swift     # File viewing logic
├── Views/
│   ├── ServerList/
│   │   ├── ServerListView.swift      # Main server list screen
│   │   ├── ServerRowView.swift       # Individual server row
│   │   ├── AddServerSheet.swift      # Manual server entry
│   │   └── QRScannerView.swift       # QR code scanner
│   ├── FileBrowser/
│   │   ├── FileBrowserView.swift     # Directory listing screen
│   │   ├── FileRowView.swift         # Individual file/folder row
│   │   └── BreadcrumbView.swift      # Navigation breadcrumbs
│   └── FileViewer/
│       ├── FileViewerView.swift      # File content viewer
│       ├── CodeViewerView.swift      # Syntax-highlighted code
│       ├── ImageViewerView.swift     # Image viewer with gestures
│       ├── MarkdownViewerView.swift  # Rendered markdown
│       └── FileInfoSheet.swift       # File metadata sheet
├── Services/
│   ├── BrowseyAPIClient.swift        # HTTP client for Browsey API
│   ├── BonjourDiscovery.swift        # mDNS service discovery
│   └── ServerStorage.swift           # Persist saved servers
├── Utilities/
│   ├── FileTypeHelper.swift          # File type detection & icons
│   ├── SizeFormatter.swift           # Human-readable file sizes
│   └── URLBuilder.swift              # API URL construction
└── Resources/
    ├── Assets.xcassets               # App icons, colors
    └── Localizable.strings           # Localization (optional)
```

## Implementation Phases

### Phase 1: Project Setup & Core Infrastructure

**Tasks:**
1. Create new Xcode project with SwiftUI lifecycle
2. Configure project settings (bundle ID, deployment target iOS 17)
3. Set up folder structure as outlined above
4. Add required capabilities:
   - Camera (for QR scanning)
   - Local Network (for Bonjour discovery)
5. Create `Info.plist` entries:
   - `NSCameraUsageDescription`
   - `NSLocalNetworkUsageDescription`
   - `NSBonjourServices` with `_browsey._tcp`

**Deliverable:** Empty project structure that builds successfully

---

### Phase 2: API Client & Models

**Tasks:**

1. **Define Models** matching Browsey API responses:

```swift
// FileItem.swift
struct FileItem: Codable, Identifiable {
    let name: String
    let type: FileType
    let size: Int64
    let modified: Date
    let extension: String?
    let absolutePath: String

    var id: String { absolutePath }

    enum FileType: String, Codable {
        case file
        case directory
    }
}

// DirectoryListing.swift
struct DirectoryListing: Codable {
    let path: String
    let items: [FileItem]
}

// FileContent.swift
struct FileContent: Codable {
    let type: ContentType
    let content: String?
    let language: String?
    let mimeType: String?
    let dimensions: ImageDimensions?

    enum ContentType: String, Codable {
        case text
        case markdown
        case image
        case binary
    }
}

// Server.swift
struct Server: Codable, Identifiable {
    let id: UUID
    var name: String
    var host: String
    var port: Int
    var lastConnected: Date?

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }
}
```

2. **Implement API Client:**

```swift
// BrowseyAPIClient.swift
actor BrowseyAPIClient {
    private let session: URLSession
    private let decoder: JSONDecoder

    init() {
        self.session = URLSession.shared
        self.decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func listDirectory(server: Server, path: String) async throws -> DirectoryListing
    func viewFile(server: Server, path: String) async throws -> FileContent
    func getFileInfo(server: Server, path: String) async throws -> FileItem
    func downloadFile(server: Server, path: String) async throws -> Data
    func checkConnection(server: Server) async throws -> Bool
}
```

3. **Implement Server Storage** using SwiftData or UserDefaults for persisting saved servers

**Deliverable:** Fully functional API client that can communicate with Browsey server

---

### Phase 3: Server Discovery & Management

**Tasks:**

1. **Manual Server Entry:**
   - Text field for IP/hostname
   - Text field for port (default: 8080)
   - Optional custom name
   - "Test Connection" button before saving

2. **QR Code Scanner:**
   - Use `AVFoundation` for camera access
   - Parse URL from QR code (format: `http://192.168.1.x:8080`)
   - Auto-fill server details from scanned URL
   - Handle camera permission denied state

3. **Bonjour Discovery:**
   - Create `NWBrowser` for `_browsey._tcp` service type
   - Listen for service additions/removals
   - Resolve service endpoints to get IP and port
   - Show discovered servers with "network" indicator

```swift
// BonjourDiscovery.swift
@Observable
class BonjourDiscovery {
    private(set) var discoveredServers: [Server] = []
    private var browser: NWBrowser?

    func startDiscovery()
    func stopDiscovery()
}
```

4. **Server List UI:**
   - Section: "Discovered Servers" (from Bonjour)
   - Section: "Saved Servers" (manually added)
   - Swipe to delete saved servers
   - Pull to refresh discovery
   - Connection status indicator (online/offline)

**Deliverable:** Complete server management with all three discovery methods

**Note:** Requires server-side addition to Browsey for Bonjour advertising (see Phase 7)

---

### Phase 4: File Browser

**Tasks:**

1. **Directory Listing View:**
   - List of files/folders with appropriate icons
   - File size and modification date
   - Folders sorted before files (matching web UI)
   - Pull to refresh
   - Loading state with skeleton/shimmer

2. **Navigation:**
   - Tap folder → push new directory view
   - Breadcrumb bar at top for quick navigation
   - Back button / swipe back gesture
   - Virtual ".." row at top (matching web UI behavior)

3. **File Row Design:**
   - Icon based on file type (folder, image, code, document, etc.)
   - File name (truncated if needed)
   - Subtitle: size + modified date
   - Chevron for folders, download icon for non-viewable files

4. **Empty States:**
   - Empty directory message
   - Error state with retry button
   - No connection state

```swift
// FileBrowserView.swift
struct FileBrowserView: View {
    @State private var viewModel: FileBrowserViewModel
    let server: Server
    let initialPath: String

    var body: some View {
        List {
            // Parent directory row
            if viewModel.canGoUp {
                ParentDirectoryRow()
            }

            // File items
            ForEach(viewModel.items) { item in
                FileRowView(item: item)
                    .onTapGesture {
                        viewModel.select(item)
                    }
            }
        }
        .navigationTitle(viewModel.currentDirectoryName)
        .refreshable {
            await viewModel.refresh()
        }
    }
}
```

**Deliverable:** Fully navigable file browser matching web UI functionality

---

### Phase 5: File Viewer

**Tasks:**

1. **Text/Code Viewer:**
   - Syntax highlighting using a Swift library (e.g., `Splash` or `HighlightSwift`)
   - Horizontal scrolling for long lines
   - Line numbers (optional toggle)
   - Monospace font
   - Support same file types as web UI (70+ extensions)

2. **Image Viewer:**
   - Pinch to zoom
   - Double tap to zoom in/out
   - Pan gesture when zoomed
   - Swipe left/right for next/previous image in folder
   - Show image dimensions
   - Share button

3. **Markdown Viewer:**
   - Render markdown to native SwiftUI views
   - Use library like `MarkdownUI`
   - Code blocks with syntax highlighting
   - Support images, links, tables

4. **File Info Sheet:**
   - File name
   - File type
   - Size (formatted)
   - Created date
   - Modified date
   - Full path (with copy button)

5. **Download/Share:**
   - Share sheet for any file
   - Download to Files app
   - Open in other apps

```swift
// FileViewerView.swift
struct FileViewerView: View {
    let server: Server
    let file: FileItem
    @State private var content: FileContent?

    var body: some View {
        Group {
            switch content?.type {
            case .text:
                CodeViewerView(content: content!.content!, language: content?.language)
            case .markdown:
                MarkdownViewerView(content: content!.content!)
            case .image:
                ImageViewerView(server: server, file: file)
            case .binary, .none:
                BinaryFileView(file: file)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("File Info") { showInfo = true }
                    Button("Share") { shareFile() }
                    Button("Download") { downloadFile() }
                }
            }
        }
    }
}
```

**Deliverable:** Complete file viewing experience for all supported file types

---

### Phase 6: Polish & UX

**Tasks:**

1. **Visual Design:**
   - Dark mode support (matching Browsey web theme)
   - Custom app icon
   - SF Symbols for all icons
   - Consistent spacing and typography

2. **Animations:**
   - Smooth navigation transitions
   - Loading shimmer effects
   - Image viewer transitions

3. **Error Handling:**
   - Network error alerts
   - Server unreachable states
   - File too large warnings
   - Graceful degradation

4. **Haptic Feedback:**
   - Success feedback on copy
   - Selection feedback on tap
   - Error feedback on failures

5. **Accessibility:**
   - VoiceOver labels
   - Dynamic Type support
   - Reduce Motion support

**Deliverable:** Polished, production-ready user experience

---

### Phase 7: Server-Side Bonjour Support (Browsey Enhancement)

**Tasks:**

To enable automatic discovery, add Bonjour advertising to the Browsey server:

1. **Add dependency** for mDNS/Bonjour in Bun:
   - Use `bonjour-service` npm package or native DNS-SD

2. **Advertise service on startup:**

```typescript
// src/bonjour.ts
import Bonjour from 'bonjour-service';

export function advertiseService(port: number, name: string) {
    const bonjour = new Bonjour();

    const service = bonjour.publish({
        name: name || `Browsey on ${os.hostname()}`,
        type: 'browsey',
        port: port,
        txt: {
            version: '1.0',
            path: rootPath
        }
    });

    return () => service.stop();
}
```

3. **Integrate into server startup** in `server.ts`
4. **Add CLI flag** `--no-bonjour` to disable if needed

**Deliverable:** Browsey servers automatically discoverable by iOS app

---

## Dependencies (iOS App)

| Library | Purpose | Source |
|---------|---------|--------|
| None (built-in) | UI Framework | SwiftUI |
| None (built-in) | Networking | URLSession |
| None (built-in) | QR Scanning | AVFoundation |
| None (built-in) | Bonjour | Network.framework |
| `HighlightSwift` | Syntax highlighting | SPM |
| `MarkdownUI` | Markdown rendering | SPM |

*Keeping dependencies minimal for maintainability*

---

## API Endpoints Used

| Endpoint | iOS Usage |
|----------|-----------|
| `GET /api/list?path=` | Directory listing |
| `GET /api/view?path=` | File content for viewer |
| `GET /api/file?path=` | Raw file download |
| `GET /api/stat?path=` | File metadata |

---

## Timeline Estimate

| Phase | Description |
|-------|-------------|
| Phase 1 | Project Setup |
| Phase 2 | API Client & Models |
| Phase 3 | Server Discovery |
| Phase 4 | File Browser |
| Phase 5 | File Viewer |
| Phase 6 | Polish & UX |
| Phase 7 | Server Bonjour Support |

---

## Future Considerations (Post v1)

- **Authentication**: Token-based auth for security
- **Offline caching**: Cache recently viewed files
- **Favorites**: Bookmark frequently accessed paths
- **Widgets**: Home screen quick access
- **Files app integration**: Browse as document provider
- **iPad optimization**: Split view, keyboard shortcuts
- **Watch companion**: Quick file access from Apple Watch

---

## Success Criteria

- [ ] App connects to Browsey server via manual entry
- [ ] App scans QR codes and auto-connects
- [ ] App discovers servers via Bonjour (with server update)
- [ ] App browses directories with native feel
- [ ] App views code with syntax highlighting
- [ ] App views images with gestures
- [ ] App views markdown rendered
- [ ] App allows file download/share
- [ ] App handles errors gracefully
- [ ] App works in dark mode
- [ ] App feels native and responsive
