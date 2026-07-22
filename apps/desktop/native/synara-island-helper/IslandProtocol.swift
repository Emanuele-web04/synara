import AppKit
import Foundation

private let islandProtocolVersion = 1
private let islandMaximumLineBytes = 64 * 1024
private let islandMaximumSessions = 5

private enum IslandWireMode: String, Decodable {
    case activity
    case approval
    case idle
}

private struct IslandWireApproval: Decodable {
    let threadId: String
    let requestId: String
    let requestKind: String
}

private struct IslandWireSession: Decodable {
    let id: String
    let title: String
    let provider: String
    let elapsed: String
    let activity: String
    let detail: String
    let status: IslandStatus
    let changeSummary: String
}

private struct IslandWireSnapshot: Decodable {
    let version: Int
    let mode: IslandWireMode
    let primaryThreadId: String?
    let sessions: [IslandWireSession]
    let approval: IslandWireApproval?
}

private struct IslandInputEnvelope: Decodable {
    let type: String
    let revision: Int?
    let payload: IslandWireSnapshot?
}

private struct IslandReadyMessage: Encodable {
    let type = "ready"
    let protocolVersion = islandProtocolVersion
}

private struct IslandRenderedMessage: Encodable {
    let type = "rendered"
    let revision: Int
}

private struct IslandActionMessage: Encodable {
    let type = "action"
    let actionId: String
    let revision: Int
    let kind: String
    let threadId: String
    let requestId: String?
}

@MainActor
final class IslandProtocolRuntime {
    private let panelController: IslandPanelController
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var currentRevision: Int?
    private var consumedApprovalRequestID: String?

    init(panelController: IslandPanelController) {
        self.panelController = panelController
        panelController.onAction = { [weak self] action in
            self?.send(action)
        }
    }

    func start() {
        write(IslandReadyMessage())

        Task.detached(priority: .userInitiated) { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let self else { return }
                await self.receive(line)
            }
            await self?.inputDidClose()
        }
    }

    private func receive(_ line: String) {
        guard line.utf8.count <= islandMaximumLineBytes,
              let data = line.data(using: .utf8),
              let envelope = try? decoder.decode(IslandInputEnvelope.self, from: data)
        else {
            terminateForProtocolError("invalid or oversized JSONL input")
            return
        }

        if envelope.type == "shutdown" {
            NSApplication.shared.terminate(nil)
            return
        }

        guard envelope.type == "snapshot",
              let revision = envelope.revision,
              revision > 0,
              let snapshot = envelope.payload,
              validate(snapshot)
        else {
            terminateForProtocolError("invalid island snapshot")
            return
        }

        currentRevision = revision
        consumedApprovalRequestID = nil
        let sessions = snapshot.sessions.map { session in
            IslandSession(
                id: session.id,
                title: session.title,
                provider: session.provider,
                elapsed: session.elapsed,
                activity: session.activity,
                detail: session.detail,
                status: session.status,
                changeSummary: session.changeSummary
            )
        }
        let approval = snapshot.approval.map {
            IslandApprovalContext(
                threadID: $0.threadId,
                requestID: $0.requestId,
                requestKind: $0.requestKind
            )
        }
        let presentation: IslandPresentation? = switch snapshot.mode {
        case .activity: .activity
        case .approval: .approval
        case .idle: .collapsed
        }

        panelController.applyLiveSnapshot(
            sessions: sessions,
            primarySessionID: snapshot.primaryThreadId,
            presentation: presentation,
            approval: approval,
            revision: revision
        ) { [weak self] in
            guard let self, self.currentRevision == revision else { return }
            self.write(IslandRenderedMessage(revision: revision))
        }
    }

    private func inputDidClose() {
        NSApplication.shared.terminate(nil)
    }

    private func send(_ action: IslandUserAction) {
        guard let revision = currentRevision else { return }

        if case let .respondToApproval(_, requestID, _) = action {
            guard consumedApprovalRequestID == nil else { return }
            consumedApprovalRequestID = requestID
        }

        let message: IslandActionMessage = switch action {
        case let .openThread(threadID):
            IslandActionMessage(
                actionId: UUID().uuidString,
                revision: revision,
                kind: "open-thread",
                threadId: threadID,
                requestId: nil
            )
        case let .respondToApproval(threadID, requestID, decision):
            IslandActionMessage(
                actionId: UUID().uuidString,
                revision: revision,
                kind: decision.rawValue,
                threadId: threadID,
                requestId: requestID
            )
        }
        write(message)
    }

    private func write<Message: Encodable>(_ message: Message) {
        guard var data = try? encoder.encode(message) else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }

    private func terminateForProtocolError(_ message: String) {
        if let data = "[synara-island] \(message)\n".data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
        NSApplication.shared.terminate(nil)
    }

    private func validate(_ snapshot: IslandWireSnapshot) -> Bool {
        guard snapshot.version == islandProtocolVersion,
              snapshot.sessions.count <= islandMaximumSessions,
              snapshot.sessions.allSatisfy(validate)
        else {
            return false
        }

        switch snapshot.mode {
        case .idle:
            return snapshot.primaryThreadId == nil &&
                snapshot.sessions.isEmpty &&
                snapshot.approval == nil
        case .activity:
            guard let primaryThreadId = snapshot.primaryThreadId,
                  validIdentifier(primaryThreadId)
            else {
                return false
            }
            return snapshot.approval == nil && snapshot.sessions.contains { $0.id == primaryThreadId }
        case .approval:
            guard let primaryThreadId = snapshot.primaryThreadId,
                  validIdentifier(primaryThreadId),
                  let approval = snapshot.approval,
                  validIdentifier(approval.threadId),
                  validIdentifier(approval.requestId),
                  validText(approval.requestKind, maximum: 32, allowEmpty: false)
            else {
                return false
            }
            return approval.threadId == primaryThreadId &&
                snapshot.sessions.contains { $0.id == primaryThreadId }
        }
    }

    private func validate(_ session: IslandWireSession) -> Bool {
        validIdentifier(session.id) &&
            validText(session.title, maximum: 96, allowEmpty: false) &&
            validText(session.provider, maximum: 32, allowEmpty: false) &&
            validText(session.elapsed, maximum: 16) &&
            validText(session.activity, maximum: 80, allowEmpty: false) &&
            validText(session.detail, maximum: 192) &&
            validText(session.changeSummary, maximum: 32)
    }

    private func validIdentifier(_ value: String) -> Bool {
        validText(value, maximum: 512, allowEmpty: false)
    }

    private func validText(
        _ value: String,
        maximum: Int,
        allowEmpty: Bool = true
    ) -> Bool {
        (allowEmpty || !value.isEmpty) &&
            value.count <= maximum &&
            value.unicodeScalars.allSatisfy { scalar in
                let codePoint = scalar.value
                let isBidiControl = (0x200B ... 0x200F).contains(codePoint) ||
                    (0x202A ... 0x202E).contains(codePoint) ||
                    (0x2066 ... 0x2069).contains(codePoint)
                return !CharacterSet.controlCharacters.contains(scalar) && !isBidiControl
            }
    }
}
