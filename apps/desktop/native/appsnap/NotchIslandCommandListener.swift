import Darwin
import Foundation

/// stdin protocol for `--island`: one JSON object per line. Unlike the other
/// modes' space-separated commands, island lines carry chat titles, so they
/// are JSON from the start. The host sanitizes and caps every field.
///
///   {"type":"snapshot","lead":"working","count":2,"rows":[{"threadId":"…","title":"…","project":"…","state":"working"}]}
///   {"type":"labels","empty":"No active chats","openApp":"Open Synara"}
///   {"type":"quit"}
///
/// EOF means the host is gone: the island exits.
@available(macOS 13.0, *)
final class NotchIslandCommandListener {
    static let maximumLineBytes = 65_536

    private struct Envelope: Decodable {
        let type: String
    }

    private let emitter: NDJSONEmitter
    private let controller: NotchIslandController
    private let decoder = JSONDecoder()
    private var buffer = Data()

    init(emitter: NDJSONEmitter, controller: NotchIslandController) {
        self.emitter = emitter
        self.controller = controller
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self.controller.stop() }
                    exit(EXIT_SUCCESS)
                }
                return
            }
            self.consume(data)
        }
        emitter.emitReady()
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = Data(buffer[buffer.startIndex ..< newlineIndex])
            buffer.removeSubrange(buffer.startIndex ... newlineIndex)
            guard line.count <= Self.maximumLineBytes else {
                invalid("Island command exceeds \(Self.maximumLineBytes) bytes.")
                continue
            }
            handle(line: line)
        }
        if buffer.count > Self.maximumLineBytes {
            buffer.removeAll(keepingCapacity: false)
            invalid("Island command exceeds \(Self.maximumLineBytes) bytes.")
        }
    }

    private func handle(line: Data) {
        guard line.contains(where: { !($0 == 0x20 || $0 == 0x09 || $0 == 0x0D) }) else { return }
        do {
            let envelope = try decoder.decode(Envelope.self, from: line)
            switch envelope.type {
            case "snapshot":
                let snapshot = try decoder.decode(NotchIslandSnapshot.self, from: line)
                onMain { $0.apply(snapshot: snapshot) }
            case "labels":
                let labels = try decoder.decode(NotchIslandLabels.self, from: line)
                onMain { $0.apply(labels: labels) }
            case "quit":
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self.controller.stop() }
                    exit(EXIT_SUCCESS)
                }
            default:
                invalid("Unknown island command: \(envelope.type)")
            }
        } catch {
            invalid("Malformed island command.")
        }
    }

    private func onMain(_ body: @escaping @MainActor (NotchIslandController) -> Void) {
        DispatchQueue.main.async { [controller] in
            MainActor.assumeIsolated { body(controller) }
        }
    }

    private func invalid(_ message: String) {
        emitter.emitError(
            AppSnapFailure(code: "invalid_request", message: message),
            capturedAt: appSnapTimestamp()
        )
    }
}
