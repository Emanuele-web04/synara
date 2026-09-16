import ApplicationServices
import CoreGraphics

enum AppSnapPermission: String {
    case accessibility
    case screenRecording
}

struct AppSnapPermissionState {
    let accessibility: Bool?
    let screenRecording: Bool?
}

func preflightAppSnapPermissions(_ permissions: Set<AppSnapPermission>) -> AppSnapPermissionState {
    AppSnapPermissionState(
        accessibility: permissions.contains(.accessibility) ? AXIsProcessTrusted() : nil,
        screenRecording: permissions.contains(.screenRecording) ? CGPreflightScreenCaptureAccess() : nil
    )
}

func requestAppSnapPermissions(_ permissions: Set<AppSnapPermission>) -> AppSnapPermissionState {
    let preflight = preflightAppSnapPermissions(permissions)
    if preflight.accessibility == false {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }
    if preflight.screenRecording == false {
        _ = CGRequestScreenCaptureAccess()
    }
    return preflightAppSnapPermissions(permissions)
}
