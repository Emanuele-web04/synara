import AppKit
import Darwin
import Foundation

let emitter = NDJSONEmitter()

do {
    let options = try AppSnapOptions.parse(Array(CommandLine.arguments.dropFirst()))
    switch options.mode {
    case let .checkPermissions(selectedPermissions):
        emitter.emitPermissions(preflightAppSnapPermissions(selectedPermissions))
    case let .requestPermissions(selectedPermissions, appPath):
        try MainActor.assumeIsolated { try ensurePermissionSetupAppRegistration(appPath: appPath) }
        emitter.emitPermissions(requestAppSnapPermissions(selectedPermissions))
    case let .preparePermissionSetup(selectedPermissions, appPath):
        try MainActor.assumeIsolated { try ensurePermissionSetupAppRegistration(appPath: appPath) }
        emitter.emitPermissions(preflightAppSnapPermissions(selectedPermissions))
    case .releaseHeldInput:
        emitter.emit(releaseHeldInputEvents())
    case let .watch(outputDirectory, excludedBundleIdentifier, externalTrigger):
        _ = umask(0o077)
        try preparePrivateOutputDirectory(outputDirectory)
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let coordinator = AppSnapCaptureCoordinator(
            emitter: emitter,
            outputDirectory: outputDirectory,
            excludedBundleIdentifier: excludedBundleIdentifier
        )
        let parentProcessMonitor = ParentProcessMonitor()
        parentProcessMonitor.start()

        let requestListener = ExternalTriggerListener(
            emitter: emitter,
            emitsReady: externalTrigger
        ) {
            coordinator.handleGesture()
        } onListWindows: { requestId in
            coordinator.handleListWindows(requestId: requestId)
        } onCaptureWindow: { requestId, windowID in
            coordinator.handleCaptureWindow(windowID: windowID, requestId: requestId)
        }
        requestListener.start()

        let gestureSource: AnyObject
        if externalTrigger {
            gestureSource = requestListener
        } else {
            let monitor = OptionChordMonitor(emitter: emitter) {
                coordinator.handleGesture()
            }
            monitor.start()
            gestureSource = monitor
        }

        withExtendedLifetime((coordinator, gestureSource, requestListener, parentProcessMonitor)) {
            RunLoop.main.run()
        }
    case .shield:
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let (controller, requestListener, parentProcessMonitor): (
            ActivationShieldController, ShieldCommandListener, ParentProcessMonitor
        ) = MainActor.assumeIsolated {
            let controller = ActivationShieldController(emitter: emitter)
            controller.start()
            let requestListener = ShieldCommandListener(
                emitter: emitter,
                controller: controller
            )
            let parentProcessMonitor = ParentProcessMonitor()
            parentProcessMonitor.start()
            requestListener.start()
            return (controller, requestListener, parentProcessMonitor)
        }

        // NSApplication.run() pumps the run loop the shield's timers, the
        // workspace/screen observers, and the best-effort Escape monitor all
        // ride — the same reason the permission guide uses it.
        withExtendedLifetime((controller, requestListener, parentProcessMonitor)) {
            NSApplication.shared.run()
        }
    case let .computerFrames(windowID, ownerPID, socketPath):
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let tap = ComputerFrameTap(
            emitter: emitter,
            windowID: windowID,
            ownerPID: ownerPID,
            socketPath: socketPath
        )
        let parentProcessMonitor = ParentProcessMonitor()
        parentProcessMonitor.start()
        tap.start()

        withExtendedLifetime((tap, parentProcessMonitor)) {
            RunLoop.main.run()
        }
    case .escapeMonitor:
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let parentProcessMonitor = ParentProcessMonitor()
        parentProcessMonitor.start()

        let monitor = EscapeKillSwitchMonitor(emitter: emitter) {
            emitter.emitEscape(capturedAt: appSnapTimestamp())
        }
        monitor.start()

        // The parent arms the monitor only while a driver generation is live;
        // EOF disarms as a fail-safe.
        let commandListener = EscapeCommandListener(emitter: emitter) { armed in
            monitor.setArmed(armed)
        }
        commandListener.start()

        withExtendedLifetime((monitor, commandListener, parentProcessMonitor)) {
            RunLoop.main.run()
        }
    case let .permissionGuide(pane, appPath, appName):
        try MainActor.assumeIsolated { try ensurePermissionSetupAppRegistration(appPath: appPath) }
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let (coach, parentProcessMonitor): (GrantCoach, ParentProcessMonitor) = MainActor.assumeIsolated {
            let coach = GrantCoach(
                appName: appName,
                appPath: appPath,
                pane: pane
            )
            let parentProcessMonitor = ParentProcessMonitor()
            parentProcessMonitor.start()
            coach.present(
                onGranted: {
                    emitter.emitPermissionGuide(state: "granted")
                    exit(0)
                },
                onDismissed: {
                    emitter.emitPermissionGuide(state: "closed")
                    exit(0)
                }
            )
            return (coach, parentProcessMonitor)
        }

        // The parent closes the guide by writing a `close` line to stdin.
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                return
            }
            let line = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard line == "close" else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    coach.dismissFromEscape()
                }
            }
        }

        // NSApplication.run() is what pumps NSEvents; a bare RunLoop.main.run()
        // never dispatches mouse events, which left the drag chip dead.
        withExtendedLifetime((coach, parentProcessMonitor)) {
            NSApplication.shared.run()
        }
    }
} catch let failure as AppSnapFailure {
    emitter.emitError(failure, capturedAt: appSnapTimestamp())
    exit(EX_USAGE)
} catch {
    emitter.emitError(
        AppSnapFailure(
            code: "helper_failed",
            message: error.localizedDescription
        ),
        capturedAt: appSnapTimestamp()
    )
    exit(EXIT_FAILURE)
}
