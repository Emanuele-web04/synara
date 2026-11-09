import AppKit
import Foundation
import SwiftUI

/// What the host last told the island to show. The host owns every decision
/// (which state leads, which count is shown, which rows fit); the island only
/// draws it, so the logic stays in the tested TypeScript side.
struct NotchIslandSnapshot: Decodable, Equatable {
    enum Lead: String, Decodable {
        case needsYou = "needs-you"
        case working
        case failed
        case finished
        case idle
    }

    /// Matches the sidebar's status pills.
    enum RowState: String, Decodable {
        case approval
        case input
        case plan
        case working
        case done
        case failed

        var needsYou: Bool { self == .approval || self == .input || self == .plan }

        /// The section a row sits under, in the order sections are shown.
        var group: Int {
            switch self {
            case .approval, .input, .plan: 0
            case .working: 1
            case .failed: 2
            case .done: 3
            }
        }
    }

    struct Row: Decodable, Equatable, Identifiable {
        let threadId: String
        let title: String
        let project: String?
        let provider: String?
        let state: RowState

        var id: String { threadId }
    }

    let lead: Lead
    /// The number on the closed island; zero shows none.
    let count: Int
    let needsYou: Int
    let working: Int
    let done: Int
    let failed: Int
    let rows: [Row]

    static let idle = NotchIslandSnapshot(
        lead: .idle, count: 0, needsYou: 0, working: 0, done: 0, failed: 0, rows: []
    )

    init(lead: Lead, count: Int, needsYou: Int, working: Int, done: Int, failed: Int, rows: [Row]) {
        self.lead = lead
        self.count = count
        self.needsYou = needsYou
        self.working = working
        self.done = done
        self.failed = failed
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey {
        case lead, count, needsYou, working, done, failed, rows
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        lead = try container.decode(Lead.self, forKey: .lead)
        count = try container.decode(Int.self, forKey: .count)
        needsYou = try container.decodeIfPresent(Int.self, forKey: .needsYou) ?? 0
        working = try container.decodeIfPresent(Int.self, forKey: .working) ?? 0
        done = try container.decodeIfPresent(Int.self, forKey: .done) ?? 0
        failed = try container.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        rows = Array(try container.decode([Row].self, forKey: .rows).prefix(NotchIslandGeometry.maxRows))
    }
}

/// Visible text, already localized by the host. Missing keys keep English.
struct NotchIslandLabels: Decodable, Equatable {
    var empty = "No active chats"
    var openApp = "Open Synara"
    var needYou = "need you"
    var working = "working"
    var approval = "Pending approval"
    var input = "Awaiting input"
    var plan = "Plan ready"
    var stateWorking = "Working"
    var completed = "Completed"
    var stateFailed = "Failed"
    var review = "Review"
    /// Section labels, as the Inbox names them.
    var needsYouTitle = "Needs you"
    var readyForReview = "Ready for review"

    static let fallback = NotchIslandLabels()

    init() {}

    private enum CodingKeys: String, CodingKey {
        case empty, openApp, needYou, working, approval, input, plan
        case stateWorking, completed, stateFailed, review, needsYouTitle, readyForReview
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func read(_ key: CodingKeys, _ fallback: String) throws -> String {
            try container.decodeIfPresent(String.self, forKey: key) ?? fallback
        }
        let base = NotchIslandLabels()
        empty = try read(.empty, base.empty)
        openApp = try read(.openApp, base.openApp)
        needYou = try read(.needYou, base.needYou)
        working = try read(.working, base.working)
        approval = try read(.approval, base.approval)
        input = try read(.input, base.input)
        plan = try read(.plan, base.plan)
        stateWorking = try read(.stateWorking, base.stateWorking)
        completed = try read(.completed, base.completed)
        stateFailed = try read(.stateFailed, base.stateFailed)
        review = try read(.review, base.review)
        needsYouTitle = try read(.needsYouTitle, base.needsYouTitle)
        readyForReview = try read(.readyForReview, base.readyForReview)
    }

    func status(_ state: NotchIslandSnapshot.RowState) -> String {
        switch state {
        case .approval: approval
        case .input: input
        case .plan: plan
        case .working: stateWorking
        case .done: completed
        case .failed: stateFailed
        }
    }
}

@available(macOS 13.0, *)
@MainActor
final class NotchIslandModel: ObservableObject {
    @Published var snapshot = NotchIslandSnapshot.idle
    @Published var labels = NotchIslandLabels.fallback
    /// Provider glyphs the host sent, rendered from the app's own SVG markup.
    @Published var icons: [String: NSImage] = [:]
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
        NotchIslandGeometry.islandSize(for: presence, notch: notchSize, list: listShape)
    }

    var listShape: NotchIslandListShape {
        let rows = snapshot.rows
        return NotchIslandListShape(
            rows: rows.count,
            sections: Set(rows.map(\.state.group)).count
        )
    }

    func icon(for row: NotchIslandSnapshot.Row) -> NSImage? {
        row.provider.flatMap { icons[$0] }
    }
}
