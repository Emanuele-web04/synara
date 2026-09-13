import Foundation

struct AppSnapFailure: Error {
    let code: String
    let message: String
}

enum AppSnapMode {
    case computerPreview
    case checkPermissions(Set<AppSnapPermission>)
    case requestPermissions(Set<AppSnapPermission>)
    case permissionGuide(pane: String, appPath: String, appName: String)
    case watch(
        outputDirectory: URL,
        excludedBundleIdentifier: String,
        externalTrigger: Bool
    )
}

struct AppSnapOptions {
    let mode: AppSnapMode

    static func parse(_ arguments: [String]) throws -> AppSnapOptions {
        var requestedMode: String?
        var outputDirectory: String?
        var excludedBundleIdentifier: String?
        var externalTrigger = false
        var permissions = Set<AppSnapPermission>()
        var guidePane: String?
        var guideAppPath: String?
        var guideAppName: String?
        var index = 0

        // Consumes the value token after a flag, keeping the "--flag requires
        // …" usage errors identical across flags.
        func readValue(_ flag: String, _ what: String) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "\(flag) requires \(what)."
                )
            }
            return arguments[index]
        }

        // Watch-only flags are invalid in every non-watch mode.
        func rejectWatchArguments(_ message: String) throws {
            guard outputDirectory == nil, excludedBundleIdentifier == nil, !externalTrigger else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: message
                )
            }
        }

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--check-permissions", "--request-permissions", "--watch", "--permission-guide", "--computer-preview":
                guard requestedMode == nil else {
                    throw AppSnapFailure(
                        code: "invalid_arguments",
                        message: "Choose exactly one helper mode."
                    )
                }
                requestedMode = argument
            case "--output-dir":
                outputDirectory = try readValue("--output-dir", "a path")
            case "--excluded-bundle-id":
                excludedBundleIdentifier = try readValue("--excluded-bundle-id", "a bundle identifier")
            case "--external-trigger":
                externalTrigger = true
            case "--permission":
                let value = try readValue("--permission", "a value")
                guard let permission = AppSnapPermission(rawValue: value) else {
                    throw AppSnapFailure(
                        code: "invalid_arguments",
                        message: "--permission requires accessibility, or screenRecording."
                    )
                }
                permissions.insert(permission)
            case "--pane":
                guidePane = try readValue("--pane", "a value")
            case "--app-path":
                guideAppPath = try readValue("--app-path", "a path")
            case "--app-name":
                guideAppName = try readValue("--app-name", "a value")
            default:
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "Unknown argument: \(argument)"
                )
            }
            index += 1
        }

        if requestedMode != "--permission-guide",
           guidePane != nil || guideAppPath != nil || guideAppName != nil {
            throw AppSnapFailure(code: "invalid_arguments", message: "Guide metadata is only used by the permission guide.")
        }
        switch requestedMode {
        case "--computer-preview":
            try rejectWatchArguments("Computer preview does not accept watch arguments.")
            guard permissions.isEmpty else {
                throw AppSnapFailure(code: "invalid_arguments", message: "Computer preview cannot request permissions.")
            }
            return AppSnapOptions(mode: .computerPreview)
        case "--permission-guide":
            try rejectWatchArguments("The permission guide does not accept watch arguments.")
            guard permissions.isEmpty, let guidePane,
                  guidePane == "accessibility" || guidePane == "screen-recording",
                  let appPath = guideAppPath, appPath.hasPrefix("/"),
                  appPath.hasSuffix(".app"), FileManager.default.fileExists(atPath: appPath),
                  let appName = guideAppName, !appName.isEmpty, appName.count <= 256 else {
                throw AppSnapFailure(code: "invalid_arguments", message: "The permission guide requires --pane accessibility, or screen-recording, the running app bundle, and its name.")
            }
            return AppSnapOptions(
                mode: .permissionGuide(pane: guidePane, appPath: appPath, appName: appName)
            )
        case "--check-permissions":
            try rejectWatchArguments("Permission checks do not accept watch arguments.")
            return AppSnapOptions(mode: .checkPermissions(
                permissions.isEmpty ? [.accessibility, .screenRecording] : permissions
            ))
        case "--request-permissions":
            try rejectWatchArguments("Permission requests do not accept watch arguments.")
            return AppSnapOptions(mode: .requestPermissions(
                permissions.isEmpty ? [.accessibility, .screenRecording] : permissions
            ))
        case "--watch":
            guard permissions.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--watch does not accept permission selectors."
                )
            }
            guard let outputDirectory, !outputDirectory.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--watch requires --output-dir."
                )
            }
            guard let excludedBundleIdentifier, !excludedBundleIdentifier.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--watch requires --excluded-bundle-id."
                )
            }
            return AppSnapOptions(
                mode: .watch(
                    outputDirectory: URL(fileURLWithPath: outputDirectory).standardizedFileURL,
                    excludedBundleIdentifier: excludedBundleIdentifier,
                    externalTrigger: externalTrigger
                )
            )
        default:
            throw AppSnapFailure(
                code: "invalid_arguments",
                message: "Expected --check-permissions, --request-permissions, --watch, --computer-preview, or --permission-guide."
            )
        }
    }
}

func appSnapTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

final class NDJSONEmitter {
    private let lock = NSLock()

    func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              var data = try? JSONSerialization.data(withJSONObject: payload)
        else {
            writeDiagnostic("Could not encode helper protocol event.")
            return
        }

        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }

    func emitReady() {
        emit(["type": "ready"])
    }

    func emitTriggered(id: String, capturedAt: String) {
        emit([
            "type": "triggered",
            "id": id,
            "capturedAt": capturedAt,
        ])
    }

    func emitCaptured(
        id: String,
        capturedAt: String,
        path: String,
        name: String,
        sourceAppName: String?,
        sourceBundleIdentifier: String?,
        sourceAppIconDataURL: String?,
        sourceWindowTitle: String?
    ) {
        var payload: [String: Any] = [
            "type": "captured",
            "id": id,
            "capturedAt": capturedAt,
            "path": path,
            "name": name,
        ]
        if let sourceAppName, !sourceAppName.isEmpty {
            payload["sourceAppName"] = sourceAppName
        }
        if let sourceBundleIdentifier, !sourceBundleIdentifier.isEmpty {
            payload["sourceBundleIdentifier"] = sourceBundleIdentifier
        }
        if let sourceAppIconDataURL, !sourceAppIconDataURL.isEmpty {
            payload["sourceAppIconDataUrl"] = sourceAppIconDataURL
        }
        if let sourceWindowTitle, !sourceWindowTitle.isEmpty {
            payload["sourceWindowTitle"] = sourceWindowTitle
        }
        emit(payload)
    }

    func emitError(
        _ failure: AppSnapFailure,
        capturedAt: String,
        id: String? = nil,
        requestId: String? = nil
    ) {
        var payload: [String: Any] = [
            "type": "error",
            "code": failure.code,
            "message": failure.message,
            "capturedAt": capturedAt,
        ]
        if let id {
            payload["id"] = id
        }
        if let requestId {
            payload["requestId"] = requestId
        }
        emit(payload)
    }

    func emitWindows(requestId: String, windows: [[String: Any]]) {
        emit([
            "type": "windows",
            "requestId": requestId,
            "windows": windows,
        ])
    }

    func emitPermissionGuide(state: String) {
        emit([
            "type": "permission-guide",
            "state": state,
        ])
    }

    func emitPermissions(_ permissions: AppSnapPermissionState) {
        var payload: [String: Any] = ["type": "permissions"]
        if let accessibility = permissions.accessibility {
            payload["accessibility"] = accessibility ? "granted" : "denied"
        }
        if let screenRecording = permissions.screenRecording {
            payload["screenRecording"] = screenRecording ? "granted" : "denied"
        }
        emit(payload)
    }

    private func writeDiagnostic(_ message: String) {
        guard let data = "[synara-appsnap-helper] \(message)\n".data(using: .utf8) else {
            return
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(data)
    }
}
