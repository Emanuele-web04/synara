import Foundation

/// Fires the capture gesture when the parent process writes a `trigger` line
/// to stdin. Used when Electron owns shortcut detection via its global
/// accelerator registration, so the helper needs no keyboard event tap.
final class ExternalTriggerListener {
    private let emitter: NDJSONEmitter
    private let onTrigger: () -> Void
    private var buffer = Data()

    init(emitter: NDJSONEmitter, onTrigger: @escaping () -> Void) {
        self.emitter = emitter
        self.onTrigger = onTrigger
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                // EOF: the parent closed stdin; ParentProcessMonitor owns exit.
                FileHandle.standardInput.readabilityHandler = nil
                return
            }
            self.consume(data)
        }
        emitter.emitReady()
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = String(data: buffer[buffer.startIndex ..< newlineIndex], encoding: .utf8)
            buffer.removeSubrange(buffer.startIndex ... newlineIndex)
            if line?.trimmingCharacters(in: .whitespacesAndNewlines) == "trigger" {
                DispatchQueue.main.async { [onTrigger] in
                    onTrigger()
                }
            }
        }
    }
}
