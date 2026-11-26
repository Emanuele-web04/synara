import AppKit
import ApplicationServices

/// Synara permission coach: a card that floats under System Settings and says
/// which switch to turn on, and what to do when macOS has not listed the app.
@MainActor
final class GrantCoach: NSObject {
    private let appName: String
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
    init(appName: String, pane: String) {
        self.appName = appName
        self.pane = pane
        super.init()
    }
    private var headline: String {
        "Turn on \(appName) in the list above."
    }
    private var hint: String {
        "Not listed? Press Add and choose \(appName)."
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
    @objc private func closeGuide() {
        dismissFromEscape()
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
        let granted: Bool
        switch pane {
        case "accessibility": granted = AXIsProcessTrusted()
        case "input-monitoring": granted = CGPreflightListenEventAccess()
        default: granted = CGPreflightScreenCaptureAccess()
        }
        if granted {
            onGranted?()
            dismiss()
        }
    }
    private func build() {
        let width: CGFloat = 360, pad: CGFloat = 16, arrow: CGFloat = 20
        let row: CGFloat = 20, lineGap: CGFloat = 4
        let height = pad + row + lineGap + row + pad
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
        let headlineY = height - pad - row
        let arrowView = NSImageView(frame: NSRect(x: pad, y: headlineY, width: arrow, height: row))
        arrowView.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)
        arrowView.contentTintColor = .controlAccentColor
        arrowView.imageScaling = .scaleProportionallyUpOrDown
        card.addSubview(arrowView)
        let title = NSTextField(labelWithString: headline)
        title.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        title.textColor = .labelColor
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: pad + arrow + 8, y: headlineY, width: width - pad * 2 - arrow * 2 - 16, height: row)
        card.addSubview(title)
        // A direct close action also works before keyboard-monitoring permission
        // is granted, while System Settings keeps the keyboard focus.
        let closeButton = NSButton(title: "", target: self, action: #selector(closeGuide))
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: nil)
        closeButton.frame = NSRect(x: width - pad - arrow, y: headlineY, width: arrow, height: row)
        closeButton.isBordered = false
        closeButton.refusesFirstResponder = true
        closeButton.imagePosition = .imageOnly
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.toolTip = "Close permission guide"
        closeButton.setAccessibilityLabel("Close permission guide")
        card.addSubview(closeButton)
        let hintView = NSTextField(labelWithString: hint)
        hintView.font = NSFont.systemFont(ofSize: 12)
        hintView.textColor = .secondaryLabelColor
        hintView.lineBreakMode = .byTruncatingTail
        hintView.frame = NSRect(x: pad + arrow + 8, y: pad, width: width - pad * 2 - arrow - 8, height: row)
        hintView.toolTip = "Not listed? Press Add at the bottom of the list and choose \(appName)."
        card.addSubview(hintView)
        panel.setAccessibilityLabel("Turn on \(appName) in the permission list")
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
