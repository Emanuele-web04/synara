import AppKit
import ApplicationServices

/// Synara permission coach: draggable app chip next to System Settings.
/// Drag follows zats/permiso's AppDragSourceView. Panel moves by background;
/// the chip opts out so dragging it never moves the coach.

final class AppDragView: NSView, NSPasteboardItemDataProvider, NSDraggingSource {
    private let dragURL: URL
    private let titleField: NSTextField
    private let iconView = NSImageView()
    private let gripView = NSImageView()
    init(frame frameRect: NSRect, appName: String, appPath: String, toolTipText: String) {
        dragURL = URL(fileURLWithPath: appPath)
        titleField = NSTextField(labelWithString: appName)
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.borderWidth = 0.5
        gripView.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: nil)
        gripView.contentTintColor = .tertiaryLabelColor
        gripView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(gripView)
        if let icon = NSWorkspace.shared.icon(forFile: appPath) as NSImage?,
           !icon.isTemplate, icon.size.width > 1 {
            iconView.image = icon
        } else if let symbol = NSImage(systemSymbolName: "app.fill", accessibilityDescription: nil) {
            iconView.image = symbol
            iconView.contentTintColor = .labelColor
        }
        iconView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(iconView)
        titleField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        titleField.textColor = .labelColor
        titleField.alignment = .left
        addSubview(titleField)
        toolTip = toolTipText
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidChangeEffectiveAppearance() {
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        layer?.borderColor = NSColor.separatorColor.cgColor
    }
    override func layout() {
        super.layout()
        let icon: CGFloat = 16, inset: CGFloat = 8, gap: CGFloat = 4
        gripView.frame = NSRect(x: inset, y: (bounds.height - 12) / 2, width: 12, height: 12)
        let iconX = inset + 14 + gap
        iconView.frame = NSRect(x: iconX, y: (bounds.height - icon) / 2, width: icon, height: icon)
        let titleX = iconX + icon + gap
        titleField.frame = NSRect(x: titleX, y: (bounds.height - 20) / 2, width: max(0, bounds.width - titleX - inset), height: 20)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard bounds.contains(point) else { return nil }
        return self
    }
    override func mouseDown(with event: NSEvent) {
        let item = NSPasteboardItem()
        item.setDataProvider(self, forTypes: [.fileURL])
        let fileItem = NSDraggingItem(pasteboardWriter: item)
        fileItem.setDraggingFrame(bounds, contents: dragImage())
        let session = beginDraggingSession(with: [fileItem], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard type == .fileURL else { return }
        item.setData(dragURL.dataRepresentation, forType: .fileURL)
    }
    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) { isHidden = true }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { isHidden = false }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    private func dragImage() -> NSImage {
        let image = NSImage(size: bounds.size)
        image.lockFocus()
        displayIgnoringOpacity(bounds, in: NSGraphicsContext.current!)
        image.unlockFocus()
        return image
    }
}

@MainActor
final class GrantCoach {
    private let appName: String
    private let appPath: String
    private let pane: String
    private var isPresented = false
    private var settingsOpen = false
    private var panel: NSPanel?
    private var grantTimer: Timer?
    private var followTimer: Timer?
    private var escapeMonitor: Any?
    private var onGranted: (() -> Void)?
    private var onDismissed: (() -> Void)?
    private var lastFollow = CGRect.null
    init(appName: String, appPath: String, pane: String) {
        self.appName = appName
        self.appPath = appPath
        self.pane = pane
    }
    private var paneTitle: String {
        pane == "accessibility" ? "Accessibility" : "Screen Recording"
    }
    private var allowsDrop: Bool { pane != "accessibility" }
    private var headline: String {
        allowsDrop
            ? "Drop \(appName) on the list above."
            : "Turn \(appName) on in the list above."
    }
    func present(onGranted: @escaping () -> Void, onDismissed: (() -> Void)? = nil) {
        self.onGranted = onGranted
        self.onDismissed = onDismissed
        if panel == nil { build() }
        isPresented = true
        settingsOpen = false
        lastFollow = .null
        installEscapeMonitor()
        follow()
        grantTimer?.invalidate()
        grantTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkGranted() }
        }
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.follow() }
        }
    }
    func dismiss() {
        guard isPresented else { return }
        isPresented = false
        settingsOpen = false
        grantTimer?.invalidate()
        grantTimer = nil
        followTimer?.invalidate()
        followTimer = nil
        removeEscapeMonitor()
        panel?.orderOut(nil)
    }
    func dismissFromEscape() {
        guard isPresented else { return }
        dismiss()
        onDismissed?()
    }
    private func installEscapeMonitor() {
        guard escapeMonitor == nil else { return }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let strongSelf = self else { return event }
            if event.keyCode == 53 {
                Task { @MainActor in strongSelf.dismissFromEscape() }
                return nil
            }
            return event
        }
    }
    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
            escapeMonitor = nil
        }
    }
    private func checkGranted() {
        let granted = pane == "accessibility" ? AXIsProcessTrusted() : CGPreflightScreenCaptureAccess()
        if granted {
            onGranted?()
            dismiss()
        }
    }
    private func build() {
        let width: CGFloat = 360, pad: CGFloat = 16, gap: CGFloat = 12, row: CGFloat = 20, chipHeight: CGFloat = 36
        let hintHeight: CGFloat = 34
        let height = pad + row + gap + (allowsDrop ? chipHeight : hintHeight) + pad
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = true
        let card = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        card.wantsLayer = true
        card.layer?.cornerRadius = 12
        card.layer?.cornerCurve = .continuous
        card.layer?.borderWidth = 0.5
        card.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        card.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = card
        let arrowY = height - pad - row
        let arrow = NSImageView(frame: NSRect(x: pad, y: arrowY, width: row, height: row))
        arrow.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)
        arrow.contentTintColor = .controlAccentColor
        arrow.imageScaling = .scaleProportionallyUpOrDown
        card.addSubview(arrow)
        let title = NSTextField(labelWithString: headline)
        title.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        title.textColor = .labelColor
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: pad + row + 8, y: arrowY, width: width - pad * 2 - row - 8, height: row)
        card.addSubview(title)
        if allowsDrop {
            let chip = AppDragView(frame: NSRect(x: pad, y: pad, width: width - pad * 2, height: chipHeight),
                                   appName: appName, appPath: appPath,
                                   toolTipText: "Drag \(appName) onto the \(paneTitle) list")
            card.addSubview(chip)
        } else {
            let hint = NSTextField(labelWithString: "Use the toggle. If the app is missing, click + and add it.")
            hint.font = NSFont.systemFont(ofSize: 12)
            hint.textColor = .secondaryLabelColor
            hint.lineBreakMode = .byWordWrapping
            hint.maximumNumberOfLines = 2
            hint.frame = NSRect(x: pad, y: pad, width: width - pad * 2, height: hintHeight)
            card.addSubview(hint)
        }
        self.panel = panel
    }
    private func follow() {
        guard isPresented, let panel else { return }
        guard let settings = settingsCocoaFrame() else {
            // System Settings is closed: hide the coach instead of parking it
            // mid-screen. The session survives; reopening Settings (or pressing
            // Grant again) brings the coach back.
            if settingsOpen {
                settingsOpen = false
                panel.orderOut(nil)
            }
            return
        }
        let size = panel.frame.size
        let next = attachedFrame(settings: settings, size: size)
        if !settingsOpen {
            settingsOpen = true
            panel.orderFrontRegardless()
        }
        if !lastFollow.isNull {
            if abs(next.midX - lastFollow.midX) < 3, abs(next.midY - lastFollow.midY) < 3 { return }
        }
        lastFollow = next
        panel.setFrame(next, display: true)
    }
    private func attachedFrame(settings: CGRect, size: CGSize) -> CGRect {
        let sidebar = min(280, max(200, floor(settings.width * 0.34)))
        let paneX = settings.minX + sidebar
        let paneW = max(size.width, settings.width - sidebar)
        var x = paneX + paneW / 2 - size.width / 2
        var y = settings.minY - size.height + 28
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settings) }) ?? NSScreen.main {
            let visible = screen.visibleFrame
            x = min(max(x, visible.minX + 12), visible.maxX - size.width - 12)
            y = min(max(y, visible.minY + 8), settings.minY - 8)
        }
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }
    private func settingsCocoaFrame() -> CGRect? {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
        var best: CGRect?
        var bestArea: CGFloat = 0
        for w in info {
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            guard owner == "System Settings" || owner == "System Preferences" else { continue }
            guard (w[kCGWindowLayer as String] as? Int ?? 0) == 0 else { continue }
            let raw = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            let cg = CGRect(x: raw["X"] ?? 0, y: raw["Y"] ?? 0, width: raw["Width"] ?? 0, height: raw["Height"] ?? 0)
            guard cg.width >= 480, cg.height >= 360 else { continue }
            let area = cg.width * cg.height
            if area > bestArea {
                bestArea = area
                let maxY = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.frame.maxY ?? cg.maxY
                best = CGRect(x: cg.origin.x, y: maxY - cg.origin.y - cg.height, width: cg.width, height: cg.height)
            }
        }
        return best
    }
}
