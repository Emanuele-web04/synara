import Foundation
import SwiftUI

/// What the host last told the island to show. The host owns every decision
/// (which state leads, which count is shown, which rows fit); the island only
/// draws it, so the logic stays in the tested TypeScript side.
struct NotchIslandSnapshot: Decodable, Equatable {
    enum Lead: String, Decodable {
        case needsYou = "needs-you"
        case working
        case finished
        case failed
        case idle
    }

    enum RowState: String, Decodable {
        case needsApproval = "needs-approval"
        case needsInput = "needs-input"
        case working
        case finished
        case failed
    }

    struct Row: Decodable, Equatable, Identifiable {
        let threadId: String
        let title: String
        let project: String?
        let state: RowState

        var id: String { threadId }
    }

    let lead: Lead
    /// The number on the closed island; zero shows none.
    let count: Int
    let rows: [Row]

    static let idle = NotchIslandSnapshot(lead: .idle, count: 0, rows: [])
}

/// Visible text, already localized by the host.
struct NotchIslandLabels: Decodable, Equatable {
    let empty: String
    let openApp: String

    static let fallback = NotchIslandLabels(empty: "No active chats", openApp: "Open Synara")
}

@available(macOS 13.0, *)
@MainActor
final class NotchIslandModel: ObservableObject {
    @Published var snapshot = NotchIslandSnapshot.idle
    @Published var labels = NotchIslandLabels.fallback
    @Published var isExpanded = false
    @Published var isSuppressed = false
    @Published var placementKind: NotchIslandPlacementKind = .notch
    @Published var notchSize = CGSize(width: NotchIslandGeometry.pillBodyWidth, height: 24)
    @Published var reduceMotion = false

    var onOpenThread: (String) -> Void = { _ in }
    var onOpenApp: () -> Void = {}

    var presence: NotchIslandPresence {
        NotchIslandGeometry.presence(
            kind: placementKind,
            hasActivity: snapshot.lead != .idle,
            isExpanded: isExpanded,
            isSuppressed: isSuppressed
        )
    }

    var islandSize: CGSize {
        NotchIslandGeometry.islandSize(for: presence, notch: notchSize)
    }
}
