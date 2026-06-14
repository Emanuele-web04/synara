import AppKit
import Darwin
import Foundation
import DoTheThingKit

private let appAgentCommand = "__dothething-app-agent"
private let appAgentDisableEnvironmentKey = "DOTHETHING_DISABLE_APP_AGENT_PROXY"
private let suppressOnboardingEnvironmentKey = "DOTHETHING_SUPPRESS_ONBOARDING"
private let appAgentProcessStartDate = Date()

enum MacOSAppAgentProxy {
    static func isAgentInvocation(arguments: [String]) -> Bool {
        arguments.first == appAgentCommand
    }

    @MainActor
    static func runAgent(arguments: [String]) throws {
        guard arguments.count == 2 else {
            throw DoTheThingCLIError(message: "\(appAgentCommand) requires a socket path")
        }

        try MacOSAppAgentRuntime.run(socketPath: arguments[1])
    }

    static func shouldProxy(command: DoTheThingCLICommand) -> Bool {
        shouldUseMacOSAppAgentProxy(
            command: command,
            proxyDisabled: proxyDisabled,
            appBundleAvailable: PermissionSupport.currentAppBundleURL() != nil,
            runningFromLaunchServicesAppInstance: isRunningFromLaunchServicesAppInstance
        )
    }

    @MainActor
    static func runProxy(command: DoTheThingCLICommand, arguments: [String]) throws -> Int32 {
        guard let appURL = PermissionSupport.currentAppBundleURL() else {
            throw DoTheThingCLIError(message: "Unable to locate Do The Thing.app for app-scoped macOS permissions.")
        }

        let socketPath = defaultSocketPath(appBundleURL: appURL)
        let client = try connectOrLaunchAgent(socketPath: socketPath, appURL: appURL)

        switch command {
        case .mcp:
            try proxyMCP(client: client)
            return EXIT_SUCCESS
        default:
            let response = try sendCLIRequest(arguments: arguments, client: client)
            if !response.stdout.isEmpty {
                FileHandle.standardOutput.write(Data(response.stdout.utf8))
            }
            if !response.stderr.isEmpty {
                FileHandle.standardError.write(Data(response.stderr.utf8))
            }
            return response.exitCode
        }
    }

    private static var proxyDisabled: Bool {
        let value = ProcessInfo.processInfo.environment[appAgentDisableEnvironmentKey]?.lowercased()
        return value == "1" || value == "true" || value == "yes" || value == "on"
    }

    private static var isRunningFromDoTheThingAppBundle: Bool {
        Bundle.main.bundleURL.standardizedFileURL.pathExtension == "app"
            && PermissionSupport.isDoTheThingBundleIdentifier(Bundle.main.bundleIdentifier)
    }

    private static var isRunningFromLaunchServicesAppInstance: Bool {
        isRunningFromDoTheThingAppBundle && getppid() == 1
    }

    private static func defaultSocketPath(appBundleURL: URL) -> String {
        macOSAppAgentSocketPath(appBundleURL: appBundleURL)
    }

    /// Minimum delay between automatic terminate-and-relaunch permission
    /// repair attempts. Without this cooldown, an agent that keeps reporting
    /// `grantedButRuntimeDenied` after a fresh launch (for example when the
    /// TCC record belongs to a different bundle copy) is killed and relaunched
    /// on every single tool call, which shows up as an endless permission loop.
    private static let permissionRepairCooldown: TimeInterval = 120

    private static func permissionRepairMarkerPath(socketPath: String) -> String {
        socketPath + ".repair"
    }

    private static func shouldAttemptPermissionRepair(socketPath: String) -> Bool {
        let markerPath = permissionRepairMarkerPath(socketPath: socketPath)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: markerPath),
              let modifiedAt = attributes[.modificationDate] as? Date
        else {
            return true
        }

        return Date().timeIntervalSince(modifiedAt) >= permissionRepairCooldown
    }

    private static func recordPermissionRepairAttempt(socketPath: String) {
        let markerPath = permissionRepairMarkerPath(socketPath: socketPath)
        if !FileManager.default.createFile(atPath: markerPath, contents: Data()) {
            try? FileManager.default.setAttributes(
                [.modificationDate: Date()],
                ofItemAtPath: markerPath
            )
        }
    }

    private static func clearPermissionRepairAttempt(socketPath: String) {
        try? FileManager.default.removeItem(atPath: permissionRepairMarkerPath(socketPath: socketPath))
    }

    @MainActor
    private static func connectOrLaunchAgent(socketPath: String, appURL: URL) throws -> AppAgentSocketClient {
        if let client = AppAgentSocketClient.connect(path: socketPath) {
            if (try? client.isCurrentAgent(for: appURL)) == true {
                let needsRepair = (try? client.needsRuntimePermissionRepair()) == true
                if needsRepair, shouldAttemptPermissionRepair(socketPath: socketPath) {
                    recordPermissionRepairAttempt(socketPath: socketPath)
                    _ = try? client.request(["kind": "terminate"])
                    unlink(socketPath)
                } else {
                    if !needsRepair {
                        clearPermissionRepairAttempt(socketPath: socketPath)
                    }
                    return client
                }
            } else {
                _ = try? client.request(["kind": "terminate"])
                unlink(socketPath)
            }
        } else {
            unlink(socketPath)
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [appAgentCommand, socketPath]
        configuration.activates = false
        configuration.createsNewApplicationInstance = true

        // Do not pass an empty completion handler here. This method is
        // MainActor-isolated, so Swift treats that closure as MainActor-isolated
        // too, but LaunchServices invokes it on its own queue and trips a
        // dispatch assertion in release builds.
        NSWorkspace.shared.openApplication(
            at: appURL,
            configuration: configuration,
            completionHandler: nil
        )

        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let client = AppAgentSocketClient.connect(path: socketPath) {
                if (try? client.needsRuntimePermissionRepair()) != true {
                    clearPermissionRepairAttempt(socketPath: socketPath)
                }
                return client
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        throw DoTheThingCLIError(message: "Timed out waiting for Do The Thing.app agent to start.")
    }

    private static func proxyMCP(client: AppAgentSocketClient) throws {
        while let line = readLine(strippingNewline: true) {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }

            let response = try client.request([
                "kind": "mcp",
                "line": line,
            ])

            if let responseLine = response["response"] as? String {
                FileHandle.standardOutput.write(Data((responseLine + "\n").utf8))
            }
        }
    }

    private static func sendCLIRequest(arguments: [String], client: AppAgentSocketClient) throws -> CLIProxyResponse {
        let response = try client.request([
            "kind": "cli",
            "arguments": arguments,
            "environment": proxiedEnvironment(),
        ])

        return CLIProxyResponse(
            stdout: response["stdout"] as? String ?? "",
            stderr: response["stderr"] as? String ?? "",
            exitCode: Int32(response["exitCode"] as? Int ?? 1)
        )
    }

    private static func proxiedEnvironment() -> [String: String] {
        ProcessInfo.processInfo.environment.filter { key, _ in
            key.hasPrefix("DOTHETHING_")
        }
    }
}

private struct CLIProxyResponse {
    let stdout: String
    let stderr: String
    let exitCode: Int32
}

@MainActor
private final class MacOSAppAgentRuntime: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private var listener: AppAgentSocketListener?
    private var turnEndedObserver: NSObjectProtocol?

    private init(socketPath: String) {
        self.socketPath = socketPath
    }

    static func run(socketPath: String) throws {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)

        let delegate = MacOSAppAgentRuntime(socketPath: socketPath)
        application.delegate = delegate
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        turnEndedObserver = DistributedNotificationCenter.default().addObserver(
            forName: openComputerUseTurnEndedNotificationName,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                resetDoTheThingVisualCursor()
            }
        }

        do {
            let listener = try AppAgentSocketListener(path: socketPath)
            self.listener = listener
            listener.start()
        } catch {
            writeAgentError(error)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let turnEndedObserver {
            DistributedNotificationCenter.default().removeObserver(turnEndedObserver)
        }
        listener?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func writeAgentError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}

private final class AppAgentSocketListener: @unchecked Sendable {
    private let path: String
    private let socketFD: Int32
    private var running = true

    init(path: String) throws {
        self.path = path
        unlink(path)

        socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        try withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            try pointer.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { buffer in
                let bytes = Array(path.utf8)
                guard bytes.count < pathCapacity else {
                    throw DoTheThingCLIError(message: "Socket path is too long: \(path)")
                }
                for index in 0..<bytes.count {
                    buffer[index] = CChar(bitPattern: bytes[index])
                }
                buffer[bytes.count] = 0
            }
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(socketFD)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }

        guard listen(socketFD, 16) == 0 else {
            close(socketFD)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }

        guard chmod(path, mode_t(S_IRUSR | S_IWUSR)) == 0 else {
            close(socketFD)
            unlink(path)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }
    }

    func start() {
        Thread.detachNewThread {
            self.acceptLoop()
        }
    }

    func stop() {
        running = false
        close(socketFD)
        unlink(path)
    }

    private func acceptLoop() {
        while running {
            let clientFD = accept(socketFD, nil, nil)
            guard clientFD >= 0 else {
                if running {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                continue
            }

            Thread.detachNewThread {
                AppAgentConnection(fileDescriptor: clientFD).run()
            }
        }
    }
}

private enum MacOSAppAgentShared {
    nonisolated(unsafe) static let computerUseService = ComputerUseService()

    /// Minimum delay between onboarding window presentations triggered by
    /// permission-denied tool calls. Agent hosts retry failed tool calls in
    /// quick succession; without this throttle the permission window is
    /// re-presented for every retry, which feels like an endless loop and
    /// reopens the window immediately after the user closes it.
    private static let onboardingPresentationThrottle: TimeInterval = 30
    private static let onboardingPresentationLock = NSLock()
    nonisolated(unsafe) private static var lastOnboardingPresentationAt = Date.distantPast

    static func presentOnboardingForDeniedToolCall() {
        onboardingPresentationLock.lock()
        let now = Date()
        let shouldPresent = now.timeIntervalSince(lastOnboardingPresentationAt) >= onboardingPresentationThrottle
        if shouldPresent {
            lastOnboardingPresentationAt = now
        }
        onboardingPresentationLock.unlock()

        guard shouldPresent else {
            return
        }

        Task { @MainActor in
            PermissionOnboardingApp.present(terminateOnCompletion: false)
        }
    }
}

private final class AppAgentConnection: @unchecked Sendable {
    private let fileDescriptor: Int32
    private let server = StdioMCPServer(
        service: MacOSAppAgentShared.computerUseService,
        onPermissionDenied: {
            MacOSAppAgentShared.presentOnboardingForDeniedToolCall()
        }
    )

    init(fileDescriptor: Int32) {
        self.fileDescriptor = fileDescriptor
    }

    func run() {
        guard let file = fdopen(fileDescriptor, "r+") else {
            close(fileDescriptor)
            return
        }
        defer { fclose(file) }

        while let line = readAgentLine(file) {
            let response = handle(requestLine: line)
            writeAgentLine(response, to: file)
        }
    }

    private func handle(requestLine: String) -> [String: Any] {
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(requestLine.utf8)) as? [String: Any],
                  let kind = request["kind"] as? String
            else {
                return ["error": "Invalid app-agent request"]
            }

            switch kind {
            case "agentInfo":
                return [
                    "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
                    "bundleURL": Bundle.main.bundleURL.standardizedFileURL.path,
                    "executableURL": Bundle.main.executableURL?.standardizedFileURL.path ?? "",
                    "processStartTime": appAgentProcessStartDate.timeIntervalSince1970,
                ]
            case "runtimeStatus":
                return PermissionDiagnostics.current().diagnosticsDictionary
            case "terminate":
                Task { @MainActor in
                    NSApp.terminate(nil)
                }
                return ["ok": true]
            case "mcp":
                let line = request["line"] as? String ?? ""
                if let response = server.handle(line: line) {
                    return ["response": response]
                }
                return ["response": NSNull()]
            case "cli":
                let arguments = request["arguments"] as? [String] ?? []
                let environment = request["environment"] as? [String: String] ?? [:]
                let response = AppAgentEnvironment.withOverrides(environment) {
                    runCLI(arguments: arguments, environment: environment)
                }
                return [
                    "stdout": response.stdout,
                    "stderr": response.stderr,
                    "exitCode": Int(response.exitCode),
                ]
            default:
                return ["error": "Unknown app-agent request kind: \(kind)"]
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return ["error": message]
        }
    }

    private func runCLI(arguments: [String], environment: [String: String]) -> CLIProxyResponse {
        do {
            let command = try parseDoTheThingCLI(arguments: arguments)

            switch command {
            case .launchOnboarding:
                let permissions = PermissionDiagnostics.current()
                if !permissions.allGranted {
                    Task { @MainActor in
                        PermissionOnboardingApp.present()
                    }
                }
                return CLIProxyResponse(stdout: "", stderr: "", exitCode: EXIT_SUCCESS)

            case let .doctor(format):
                let permissions = PermissionDiagnostics.current()
                if !shouldSuppressOnboarding(environment: environment),
                   !permissions.missingPermissions.isEmpty {
                    Task { @MainActor in
                        PermissionOnboardingApp.present()
                    }
                }
                switch format {
                case .text:
                    return CLIProxyResponse(stdout: permissions.summary + "\n", stderr: "", exitCode: EXIT_SUCCESS)
                case .json:
                    return CLIProxyResponse(stdout: (try permissions.diagnosticsJSONText()) + "\n", stderr: "", exitCode: EXIT_SUCCESS)
                }

            case .listApps:
                let service = ComputerUseService()
                return CLIProxyResponse(stdout: (service.listApps().primaryText ?? "") + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case let .snapshot(app):
                let service = ComputerUseService()
                let text = try service.getAppState(app: app).primaryText ?? ""
                return CLIProxyResponse(stdout: text + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case let .call(invocation):
                let output = try runDoTheThingCall(invocation)
                return CLIProxyResponse(
                    stdout: try output.jsonText() + "\n",
                    stderr: "",
                    exitCode: output.hasToolError ? EXIT_FAILURE : EXIT_SUCCESS
                )

            default:
                return CLIProxyResponse(stdout: "", stderr: "Unsupported proxied command.\n", exitCode: EXIT_FAILURE)
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return CLIProxyResponse(stdout: "", stderr: message + "\n", exitCode: EXIT_FAILURE)
        }
    }

    private func shouldSuppressOnboarding(environment: [String: String]) -> Bool {
        switch environment[suppressOnboardingEnvironmentKey]?.lowercased() {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }
}

private enum AppAgentEnvironment {
    private static let lock = NSLock()

    static func withOverrides<T>(_ overrides: [String: String], _ body: () throws -> T) rethrows -> T {
        guard !overrides.isEmpty else {
            return try body()
        }

        lock.lock()
        defer { lock.unlock() }

        let previousValues = Dictionary(
            uniqueKeysWithValues: overrides.keys.map { key in
                (key, ProcessInfo.processInfo.environment[key])
            }
        )
        for (key, value) in overrides {
            setenv(key, value, 1)
        }

        defer {
            for (key, previousValue) in previousValues {
                if let previousValue {
                    setenv(key, previousValue, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        return try body()
    }
}

private final class AppAgentSocketClient: @unchecked Sendable {
    private let file: UnsafeMutablePointer<FILE>

    private init(file: UnsafeMutablePointer<FILE>) {
        self.file = file
    }

    deinit {
        fclose(file)
    }

    static func connect(path: String) -> AppAgentSocketClient? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            return nil
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        let copied = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { buffer -> Bool in
                let bytes = Array(path.utf8)
                guard bytes.count < pathCapacity else {
                    return false
                }
                for index in 0..<bytes.count {
                    buffer[index] = CChar(bitPattern: bytes[index])
                }
                buffer[bytes.count] = 0
                return true
            }
        }

        guard copied else {
            close(fd)
            return nil
        }

        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0, let file = fdopen(fd, "r+") else {
            close(fd)
            return nil
        }

        return AppAgentSocketClient(file: file)
    }

    func request(_ object: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        guard let line = String(data: data, encoding: .utf8) else {
            throw ComputerUseError.message("Failed to encode app-agent request.")
        }

        writeAgentLine(line, to: file)

        guard let responseLine = readAgentLine(file),
              let response = try JSONSerialization.jsonObject(with: Data(responseLine.utf8)) as? [String: Any]
        else {
            throw ComputerUseError.message("Do The Thing.app agent closed the connection.")
        }

        if let error = response["error"] as? String {
            throw ComputerUseError.message(error)
        }

        return response
    }

    func isCurrentAgent(for appURL: URL) throws -> Bool {
        let response = try request(["kind": "agentInfo"])
        let expectedBundleURL = appURL.standardizedFileURL

        guard response["bundleURL"] as? String == expectedBundleURL.path else {
            return false
        }

        guard let processStartTime = response["processStartTime"] as? TimeInterval else {
            return false
        }

        guard let executableURL = executableURL(for: expectedBundleURL),
              let modifiedAt = try? executableURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        else {
            return true
        }

        return processStartTime + 0.5 >= modifiedAt.timeIntervalSince1970
    }

    func needsRuntimePermissionRepair() throws -> Bool {
        let response = try request(["kind": "runtimeStatus"])
        if response["needsRuntimePermissionRefresh"] as? Bool == true {
            return true
        }

        guard let permissions = response["permissions"] as? [[String: Any]] else {
            return false
        }

        return permissions.contains { permission in
            permission["status"] as? String == PermissionReadinessStatus.grantedButRuntimeDenied.rawValue
        }
    }

    private func executableURL(for appURL: URL) -> URL? {
        guard let bundle = Bundle(url: appURL),
              let executableName = bundle.object(forInfoDictionaryKey: kCFBundleExecutableKey as String) as? String,
              !executableName.isEmpty
        else {
            return nil
        }

        return appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(executableName)
            .standardizedFileURL
    }
}

private func readAgentLine(_ file: UnsafeMutablePointer<FILE>) -> String? {
    var bytes: [UInt8] = []

    while true {
        let character = fgetc(file)
        if character == EOF {
            return bytes.isEmpty ? nil : String(data: Data(bytes), encoding: .utf8)
        }
        if character == 10 {
            return String(data: Data(bytes), encoding: .utf8)
        }
        bytes.append(UInt8(character))
    }
}

private func writeAgentLine(_ object: [String: Any], to file: UnsafeMutablePointer<FILE>) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
       let line = String(data: data, encoding: .utf8)
    {
        writeAgentLine(line, to: file)
    }
}

private func writeAgentLine(_ line: String, to file: UnsafeMutablePointer<FILE>) {
    let output = line + "\n"
    _ = output.withCString { pointer in
        fputs(pointer, file)
    }
    fflush(file)
}
