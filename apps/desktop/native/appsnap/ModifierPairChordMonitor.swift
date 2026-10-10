import CoreGraphics
import Foundation

private let eventTapRetryInterval = 5.0

/// The modifier whose left and right keys, held together, trigger a capture.
/// Device flag masks are the side-specific NX_DEVICE*KEYMASK bits.
enum AppSnapChordModifier: String {
    case option
    case command

    var leftKeyCode: CGKeyCode { self == .option ? CGKeyCode(0x3A) : CGKeyCode(0x37) }
    var rightKeyCode: CGKeyCode { self == .option ? CGKeyCode(0x3D) : CGKeyCode(0x36) }
    var leftDeviceFlagMask: CGEventFlags {
        CGEventFlags(rawValue: self == .option ? 0x20 : 0x08)
    }
    var rightDeviceFlagMask: CGEventFlags {
        CGEventFlags(rawValue: self == .option ? 0x40 : 0x10)
    }
    var flagMask: CGEventFlags { self == .option ? .maskAlternate : .maskCommand }
    var displayName: String { self == .option ? "Option" : "Command" }
}

private func modifierPairEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<ModifierPairChordMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.handleEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

final class ModifierPairChordMonitor {
    private let emitter: NDJSONEmitter
    private let modifier: AppSnapChordModifier
    private let onChord: () -> Void
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var retryTimer: Timer?
    private var chordIsLatched = false
    private var leftKeyIsDown = false
    private var rightKeyIsDown = false
    private var lastInstallErrorCode: String?
    private var emittedReady = false

    init(
        emitter: NDJSONEmitter,
        modifier: AppSnapChordModifier,
        onChord: @escaping () -> Void
    ) {
        self.emitter = emitter
        self.modifier = modifier
        self.onChord = onChord
    }

    func start() {
        if !installEventTap() {
            scheduleRetry()
        }
    }

    fileprivate func handleEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            resetChordState()
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            emitter.emitError(
                AppSnapFailure(
                    code: "event_tap_disabled",
                    message: "macOS disabled the \(modifier.displayName)-key listener; the helper re-enabled it."
                ),
                capturedAt: appSnapTimestamp()
            )
            return
        }

        guard type == .flagsChanged else {
            return
        }

        let changedKeyCode = CGKeyCode(
            event.getIntegerValueField(.keyboardEventKeycode)
        )
        guard changedKeyCode == modifier.leftKeyCode || changedKeyCode == modifier.rightKeyCode else {
            return
        }
        leftKeyIsDown = event.flags.contains(modifier.leftDeviceFlagMask)
        rightKeyIsDown = event.flags.contains(modifier.rightDeviceFlagMask)

        if !event.flags.contains(modifier.flagMask) {
            resetChordState()
            return
        }

        let bothKeysAreDown = leftKeyIsDown && rightKeyIsDown

        if bothKeysAreDown, !chordIsLatched {
            chordIsLatched = true
            onChord()
        } else if !bothKeysAreDown {
            chordIsLatched = false
        }
    }

    private func resetChordState() {
        leftKeyIsDown = false
        rightKeyIsDown = false
        chordIsLatched = false
    }

    private func installEventTap() -> Bool {
        guard eventTap == nil else {
            return true
        }

        guard CGPreflightListenEventAccess() else {
            reportInstallFailure(
                AppSnapFailure(
                    code: "input-monitoring-required",
                    message: "Input Monitoring permission is required to watch both \(modifier.displayName) keys."
                )
            )
            return false
        }

        let mask = CGEventMask(1) << CGEventType.flagsChanged.rawValue
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: modifierPairEventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not create the passive \(modifier.displayName)-key listener."
                )
            )
            return false
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not attach the \(modifier.displayName)-key listener to the run loop."
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
