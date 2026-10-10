import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

/// Shared ScreenCaptureKit owner for AppSnap's single frame and Computer Use's
/// live preview. Frames remain native; this class never encodes or stores images.
final class WindowFrameStream: NSObject, SCStreamOutput, SCStreamDelegate {
    private let windowID: CGWindowID
    private let ownerPID: pid_t?
    private let maximumDimension: Int
    private let monitorsWindow: Bool
    private let onFrame: (CMSampleBuffer) -> Void
    private let onFailure: (AppSnapFailure) -> Void
    private let queue = DispatchQueue(label: "dev.synara.window-frame-stream")
    private var stream: SCStream?
    private var stopped = false
    private var timer: DispatchSourceTimer?
    private var sourceSize = CGSize.zero
    private var framesPerSecond: Int
    private let scaleFactor: Double
    private var receivedFrame = false

    init(
        windowID: CGWindowID,
        ownerPID: pid_t? = nil,
        maximumDimension: Int = 8_192,
        scaleFactor: Double = 2,
        framesPerSecond: Int = 60,
        monitorsWindow: Bool = false,
        onFrame: @escaping (CMSampleBuffer) -> Void,
        onFailure: @escaping (AppSnapFailure) -> Void
    ) {
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.maximumDimension = maximumDimension
        self.scaleFactor = scaleFactor
        self.framesPerSecond = framesPerSecond
        self.monitorsWindow = monitorsWindow
        self.onFrame = onFrame
        self.onFailure = onFailure
    }

    func start() {
        queue.async { [self] in
            guard !stopped else { return }
            guard CGPreflightScreenCaptureAccess() else {
                fail("screen_recording_required", "Screen Recording is required for the preview. Enable it in Synara’s permission setup.")
                return
            }
            queue.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, !self.stopped, !self.receivedFrame else { return }
                self.fail("capture_timed_out", "The selected window did not deliver a frame.")
            }
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { [weak self] content, error in
                guard let self else { return }
                self.queue.async {
                    guard !self.stopped else { return }
                    guard let window = content?.windows.first(where: {
                        $0.windowID == self.windowID &&
                            (self.ownerPID == nil || $0.owningApplication?.processID == self.ownerPID)
                    }) else {
                        self.fail("target_unavailable", error?.localizedDescription ?? "The selected window is no longer available.")
                        return
                    }
                    guard window.frame.width >= 2, window.frame.height >= 2 else {
                        self.fail("invalid_window_dimensions", "The selected window has no capturable area.")
                        return
                    }
                    self.sourceSize = window.frame.size
                    let stream = SCStream(
                        filter: SCContentFilter(desktopIndependentWindow: window),
                        configuration: self.configuration(),
                        delegate: self
                    )
                    self.stream = stream
                    do {
                        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                    } catch {
                        self.fail("capture_setup_failed", error.localizedDescription)
                        return
                    }
                    stream.startCapture { [weak self] error in
                        guard let self, let error else { return }
                        self.queue.async { self.fail("capture_start_failed", error.localizedDescription) }
                    }
                    if self.monitorsWindow { self.startWindowMonitor() }
                }
            }
        }
    }

    func setVisible(_ visible: Bool) {
        queue.async { [self] in
            let rate = visible ? 15 : 1
            guard !stopped, framesPerSecond != rate else { return }
            framesPerSecond = rate
            updateConfiguration()
        }
    }

    func stop() {
        queue.async { [self] in stopOnQueue() }
    }

    private func configuration() -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        let ratio = min(scaleFactor, Double(maximumDimension) / max(sourceSize.width, sourceSize.height))
        configuration.width = max(2, Int((sourceSize.width * ratio).rounded()))
        configuration.height = max(2, Int((sourceSize.height * ratio).rounded()))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(framesPerSecond))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = monitorsWindow ? 2 : 1
        configuration.scalesToFit = true
        configuration.showsCursor = false
        configuration.colorSpaceName = CGColorSpace.sRGB as CFString
        return configuration
    }

    private func updateConfiguration() {
        stream?.updateConfiguration(configuration()) { [weak self] error in
            guard let self, let error else { return }
            self.queue.async { self.fail("capture_configuration_failed", error.localizedDescription) }
        }
    }

    private func startWindowMonitor() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped else { return }
            let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, self.windowID) as? [[String: Any]]
            guard let window = windows?.first,
                  let pid = window[kCGWindowOwnerPID as String] as? NSNumber,
                  self.ownerPID == nil || pid.int32Value == self.ownerPID,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  rect.width >= 2, rect.height >= 2
            else {
                self.fail("target_unavailable", "The selected window was closed. Waiting for the next target.")
                return
            }
            if self.sourceSize != rect.size {
                self.sourceSize = rect.size
                self.updateConfiguration()
            }
        }
        self.timer = timer
        timer.resume()
    }

    private func stopOnQueue() {
        guard !stopped else { return }
        stopped = true
        timer?.cancel()
        timer = nil
        let active = stream
        stream = nil
        active?.stopCapture { _ in }
    }

    private func fail(_ code: String, _ message: String) {
        guard !stopped else { return }
        stopOnQueue()
        onFailure(AppSnapFailure(code: code, message: message))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard !stopped, outputType == .screen, sampleBuffer.isValid,
              sampleBuffer.dataReadiness == .ready,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? NSNumber,
              status.intValue == SCFrameStatus.complete.rawValue,
              sampleBuffer.imageBuffer != nil else { return }
        receivedFrame = true
        onFrame(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        queue.async { [self] in fail("capture_stopped", error.localizedDescription) }
    }
}
