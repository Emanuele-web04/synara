import AppKit
import CoreGraphics
import Foundation

/// Masked-activation shield: a Synara-owned overlay that veils the target
/// window's frame for the length of one approved foreground excursion.
///
/// The design constraint is from the masked-activation spike: foreign window
/// mutation is not ours to write, so the shield is an OWN-WINDOW overlay —
/// a non-activating NSPanel this process paints at status-bar level over the
/// target's screen rect. It hides the activation artifact (the window
/// popping forward), not the input itself, and it is deliberately
/// click-through: an operator's keystroke can still land on the target, so
/// the shield must never pretend to isolate input — it only discloses it.
///
/// Cleanup is layered, most reliable first:
///
/// - WindowServer removes this process's windows outright when it exits, so
///   a crashed or killed helper can never leave a stuck overlay.
/// - `ParentProcessMonitor` exits the helper when the Electron host dies.
/// - stdin EOF drops every shield (`host-disconnected`).
/// - Each shield carries a TTL far longer than any legitimate excursion.
/// - Space changes (`activeSpaceDidChangeNotification`) and display changes
///   (`didChangeScreenParametersNotification`) release all shields: a mask
///   painted over coordinates from a different Space lies about what it covers.
/// - A global Escape monitor is installed best-effort — it only receives
///   keyDown events when this process holds Input Monitoring trust, so the
///   certain operator escape remains the protocol's `release-all` command.

private let shieldIdentifierPattern = try! NSRegularExpression(
    pattern: #"^[A-Za-z0-9_-]{1,64}$"#
)

/// A masked excursion is measured in hundreds of milliseconds. Thirty
/// seconds is long enough that no legitimate engage outlives it and short
/// enough that a wedged host cannot strand an overlay on screen.
private let shieldTTL: TimeInterval = 30

/// The shield budget. Masked activation engages one shield per operation and
/// operations are serialized, so anything past a handful is a leak or abuse.
private let shieldLimit = 8

final class ShieldContentView: NSView {
    init(frame frameRect: NSRect, label: String?) {
        super.init(frame: frameRect)
        wantsLayer = true
        let accent = NSColor.controlAccentColor
        layer?.backgroundColor = accent.withAlphaComponent(0.14).cgColor
        layer?.borderColor = accent.withAlphaComponent(0.9).cgColor
        layer?.borderWidth = 2
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous

        let text = label.flatMap { $0.isEmpty ? nil : $0 } ?? "Synara is activating this window"
        let field = NSTextField(labelWithString: text)
        field.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        field.textColor = .white
        field.lineBreakMode = .byTruncatingTail
        field.sizeToFit()
        let pillPadding: CGFloat = 10
        let pillHeight = field.frame.height + 8
        let pillWidth = min(
            field.frame.width + pillPadding * 2,
            max(0, frameRect.width - 24)
        )
        let pill = NSView(
            frame: NSRect(
                x: (frameRect.width - pillWidth) / 2,
                y: frameRect.height - pillHeight - 10,
                width: pillWidth,
                height: pillHeight
            )
        )
        pill.wantsLayer = true
        pill.layer?.cornerRadius = pillHeight / 2
        pill.layer?.cornerCurve = .continuous
        pill.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.75).cgColor
        field.frame = NSRect(
            x: pillPadding,
            y: (pillHeight - field.frame.height) / 2,
            width: max(0, pillWidth - pillPadding * 2),
            height: field.frame.height
        )
        pill.addSubview(field)
        addSubview(pill)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

@MainActor
final class ActivationShieldController {
    private let emitter: NDJSONEmitter
    private var panels: [String: NSPanel] = [:]
    private var expiryTimers: [String: Timer] = [:]
    private var observers: [NSObjectProtocol] = []
    private var escapeMonitor: Any?
    private var started = false

    init(emitter: NDJSONEmitter) {
        self.emitter = emitter
    }

    func start() {
        guard !started else { return }
        started = true
        observers.append(
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.activeSpaceDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.releaseAll(reason: "space-changed") }
            }
        )
        observers.append(
            NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.releaseAll(reason: "display-changed") }
            }
        )
        // Global Escape is best-effort: without Input Monitoring trust the
        // monitor is installed but never receives events, so the documented
        // operator escape stays the `release-all` protocol command.
        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return }
            Task { @MainActor in self?.releaseAll(reason: "operator-escape") }
        }
    }

    /// Idempotent: re-engaging a live id re-confirms it rather than stacking
    /// a second panel over the first.
    func engage(id: String, frame: CGRect, label: String?) {
        if panels[id] != nil {
            emitShield(id: id, state: "engaged")
            return
        }
        guard panels.count < shieldLimit else {
            emitShield(id: id, state: "refused", reason: "shield-limit")
            return
        }
        let panel = buildPanel(frame: frame, label: label)
        panels[id] = panel
        expiryTimers[id] = Timer.scheduledTimer(withTimeInterval: shieldTTL, repeats: false) {
            [weak self] _ in
            Task { @MainActor in self?.release(id: id, reason: "ttl-expired") }
        }
        // orderFrontRegardless draws without activating the app — the whole
        // point of the shield is that the target's activation artifact is the
        // only thing that moves.
        panel.orderFrontRegardless()
        emitShield(id: id, state: "engaged")
    }

    func release(id: String, reason: String) {
        expiryTimers.removeValue(forKey: id)?.invalidate()
        guard let panel = panels.removeValue(forKey: id) else {
            emitShield(id: id, state: "released", reason: "already-gone")
            return
        }
        panel.orderOut(nil)
        panel.close()
        emitShield(id: id, state: "released", reason: reason)
    }

    func releaseAll(reason: String) {
        for id in panels.keys {
            release(id: id, reason: reason)
        }
    }

    private func emitShield(id: String, state: String, reason: String? = nil) {
        var payload: [String: Any] = [
            "type": "shield",
            "id": id,
            "state": state,
            "capturedAt": appSnapTimestamp(),
        ]
        if let reason {
            payload["reason"] = reason
        }
        emitter.emit(payload)
    }

    private func buildPanel(frame: CGRect, label: String?) -> NSPanel {
        let cocoaFrame = cocoaRect(for: frame)
        let panel = NSPanel(
            contentRect: cocoaFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        // kCGStatusWindowLevel (25): above the menu bar and the just-raised
        // target window, below popup menus — the level the spike verified.
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Click-through on purpose: the shield discloses the excursion and
        // must never pretend to isolate the operator's input from the target.
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.ignoresCycle, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.contentView = ShieldContentView(
            frame: NSRect(origin: .zero, size: cocoaFrame.size),
            label: label
        )
        return panel
    }

    /// CGWindowList bounds are top-left-origin screen points; AppKit frames
    /// are bottom-left-origin. The conversion keys off the primary screen's
    /// maxY exactly like the permission coach's frame math.
    private func cocoaRect(for cg: CGRect) -> CGRect {
        let primaryMaxY =
            (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main
                ?? NSScreen.screens.first)?.frame.maxY ?? cg.maxY
        return CGRect(
            x: cg.origin.x,
            y: primaryMaxY - cg.origin.y - cg.height,
            width: cg.width,
            height: cg.height
        )
    }
}

/// Reads shield commands from the parent's stdin, one per line:
///
///   engage <id> <x> <y> <width> <height> <label…>
///   release <id>
///   release-all
///   quit
///
/// Geometry is CG screen coordinates (top-left origin, points). The label is
/// everything after the sixth field and may contain spaces; it is already
/// sanitized by the host protocol parser before it reaches this process.
final class ShieldCommandListener {
    private let emitter: NDJSONEmitter
    private let controller: ActivationShieldController
    private var buffer = Data()

    init(emitter: NDJSONEmitter, controller: ActivationShieldController) {
        self.emitter = emitter
        self.controller = controller
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                // EOF: the host closed stdin. Drop every shield now — the
                // ParentProcessMonitor poll owns the actual exit.
                FileHandle.standardInput.readabilityHandler = nil
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self.controller.releaseAll(reason: "host-disconnected")
                    }
                }
                return
            }
            self.consume(data)
        }
        emitter.emitReady()
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = String(data: buffer[buffer.startIndex ..< newlineIndex], encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(buffer.startIndex ... newlineIndex)
            guard let line, !line.isEmpty else {
                continue
            }
            handle(line: line)
        }
    }

    private func invalid(_ message: String, id: String? = nil) {
        emitter.emitError(
            AppSnapFailure(code: "invalid_request", message: message),
            capturedAt: appSnapTimestamp(),
            id: id
        )
    }

    private func handle(line: String) {
        // The label is the remainder after the sixth field, spaces included.
        let parts = line.split(
            separator: " ",
            maxSplits: 6,
            omittingEmptySubsequences: true
        ).map(String.init)

        switch parts.first {
        case "engage":
            guard parts.count >= 6 else {
                invalid("engage requires an id and a frame.", id: parts.dropFirst().first)
                return
            }
            let id = parts[1]
            let idRange = NSRange(id.startIndex ..< id.endIndex, in: id)
            guard shieldIdentifierPattern.firstMatch(in: id, range: idRange)?.range == idRange else {
                invalid("engage requires a printable shield id.", id: nil)
                return
            }
            guard let x = Double(parts[2]),
                  let y = Double(parts[3]),
                  let width = Double(parts[4]),
                  let height = Double(parts[5]),
                  x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                  width > 0, height > 0
            else {
                invalid("engage requires finite positive geometry.", id: id)
                return
            }
            let label = parts.count > 6 ? parts[6] : nil
            let frame = CGRect(x: x, y: y, width: width, height: height)
            DispatchQueue.main.async { [controller] in
                MainActor.assumeIsolated {
                    controller.engage(id: id, frame: frame, label: label)
                }
            }
        case "release" where parts.count == 2:
            let id = parts[1]
            DispatchQueue.main.async { [controller] in
                MainActor.assumeIsolated {
                    controller.release(id: id, reason: "explicit")
                }
            }
        case "release-all" where parts.count == 1:
            DispatchQueue.main.async { [controller] in
                MainActor.assumeIsolated {
                    controller.releaseAll(reason: "explicit")
                }
            }
        case "quit" where parts.count == 1:
            DispatchQueue.main.async { [controller] in
                MainActor.assumeIsolated {
                    controller.releaseAll(reason: "quit")
                }
                exit(EXIT_SUCCESS)
            }
        default:
            invalid("Unknown shield helper request.")
        }
    }
}
