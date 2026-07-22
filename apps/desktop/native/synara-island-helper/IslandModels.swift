import Foundation
import SwiftUI

enum IslandStatus: String, CaseIterable, Codable, Sendable {
    case working
    case approval
    case responding
    case done
    case error
    case idle

    var label: String {
        switch self {
        case .working: "Working"
        case .approval: "Needs approval"
        case .responding: "Responding"
        case .done: "Done"
        case .error: "Error"
        case .idle: "Idle"
        }
    }

    var color: Color {
        switch self {
        case .working: Color(red: 0.25, green: 0.86, blue: 0.94)
        case .approval: Color(red: 1.00, green: 0.68, blue: 0.18)
        case .responding: Color(red: 0.48, green: 0.68, blue: 1.00)
        case .done: Color(red: 0.24, green: 0.84, blue: 0.58)
        case .error: Color(red: 1.00, green: 0.35, blue: 0.38)
        case .idle: Color.white.opacity(0.42)
        }
    }
}

struct IslandSession: Identifiable, Sendable {
    let id: String
    let title: String
    let provider: String
    let elapsed: String
    let activity: String
    let detail: String
    let status: IslandStatus
    let changeSummary: String

    init(
        id: String = UUID().uuidString,
        title: String,
        provider: String,
        elapsed: String,
        activity: String,
        detail: String = "",
        status: IslandStatus,
        changeSummary: String = ""
    ) {
        self.id = id
        self.title = title
        self.provider = provider
        self.elapsed = elapsed
        self.activity = activity
        self.detail = detail
        self.status = status
        self.changeSummary = changeSummary
    }
}

struct IslandApprovalContext: Equatable, Sendable {
    let threadID: String
    let requestID: String
    let requestKind: String
}

enum IslandApprovalDecision: String, Sendable {
    case deny = "deny"
    case allowOnce = "allow-once"
    case alwaysAllow = "always-allow"
}

enum IslandUserAction: Sendable {
    case openThread(threadID: String)
    case respondToApproval(
        threadID: String,
        requestID: String,
        decision: IslandApprovalDecision
    )
}

enum IslandPresentation: String, Sendable {
    case collapsed
    case activity
    case approval
    case expanded
}

enum IslandFixtures {
    static let sessions: [IslandSession] = [
        IslandSession(
            title: "fix-transcript-scroll",
            provider: "Claude",
            elapsed: "1m",
            activity: "Reading file",
            detail: "Read MessagesTimeline.tsx  219 lines",
            status: .working,
            changeSummary: "+42 −11"
        ),
        IslandSession(
            title: "refactor-auth-middleware",
            provider: "Codex",
            elapsed: "3m",
            activity: "Waiting for permission",
            detail: "Edit apps/server/src/auth/middleware.ts",
            status: .approval,
            changeSummary: "+18 −7"
        ),
        IslandSession(
            title: "island-visual-iteration",
            provider: "OpenCode",
            elapsed: "12m",
            activity: "Responding",
            detail: "Read sidebar.tsx  741 lines",
            status: .responding,
            changeSummary: "+96 −34"
        ),
        IslandSession(
            title: "release-notes",
            provider: "Codex",
            elapsed: "18m",
            activity: "Completed",
            status: .done,
            changeSummary: "+24 −2"
        ),
    ]
}
