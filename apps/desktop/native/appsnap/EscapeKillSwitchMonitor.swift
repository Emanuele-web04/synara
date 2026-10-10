import AppKit
import CoreGraphics
import Foundation

private let eventTapRetryInterval = 5.0

private func escapeEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<EscapeKillSwitchMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.handleEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

/// The physical Escape kill switch for computer use.
///
/// A dedicated session event tap in `.listenOnly` mode observes physical input.
/// It reports unmodified Escape globally and other input with target metadata.
/// The tap never consumes or rewrites the event — the same Escape still reaches
/// the focused application — and it fires only while the parent has armed the
/// monitor, i.e. while a driver generation is live and computer input can
/// actually be in flight.
///
/// Every observed event goes through `EscapePhysicalClassifier`, which keeps
/// the signal honest: chords that belong to the application never stop input,
/// and a synthetic Escape posted by any process — the computer-use driver's
/// own included — is an ordinary keystroke that cannot stop the agent.
final class EscapeKillSwitchMonitor {
    private let emitter: NDJSONEmitter
    private let onEscape: () -> Void
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var retryTimer: Timer?
    private var lastInstallErrorCode: String?
    /// Whether the parent process marked computer control live. Nothing is
    /// emitted while disarmed — an Escape on a desktop no agent can drive is
    /// an ordinary key, not a stop request.
    private(set) var armed = false

    init(emitter: NDJSONEmitter, onEscape: @escaping () -> Void) {
        self.emitter = emitter
        self.onEscape = onEscape
    }

    func start() {
        if armed {
            _ = installEventTap()
            scheduleRetry()
        }
    }

    /// Parent-driven arm/disarm. Idle computer use owns no event tap or polling
    /// timer. The emit gate also rejects a callback racing the disarm.
    func setArmed(_ armed: Bool) {
        guard armed != self.armed else {
            return
        }
        self.armed = armed
        if armed {
            lastInstallErrorCode = nil
            _ = installEventTap()
            scheduleRetry()
        } else {
            retryTimer?.invalidate()
            retryTimer = nil
            tearDownEventTap()
        }
        emitter.emitEscapeMonitorState(armed: armed, capturedAt: appSnapTimestamp())
    }

    fileprivate func handleEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            tearDownEventTap()
            emitter.emitError(
                AppSnapFailure(
                    code: "event_tap_disabled",
                    message: "macOS disabled the computer input listener; checking access before reconnecting."
                ),
                capturedAt: appSnapTimestamp()
            )
            _ = installEventTap()
            return
        }

        if EscapePhysicalClassifier.isPhysicalEscape(
                  type: type,
                  keyCode: CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)),
                  flags: event.flags,
                  sourceProcessID: event.getIntegerValueField(.eventSourceUnixProcessID),
                  sourceStateID: event.getIntegerValueField(.eventSourceStateID),
                  sourceUserData: event.getIntegerValueField(.eventSourceUserData),
                  armed: armed
              ) {
            onEscape()
            return
        }
        guard EscapePhysicalClassifier.isPhysicalInput(
            type: type,
            sourceProcessID: event.getIntegerValueField(.eventSourceUnixProcessID),
            sourceStateID: event.getIntegerValueField(.eventSourceStateID),
            sourceUserData: event.getIntegerValueField(.eventSourceUserData),
            armed: armed
        ) else { return }
        let keyboard = type == .keyDown || type == .flagsChanged
        let target = physicalTarget(event: event, keyboard: keyboard)
        emitter.emitPhysicalInput(
            kind: keyboard ? "keyboard" : "pointer",
            pid: target.pid,
            windowID: target.windowID,
            capturedAt: appSnapTimestamp()
        )
    }

    /// Keyboard input belongs to the frontmost application; pointer takeover
    /// belongs to the first visible application window at the click/scroll.
    /// Ignore overlay layers and omit unknown attribution rather than guessing.
    private func physicalTarget(event: CGEvent, keyboard: Bool) -> (pid: pid_t?, windowID: CGWindowID?) {
        if keyboard {
            return (NSWorkspace.shared.frontmostApplication?.processIdentifier, nil)
        }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return (nil, nil)
        }
        for window in windows {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let pid = window[kCGWindowOwnerPID as String] as? Int32, pid > 0,
                  let windowID = window[kCGWindowNumber as String] as? UInt32,
                  let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
                  bounds.contains(event.location) else { continue }
            return (pid, windowID)
        }
        return (nil, nil)
    }

    private func installEventTap() -> Bool {
        guard armed else { return false }
        guard CGPreflightListenEventAccess() else {
            tearDownEventTap()
            reportInstallFailure(
                AppSnapFailure(
                    code: "input-monitoring-required",
                    message: "Input Monitoring permission is required for Escape and human takeover detection."
                )
            )
            return false
        }
        if let eventTap, CGEvent.tapIsEnabled(tap: eventTap) { return true }
        tearDownEventTap()

        let observed: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        let mask = observed.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: escapeEventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not create the passive Escape listener."
                )
            )
            return false
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not attach the Escape listener to the run loop."
                )
            )
            return false
        }

        eventTap = tap
        runLoopSource = source
        lastInstallErrorCode = nil
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        emitter.emitReady()
        return true
    }

    private func tearDownEventTap() {
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        if let eventTap { CFMachPortInvalidate(eventTap) }
        runLoopSource = nil
        eventTap = nil
    }

    private func scheduleRetry() {
        guard retryTimer == nil else {
            return
        }
        retryTimer = Timer.scheduledTimer(
            withTimeInterval: eventTapRetryInterval,
            repeats: true
        ) { [weak self] _ in
            _ = self?.installEventTap()
        }
    }

    private func reportInstallFailure(_ failure: AppSnapFailure) {
        guard lastInstallErrorCode != failure.code else {
            return
        }
        lastInstallErrorCode = failure.code
        emitter.emitError(failure, capturedAt: appSnapTimestamp())
    }
}

/// Reads the parent's `arm` / `disarm` lines from stdin while the helper runs
/// in `--escape-monitor` mode. EOF disarms the monitor as a fail-safe; the
/// ParentProcessMonitor still owns process exit when the parent dies.
final class EscapeCommandListener {
    private let emitter: NDJSONEmitter
    private let onArmChange: (Bool) -> Void
    private var buffer = Data()

    init(emitter: NDJSONEmitter, onArmChange: @escaping (Bool) -> Void) {
        self.emitter = emitter
        self.onArmChange = onArmChange
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                DispatchQueue.main.async { [onArmChange] in
                    onArmChange(false)
                }
                return
            }
            self.consume(data)
        }
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

    private func handle(line: String) {
        switch line {
        case "arm":
            DispatchQueue.main.async { [onArmChange] in
                onArmChange(true)
            }
        case "disarm":
            DispatchQueue.main.async { [onArmChange] in
                onArmChange(false)
            }
        default:
            emitter.emitError(
                AppSnapFailure(
                    code: "invalid_request",
                    message: "Unknown Escape monitor request."
                ),
                capturedAt: appSnapTimestamp()
            )
        }
    }
}
