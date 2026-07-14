import CoreGraphics

struct AppSnapPermissionState {
    let inputMonitoring: Bool
    let screenRecording: Bool
}

func preflightAppSnapPermissions() -> AppSnapPermissionState {
    AppSnapPermissionState(
        inputMonitoring: CGPreflightListenEventAccess(),
        screenRecording: CGPreflightScreenCaptureAccess()
    )
}

func requestAppSnapPermissions() -> AppSnapPermissionState {
    let inputMonitoring = CGRequestListenEventAccess()
    let screenRecording = CGRequestScreenCaptureAccess()
    let preflight = preflightAppSnapPermissions()
    return AppSnapPermissionState(
        inputMonitoring: inputMonitoring || preflight.inputMonitoring,
        screenRecording: screenRecording || preflight.screenRecording
    )
}
