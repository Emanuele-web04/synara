import CoreGraphics
import Foundation

private let escapeKeyCode = CGKeyCode(0x35)
private let eventTapRetryInterval = 5.0

/// Modifiers that make an Escape keypress a chord instead of the plain key.
/// Caps Lock and the secondary-Fn state do not change which physical key was
/// pressed, so they do not disqualify the press.
private let escapeDisqualifyingFlags: CGEventFlags = [
    .maskCommand,
    .maskAlternate,
    .maskControl,
    .maskShift,
]

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
/// A dedicated session event tap in `.listenOnly` mode observes keyDown events
/// and reports a plain, unmodified Escape that came from the keyboard itself.
/// The tap never consumes or rewrites the event — the same Escape still reaches
/// the focused application — and it fires only while the parent has armed the
/// monitor, i.e. while a driver generation is live and computer input can
/// actually be in flight.
///
/// Two filters keep the signal honest:
///
/// - Only an unmodified Escape counts. Escape carrying Command, Option,
///   Control, or Shift is a chord that belongs to the application (Force Quit,
///   palette dismissal), not a stop request.
/// - Only hardware-origin keypresses count. An event posted by a process —
///   including the computer-use driver's own synthetic Escape — carries the
///   posting process id in `eventSourceUnixProcessID` and is ignored, so an
///   agent can still send Escape to a window without stopping itself.
final class EscapeKillSwitchMonitor {
    private let emitter: NDJSONEmitter
    private let onEscape: () -> Void
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var retryTimer: Timer?
    private var lastInstallErrorCode: String?
    private var emittedReady = false
    /// Whether the parent process marked computer control live. Nothing is
    /// emitted while disarmed — an Escape on a desktop no agent can drive is
    /// an ordinary key, not a stop request.
    private(set) var armed = false

    init(emitter: NDJSONEmitter, onEscape: @escaping () -> Void) {
        self.emitter = emitter
        self.onEscape = onEscape
    }

    func start() {
        if !installEventTap() {
            scheduleRetry()
        }
    }

    /// Parent-driven arm/disarm. The event tap stays installed either way; the
    /// gate is applied at emit time so a disarm racing an in-flight keypress
    /// still wins.
    func setArmed(_ armed: Bool) {
        guard armed != self.armed else {
            return
        }
        self.armed = armed
        emitter.emitEscapeMonitorState(armed: armed, capturedAt: appSnapTimestamp())
    }

    fileprivate func handleEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            emitter.emitError(
                AppSnapFailure(
                    code: "event_tap_disabled",
                    message: "macOS disabled the Escape listener; the helper re-enabled it."
                ),
                capturedAt: appSnapTimestamp()
            )
            return
        }

        guard type == .keyDown,
              CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)) == escapeKeyCode,
              event.flags.intersection(escapeDisqualifyingFlags).isEmpty,
              event.getIntegerValueField(.eventSourceUnixProcessID) == 0,
              armed
        else {
            return
        }
        onEscape()
    }

    private func installEventTap() -> Bool {
        guard eventTap == nil else {
            return true
        }

        guard CGPreflightListenEventAccess() else {
            reportInstallFailure(
                AppSnapFailure(
                    code: "input-monitoring-required",
                    message: "Input Monitoring permission is required to watch for the Escape key."
                )
            )
            return false
        }

        let mask = CGEventMask(1) << CGEventType.keyDown.rawValue
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
        if !emittedReady {
            emittedReady = true
            emitter.emitReady()
        }
        retryTimer?.invalidate()
        retryTimer = nil
        return true
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
