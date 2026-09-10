import AppKit

/// The drag represents the exact GUI bundle supplied by Electron. Dropping it never marks a grant.
private final class PermissionAppDragView: NSView, NSDraggingSource {
    private let appURL: URL
    private let icon: NSImage

    init(appPath: String, appName: String) {
        appURL = URL(fileURLWithPath: appPath)
        icon = NSWorkspace.shared.icon(forFile: appPath)
        super.init(frame: NSRect(x: 20, y: 94, width: 340, height: 52))
        wantsLayer = true
        layer?.cornerRadius = 8
        let image = NSImageView(frame: NSRect(x: 12, y: 10, width: 32, height: 32))
        image.image = icon
        image.imageScaling = .scaleProportionallyUpOrDown
        addSubview(image)
        let title = NSTextField(labelWithString: appName)
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        title.frame = NSRect(x: 54, y: 16, width: 270, height: 20)
        addSubview(title)
        toolTip = "Drag this app into the permission list in System Settings"
        setAccessibilityLabel("Drag \(appName) into System Settings")
    }
    required init?(coder: NSCoder) { nil }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8).fill()
    }
    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        item.setDraggingFrame(NSRect(x: 12, y: 10, width: 32, height: 32), contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

/// A small movable panel, not a second permission engine. Electron supplies fresh check results.
final class DesktopPermissionGuide: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let heading = NSTextField(labelWithString: "Checking permissions…")
    private let instructions = NSTextField(wrappingLabelWithString: "")
    private let progress = NSTextField(labelWithString: "")
    private let appPath: String
    private let appName: String
    private let dragView: PermissionAppDragView
    private var input = Data()
    private let labels = ["accessibility": "Accessibility", "screenRecording": "Screen Recording", "inputMonitoring": "Input Monitoring"]

    init(appPath: String, appName: String) {
        self.appPath = appPath
        self.appName = appName
        dragView = PermissionAppDragView(appPath: appPath, appName: appName)
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 276),
            styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Set up \(appName)"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self
        guard let content = panel.contentView else { return }
        heading.frame = NSRect(x: 20, y: 234, width: 340, height: 22)
        heading.font = .systemFont(ofSize: 16, weight: .semibold)
        instructions.frame = NSRect(x: 20, y: 158, width: 340, height: 64)
        instructions.font = .systemFont(ofSize: 13)
        instructions.textColor = .secondaryLabelColor
        progress.frame = NSRect(x: 20, y: 57, width: 340, height: 24)
        progress.font = .systemFont(ofSize: 12, weight: .medium)
        content.addSubview(heading); content.addSubview(instructions)
        content.addSubview(dragView); content.addSubview(progress)
        let reveal = NSButton(title: "Show in Finder", target: self, action: #selector(revealApp))
        reveal.frame = NSRect(x: 16, y: 14, width: 130, height: 30)
        reveal.bezelStyle = .rounded
        content.addSubview(reveal)
        let retry = NSButton(title: "Open Settings", target: self, action: #selector(retrySetup))
        retry.frame = NSRect(x: 222, y: 14, width: 142, height: 30)
        retry.bezelStyle = .rounded
        content.addSubview(retry)
    }

    func start() {
        if let screen = NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - 400, y: screen.visibleFrame.minY + 48))
        }
        panel.orderFrontRegardless()
        // EOF closes the panel if Electron exits. No global hotkey, capture or permission poll here.
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self else { return }
                if data.isEmpty { self.close(); return }
                self.input.append(data)
                if self.input.count > 16_384 { self.close(); return }
                while let newline = self.input.firstIndex(of: 10) {
                    let line = self.input.prefix(upTo: newline)
                    self.input.removeSubrange(...newline)
                    if String(data: line, encoding: .utf8) == "close" { self.close(); return }
                    guard let state = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    self.update(state)
                }
            }
        }
    }

    func update(_ state: [String: Any]) {
        let current = state["current"] as? String
        let required = state["required"] as? [String] ?? []
        let grants = state["grants"] as? [String: String] ?? [:]
        let grantedCount = required.filter { grants[$0] == "granted" }.count
        progress.stringValue = "\(grantedCount) of \(required.count) permissions granted · Checking automatically"
        if state["phase"] as? String == "complete" {
            heading.stringValue = "Permissions granted"
            instructions.stringValue = "You can return to \(appName). If macOS asks you to reopen the app, do so."
            progress.stringValue = "All permissions granted"
            dragView.isHidden = true
        } else {
            heading.stringValue = "Allow \(labels[current ?? ""] ?? "access")"
            instructions.stringValue = state["message"] as? String ?? "Drag the app below into the list, then turn its switch on. We’ll detect the change and move to the next permission automatically."
            dragView.isHidden = false
        }
    }

    private func send(_ action: String) {
        if let data = try? JSONSerialization.data(withJSONObject: ["action": action]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    @objc private func revealApp() { send("reveal") }
    @objc private func retrySetup() { send("retry") }
    func windowShouldClose(_ sender: NSWindow) -> Bool { send("close"); close(); return false }
    private func close() {
        FileHandle.standardInput.readabilityHandler = nil
        panel.orderOut(nil)
        NSApplication.shared.terminate(nil)
    }
}
