import AppKit
import Darwin
import Foundation

let emitter = NDJSONEmitter()

do {
    let options = try AppSnapOptions.parse(Array(CommandLine.arguments.dropFirst()))
    switch options.mode {
    case .checkPermissions:
        let permissions = preflightAppSnapPermissions()
        emitter.emitPermissions(
            inputMonitoring: permissions.inputMonitoring,
            screenRecording: permissions.screenRecording
        )
    case .requestPermissions:
        let permissions = requestAppSnapPermissions()
        emitter.emitPermissions(
            inputMonitoring: permissions.inputMonitoring,
            screenRecording: permissions.screenRecording
        )
    case let .watch(outputDirectory, excludedBundleIdentifier):
        _ = umask(0o077)
        try preparePrivateOutputDirectory(outputDirectory)
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let coordinator = AppSnapCaptureCoordinator(
            emitter: emitter,
            outputDirectory: outputDirectory,
            excludedBundleIdentifier: excludedBundleIdentifier
        )
        let monitor = OptionChordMonitor(emitter: emitter) {
            coordinator.handleGesture()
        }
        let parentProcessMonitor = ParentProcessMonitor()
        parentProcessMonitor.start()
        monitor.start()

        withExtendedLifetime((coordinator, monitor, parentProcessMonitor)) {
            RunLoop.main.run()
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
