import CoreGraphics
import Foundation

private let leftOptionKeyCode = CGKeyCode(0x3A)
private let rightOptionKeyCode = CGKeyCode(0x3D)
private let leftOptionDeviceFlagMask = CGEventFlags(rawValue: 0x20)
private let rightOptionDeviceFlagMask = CGEventFlags(rawValue: 0x40)
private let eventTapRetryInterval = 5.0

private func optionEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<OptionChordMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.handleEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

final class OptionChordMonitor {
    private let emitter: NDJSONEmitter
    private let onChord: () -> Void
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var retryTimer: Timer?
    private var chordIsLatched = false
    private var leftOptionIsDown = false
    private var rightOptionIsDown = false
    private var lastInstallErrorCode: String?
    private var emittedReady = false

    init(emitter: NDJSONEmitter, onChord: @escaping () -> Void) {
        self.emitter = emitter
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
                    message: "macOS disabled the Option-key listener; the helper re-enabled it."
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
        switch changedKeyCode {
        case leftOptionKeyCode, rightOptionKeyCode:
            leftOptionIsDown = event.flags.contains(leftOptionDeviceFlagMask)
            rightOptionIsDown = event.flags.contains(rightOptionDeviceFlagMask)
        default:
            return
        }

        if !event.flags.contains(.maskAlternate) {
            resetChordState()
            return
        }

        let bothOptionsAreDown = leftOptionIsDown && rightOptionIsDown

        if bothOptionsAreDown, !chordIsLatched {
            chordIsLatched = true
            onChord()
        } else if !bothOptionsAreDown {
            chordIsLatched = false
        }
    }

    private func resetChordState() {
        leftOptionIsDown = false
        rightOptionIsDown = false
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
                    message: "Input Monitoring permission is required to watch both Option keys."
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
            callback: optionEventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not create the passive Option-key listener."
                )
            )
            return false
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            reportInstallFailure(
                AppSnapFailure(
                    code: "event_tap_unavailable",
                    message: "macOS could not attach the Option-key listener to the run loop."
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
