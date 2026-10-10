import AppKit
import CoreImage
import CoreMedia
import Darwin
import Foundation

/// Streams JPEG frames of one window to the Electron host over the unix socket
/// it was spawned with. Frame bytes never touch stdout: that stays NDJSON for
/// lifecycle events, so the host parses each channel separately.
final class ComputerFrameTap {
    private let emitter: NDJSONEmitter
    private let windowID: CGWindowID
    private let ownerPID: pid_t?
    private let socketPath: String
    private let queue = DispatchQueue(label: "dev.synara.computer-frame-tap")
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let stateLock = NSLock()
    private var stream: WindowFrameStream?
    private var socketDescriptor: Int32 = -1
    private var encodeInFlight = false
    private var stopped = false

    init(emitter: NDJSONEmitter, windowID: CGWindowID, ownerPID: pid_t?, socketPath: String) {
        self.emitter = emitter
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.socketPath = socketPath
    }

    func start() {
        queue.async { [self] in
            guard let descriptor = connectToHost() else {
                exit(EXIT_FAILURE)
            }
            socketDescriptor = descriptor
            emitter.emitReady()
            let stream = WindowFrameStream(
                windowID: windowID,
                ownerPID: ownerPID,
                maximumDimension: 960,
                framesPerSecond: 15,
                monitorsWindow: true
            ) { [weak self] sample in
                self?.receive(sample)
            } onFailure: { [weak self] failure in
                self?.fail(failure)
            }
            self.stream = stream
            stream.start()
        }
    }

    private func connectToHost() -> Int32? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let path = socketPath.utf8CString
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            emitConnectFailure(code: "socket_path_too_long", message: "The frame socket path is too long.")
            return nil
        }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            path.withUnsafeBufferPointer { source in
                destination.copyMemory(from: UnsafeRawBufferPointer(source))
            }
        }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            emitConnectFailure(code: "socket_unavailable", message: "Could not create the frame socket.")
            return nil
        }
        // The peer closing mid-write must end the tap, not raise SIGPIPE.
        var noSIGPIPE: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSIGPIPE, socklen_t(MemoryLayout<Int32>.size))
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.connect(descriptor, socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
        guard connected else {
            let reason = String(cString: strerror(errno))
            Darwin.close(descriptor)
            emitConnectFailure(code: "socket_connect_failed", message: "Could not reach the host frame socket: \(reason)")
            return nil
        }
        return descriptor
    }

    private func emitConnectFailure(code: String, message: String) {
        emitter.emitError(
            AppSnapFailure(code: code, message: message),
            capturedAt: appSnapTimestamp()
        )
    }

    private func receive(_ sample: CMSampleBuffer) {
        // One encode in flight at most. Frames arriving while the encoder or
        // the socket is busy are dropped, never queued: a stale preview frame
        // is worth less than a live one.
        stateLock.lock()
        guard !stopped, !encodeInFlight else {
            stateLock.unlock()
            return
        }
        encodeInFlight = true
        stateLock.unlock()
        queue.async { [self] in
            defer {
                stateLock.lock()
                encodeInFlight = false
                stateLock.unlock()
            }
            guard !stopped else { return }
            guard let jpeg = encodeJPEG(sample) else {
                fail(AppSnapFailure(
                    code: "frame_encode_failed",
                    message: "Could not encode a captured frame as JPEG."
                ))
                return
            }
            guard writeFrame(jpeg) else {
                fail(AppSnapFailure(
                    code: "socket_write_failed",
                    message: "The host frame socket stopped accepting frames."
                ))
                return
            }
        }
    }

    private func encodeJPEG(_ sample: CMSampleBuffer) -> Data? {
        guard let pixels = sample.imageBuffer else { return nil }
        let image = CIImage(cvPixelBuffer: pixels)
        guard let cgImage = context.createCGImage(image, from: image.extent) else { return nil }
        return NSBitmapImageRep(cgImage: cgImage).representation(
            using: .jpeg,
            properties: [.compressionFactor: 0.7]
        )
    }

    /// Wire format: 4-byte little-endian payload length, then JPEG bytes.
    private func writeFrame(_ jpeg: Data) -> Bool {
        var length = UInt32(jpeg.count).littleEndian
        let header = withUnsafeBytes(of: &length) { Data($0) }
        return writeAll(header) && writeAll(jpeg)
    }

    private func writeAll(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(socketDescriptor, base + offset, raw.count - offset)
                guard written > 0 else { return false }
                offset += written
            }
            return true
        }
    }

    /// A tap has no degraded mode: any failure reports one protocol line and
    /// exits so the host records the task dead instead of retrying it.
    private func fail(_ failure: AppSnapFailure) {
        queue.async { [self] in
            stateLock.lock()
            guard !stopped else {
                stateLock.unlock()
                return
            }
            stopped = true
            stateLock.unlock()
            stream?.stop()
            stream = nil
            emitter.emitError(failure, capturedAt: appSnapTimestamp())
            exit(EXIT_FAILURE)
        }
    }
}
