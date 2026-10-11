import Foundation

// Compile with PermissionSetupRegistration.swift and AppKit/CoreServices.
// The production error type lives in AppSnapProtocol.swift; this small fixture
// avoids bringing unrelated capture and input modes into a pure lookup test.
struct AppSnapFailure: Error {
    let code: String
    let message: String
}

let appURL = URL(fileURLWithPath: "/Applications/Synara Test.app", isDirectory: true)
let otherURL = URL(fileURLWithPath: "/tmp/Synara Test.app", isDirectory: true)
var checks = 0

func check(_ condition: Bool, _ message: String) {
    checks += 1
    precondition(condition, message)
}

func runCase(
    name: String,
    identifier: String? = "test.permission.setup",
    initial: URL?,
    afterRegistration: URL?,
    registrationStatus: Int32 = 0,
    expectedCode: String?,
    expectedRegistrations: Int
) {
    var registrations: [URL] = []
    do {
        try verifyPermissionSetupRegistration(
            appURL: appURL,
            bundleIdentifier: identifier,
            resolveApplication: { _ in registrations.isEmpty ? initial : afterRegistration },
            registerApplication: { url in registrations.append(url); return registrationStatus }
        )
        check(expectedCode == nil, "\(name): unexpected success")
    } catch let failure as AppSnapFailure {
        check(failure.code == expectedCode, "\(name): unexpected failure \(failure.code)")
        let recovery = expectedCode == "permission_setup_identity_mismatch"
            ? "Quit the other copies, then reopen the copy in Applications"
            : "Move this app to Applications and reopen"
        check(failure.message.contains(recovery), "\(name): no actionable recovery")
        check(!failure.message.contains("/Applications/") && !failure.message.contains("/tmp/"), "\(name): disclosed a local path")
    } catch {
        preconditionFailure("\(name): unexpected error")
    }
    check(registrations.count == expectedRegistrations, "\(name): registration count")
    check(registrations.allSatisfy { $0 == appURL.standardizedFileURL }, "\(name): registered another bundle")
}

runCase(name: "already resolves", initial: appURL, afterRegistration: nil, expectedCode: nil, expectedRegistrations: 0)
runCase(name: "registration fixes lookup", initial: nil, afterRegistration: appURL, expectedCode: nil, expectedRegistrations: 1)
runCase(name: "success return does not prove lookup", initial: nil, afterRegistration: nil, expectedCode: "permission_setup_registration_unresolved", expectedRegistrations: 1)
runCase(name: "other copy is not this app", initial: otherURL, afterRegistration: otherURL, expectedCode: "permission_setup_identity_mismatch", expectedRegistrations: 1)
runCase(name: "registration selects exact copy", initial: otherURL, afterRegistration: appURL, expectedCode: nil, expectedRegistrations: 1)
runCase(name: "missing bundle identity", identifier: nil, initial: nil, afterRegistration: nil, expectedCode: "permission_setup_bundle_unavailable", expectedRegistrations: 0)
runCase(name: "registration error", initial: nil, afterRegistration: nil, registrationStatus: -50, expectedCode: "permission_setup_registration_unresolved", expectedRegistrations: 1)

print("Permission registration: \(checks) checks passed (mock lookup/registration; no TCC changes).")
