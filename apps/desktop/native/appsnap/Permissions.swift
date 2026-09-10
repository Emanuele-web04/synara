import ApplicationServices
import CoreGraphics

enum AppSnapPermission: String {
    case accessibility
    case inputMonitoring
    case screenRecording

    static let legacyDefaults: Set<AppSnapPermission> = [.inputMonitoring, .screenRecording]
}

struct AppSnapPermissionState {
    let accessibility: Bool?
    let inputMonitoring: Bool?
    let screenRecording: Bool?
}

func preflightAppSnapPermissions(_ permissions: Set<AppSnapPermission>) -> AppSnapPermissionState {
    AppSnapPermissionState(
        accessibility: permissions.contains(.accessibility) ? AXIsProcessTrusted() : nil,
        inputMonitoring: permissions.contains(.inputMonitoring) ? CGPreflightListenEventAccess() : nil,
        screenRecording: permissions.contains(.screenRecording) ? CGPreflightScreenCaptureAccess() : nil
    )
}

func requestAppSnapPermissions(_ permissions: Set<AppSnapPermission>) -> AppSnapPermissionState {
    let preflight = preflightAppSnapPermissions(permissions)
    if preflight.accessibility == false {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }
    if preflight.inputMonitoring == false {
        _ = CGRequestListenEventAccess()
    }
    if preflight.screenRecording == false {
        _ = CGRequestScreenCaptureAccess()
    }
    return preflightAppSnapPermissions(permissions)
}
