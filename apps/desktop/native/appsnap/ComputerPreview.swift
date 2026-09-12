import AppKit
import AVFoundation
import CoreMedia

private final class ComputerPreviewImageView: NSView {
    let video = AVSampleBufferDisplayLayer()
    private let cursor = CALayer()
    var cursorPoint: CGPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        video.videoGravity = .resizeAspect
        layer?.addSublayer(video)
        cursor.contents = NSCursor.arrow.image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        cursor.bounds = CGRect(x: 0, y: 0, width: 16, height: 22)
        cursor.anchorPoint = CGPoint(x: 0, y: 1)
        cursor.isHidden = true
        layer?.addSublayer(cursor)
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        video.frame = bounds
        CATransaction.commit()
    }

    func display(_ sample: CMSampleBuffer) {
        if video.status == .failed { video.flush() }
        guard video.isReadyForMoreMediaData else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) as? [NSMutableDictionary] {
            attachments.first?[kCMSampleAttachmentKey_DisplayImmediately] = true
        }
        video.enqueue(sample)
        guard let point = cursorPoint, let pixels = sample.imageBuffer else {
            cursor.isHidden = true
            return
        }
        let size = CGSize(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let width = size.width * scale, height = size.height * scale
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursor.isHidden = false
        cursor.position = CGPoint(x: (bounds.width - width) / 2 + point.x * width,
                                  y: (bounds.height - height) / 2 + (1 - point.y) * height)
        CATransaction.commit()
    }

    func clear() {
        video.flushAndRemoveImage()
        cursor.isHidden = true
        cursorPoint = nil
    }
}

/// One task, one target, one native preview. No frame crosses stdout or reaches
/// the provider. Closing hides the preview; Stop ends this task's computer use.
final class ComputerPreview: NSObject, NSWindowDelegate {
    private let emitter: NDJSONEmitter
    private let panel: NSPanel
    private let imageView = ComputerPreviewImageView(frame: .zero)
    private let status = NSTextField(labelWithString: "Waiting for a window…")
    private var stream: WindowFrameStream?
    private var taskKey: String?
    private var target: String?
    private var hidden = false
    private var stopped = false
    private var stdinBuffer = Data()
    private let frameLock = NSLock()
    private var generation = 0
    private var pendingFrame: CMSampleBuffer?
    private var deliveryScheduled = false

    init(emitter: NDJSONEmitter) {
        self.emitter = emitter
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 290),
                        styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        super.init()
        panel.title = "Computer Use"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 260, height: 180)
        panel.delegate = self
        let root = NSView()
        panel.contentView = root
        let stop = NSButton(title: "Stop computer use", target: self, action: #selector(stopByUser))
        stop.bezelStyle = .rounded
        stop.toolTip = "Stop computer actions for this turn"
        status.lineBreakMode = .byTruncatingTail
        status.font = .systemFont(ofSize: 12)
        for view in [status, stop, imageView] {
            root.addSubview(view)
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            status.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            status.trailingAnchor.constraint(lessThanOrEqualTo: stop.leadingAnchor, constant: -8),
            stop.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            stop.centerYAnchor.constraint(equalTo: status.centerYAnchor),
            imageView.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 12),
            imageView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        if let screen = NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - 424, y: screen.visibleFrame.minY + 24))
        }
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                DispatchQueue.main.async { self.shutdown() }
                return
            }
            self.stdinBuffer.append(data)
            guard self.stdinBuffer.count <= 64 * 1024 else {
                DispatchQueue.main.async { self.shutdown() }
                return
            }
            while let newline = self.stdinBuffer.firstIndex(of: 10) {
                let line = self.stdinBuffer.prefix(upTo: newline)
                let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
                self.stdinBuffer.removeSubrange(...newline)
                guard let message else { continue }
                DispatchQueue.main.async { self.update(message) }
            }
        }
        emitter.emitReady()
    }

    private func update(_ message: [String: Any]) {
        guard !stopped,
              let key = message["taskKey"] as? String, key.count <= 1024,
              let id = message["windowId"] as? NSNumber,
              let pid = message["pid"] as? NSNumber,
              id.int64Value > 0, id.int64Value <= Int64(UInt32.max), pid.int64Value > 0,
              pid.int64Value <= Int64(Int32.max), taskKey == nil || taskKey == key else { return }
        taskKey = key
        let next = "\(pid):\(id)"
        if target != next {
            target = next
            invalidateFrames()
            stream?.stop()
            imageView.clear()
            let epoch = generation
            let newStream = WindowFrameStream(windowID: id.uint32Value, ownerPID: pid.int32Value,
                                              maximumDimension: 960, framesPerSecond: hidden ? 1 : 15,
                                              monitorsWindow: true) { [weak self] sample in
                self?.receive(sample, epoch: epoch)
            } onFailure: { [weak self] failure in
                DispatchQueue.main.async {
                    guard let self, self.generation == epoch else { return }
                    self.invalidateFrames()
                    self.target = nil
                    self.imageView.clear()
                    self.status.stringValue = failure.message
                    self.emitter.emit(["type": "preview-error", "code": failure.code, "taskKey": key])
                }
            }
            stream = newStream
            newStream.start()
            let name = NSRunningApplication(processIdentifier: pid.int32Value)?.localizedName ?? "Selected window"
            status.stringValue = name
            panel.title = (message["label"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(160)) } ?? "Computer Use"
            if !hidden { panel.orderFrontRegardless() }
        }
        if let cursor = message["cursor"] as? [String: NSNumber],
           let x = cursor["x"]?.doubleValue, let y = cursor["y"]?.doubleValue,
           x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) {
            imageView.cursorPoint = CGPoint(x: x, y: y)
        }
    }

    private func receive(_ sample: CMSampleBuffer, epoch: Int) {
        frameLock.lock()
        guard generation == epoch, !hidden, !stopped else { frameLock.unlock(); return }
        pendingFrame = sample
        let schedule = !deliveryScheduled
        deliveryScheduled = true
        frameLock.unlock()
        if schedule {
            DispatchQueue.main.async { [weak self] in self?.deliver() }
        }
    }

    private func deliver() {
        frameLock.lock()
        let sample = pendingFrame
        pendingFrame = nil
        deliveryScheduled = false
        frameLock.unlock()
        if !hidden, !stopped, let sample { imageView.display(sample) }
    }

    private func invalidateFrames() {
        frameLock.lock()
        generation += 1
        pendingFrame = nil
        frameLock.unlock()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        frameLock.lock()
        hidden = true
        pendingFrame = nil
        frameLock.unlock()
        imageView.clear()
        stream?.setVisible(false)
        panel.orderOut(nil)
        return false
    }

    @objc private func stopByUser() {
        guard !stopped, let taskKey else { return }
        emitter.emit(["type": "user-stopped", "taskKey": taskKey])
        shutdown()
    }

    private func shutdown() {
        frameLock.lock()
        stopped = true
        generation += 1
        pendingFrame = nil
        frameLock.unlock()
        stream?.stop()
        stream = nil
        imageView.clear()
        panel.orderOut(nil)
        NSApplication.shared.terminate(nil)
    }
}
