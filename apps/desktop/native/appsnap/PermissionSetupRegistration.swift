import AppKit
import CoreServices
import Foundation

private let permissionSetupRegistrationMessage =
    "macOS cannot locate this running app for permission setup. Move this app to Applications and reopen it before granting access."
private let permissionSetupIdentityMismatchMessage =
    "macOS is finding another copy of this app. Quit the other copies, then reopen the copy in Applications and try setup again."

/// Explicit setup only. Registration is not a TCC grant, and success from
/// LSRegisterURL alone does not prove that System Settings can find this copy.
func verifyPermissionSetupRegistration(
    appURL: URL,
    bundleIdentifier: String?,
    resolveApplication: (String) -> URL?,
    registerApplication: (URL) -> Int32
) throws {
    guard let bundleIdentifier, !bundleIdentifier.isEmpty else {
        throw AppSnapFailure(code: "permission_setup_bundle_unavailable", message: permissionSetupRegistrationMessage)
    }
    let exactURL = appURL.resolvingSymlinksInPath().standardizedFileURL
    func matches(_ resolved: URL?) -> Bool {
        resolved?.resolvingSymlinksInPath().standardizedFileURL == exactURL
    }
    if matches(resolveApplication(bundleIdentifier)) { return }

    // Try the supported registration API once for this exact app. Do not edit
    // TCC records, switch to another copy, or turn a failed lookup into a grant.
    _ = registerApplication(exactURL)
    guard let resolvedURL = resolveApplication(bundleIdentifier) else {
        throw AppSnapFailure(code: "permission_setup_registration_unresolved", message: permissionSetupRegistrationMessage)
    }
    guard matches(resolvedURL) else {
        throw AppSnapFailure(code: "permission_setup_identity_mismatch", message: permissionSetupIdentityMismatchMessage)
    }
}

@MainActor
func ensurePermissionSetupAppRegistration(appPath: String) throws {
    let appURL = URL(fileURLWithPath: appPath, isDirectory: true)
    try verifyPermissionSetupRegistration(
        appURL: appURL,
        bundleIdentifier: Bundle(url: appURL)?.bundleIdentifier,
        resolveApplication: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) },
        registerApplication: { LSRegisterURL($0 as CFURL, true) }
    )
}
