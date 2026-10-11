import AVFoundation
import CoreAudio
import Darwin
import Foundation

/// How often the parent hears the current level. ~30 Hz is enough for the
/// message trail's per-frame smoothing and keeps the NDJSON stream tiny.
private let levelEmitInterval: DispatchTimeInterval = .milliseconds(33)
/// Below these the sound counts as silence; dB-mapped levels start here. The
/// microphone's floor sits higher so room noise does not move the trail.
private let systemSilenceFloorDecibels: Float = -60
private let microphoneSilenceFloorDecibels: Float = -50

/// Where the `--audio-level` helper listens.
enum AudioLevelSource: String {
    /// Everything the Mac plays (videos, meetings), via a Core Audio process tap.
    case system
    /// The default input device.
    case microphone
}

/// Running energy of one source's samples since the last report.
final class AudioLevelAccumulator {
    private let silenceFloorDecibels: Float
    private let lock = NSLock()
    private var sumOfSquares: Double = 0
    private var sampleCount: Int = 0

    init(silenceFloorDecibels: Float) {
        self.silenceFloorDecibels = silenceFloorDecibels
    }

    func add(_ samples: UnsafePointer<Float>, count: Int) {
        var squares: Double = 0
        for index in 0..<count {
            let sample = Double(samples[index])
            squares += sample * sample
        }
        lock.lock()
        sumOfSquares += squares
        sampleCount += count
        lock.unlock()
    }

    /// RMS since the last call mapped onto 0...1 (dB scale), then reset.
    func drainLevel() -> Float {
        lock.lock()
        let squares = sumOfSquares
        let count = sampleCount
        sumOfSquares = 0
        sampleCount = 0
        lock.unlock()
        guard count > 0, squares > 0 else { return 0 }
        let decibels = 20 * log10(Float((squares / Double(count)).squareRoot()))
        return min(1, max(0, (decibels - silenceFloorDecibels) / -silenceFloorDecibels))
    }
}

/// Reports how loud the chosen sources are, never the audio itself.
///
/// Each reader only feeds sample energy into its accumulator; a timer turns
/// that into one level in 0...1 per source and emits the loudest as
/// `audio-level`. No buffer is copied, stored, or sent. Silence is reported
/// once, then the stream goes quiet until sound returns.
final class AudioLevelMeter {
    private let emitter: NDJSONEmitter
    private let sources: Set<AudioLevelSource>
    private let inputDeviceUID: String?
    private let queue = DispatchQueue(label: "synara.audio-level")
    private var systemTap: SystemAudioLevelTap?
    private var microphone: MicrophoneLevelReader?
    private var timer: DispatchSourceTimer?
    private var lastEmittedSilence = false

    init(emitter: NDJSONEmitter, sources: Set<AudioLevelSource>, inputDeviceUID: String?) {
        self.emitter = emitter
        self.sources = sources
        self.inputDeviceUID = inputDeviceUID
    }

    func start() throws {
        if sources.contains(.system) {
            let tap = SystemAudioLevelTap(queue: queue)
            systemTap = tap
            try tap.start()
        }
        if sources.contains(.microphone) {
            let reader = MicrophoneLevelReader(deviceUID: inputDeviceUID)
            microphone = reader
            try reader.start()
        }
        startEmitting()
        emitter.emitReady()
    }

    func stop() {
        timer?.cancel()
        timer = nil
        systemTap?.stop()
        microphone?.stop()
    }

    private func startEmitting() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + levelEmitInterval, repeating: levelEmitInterval)
        timer.setEventHandler { [weak self] in
            self?.emitLevel()
        }
        timer.resume()
        self.timer = timer
    }

    private func emitLevel() {
        let level = max(
            systemTap?.accumulator.drainLevel() ?? 0,
            microphone?.accumulator.drainLevel() ?? 0
        )
        if level == 0 {
            if lastEmittedSilence { return }
            lastEmittedSilence = true
        } else {
            lastEmittedSilence = false
        }
        emitter.emit([
            "type": "audio-level",
            // Decimal keeps the wire value short ("0.42", not "0.41999999999999998").
            "level": NSDecimalNumber(value: Int((level * 1000).rounded())).dividing(by: 1000),
        ])
    }
}

/// The Mac's audio output, via a Core Audio process tap (macOS 14.2+).
///
/// The tap mixes everything the system plays into a private aggregate device
/// whose IO proc feeds the accumulator. macOS asks for "System Audio Recording
/// Only" access the first time a tap starts; without it the tap stays silent,
/// so a denied grant reads as level 0.
final class SystemAudioLevelTap {
    let accumulator = AudioLevelAccumulator(silenceFloorDecibels: systemSilenceFloorDecibels)
    private let queue: DispatchQueue
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func start() throws {
        guard #available(macOS 14.2, *) else {
            throw AppSnapFailure(
                code: "system_audio_unsupported",
                message: "System audio levels need macOS 14.2 or later."
            )
        }
        try startTap()
    }

    func stop() {
        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
        }
        ioProcID = nil
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if #available(macOS 14.2, *), tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    @available(macOS 14.2, *)
    private func startTap() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.name = "Synara audio level"

        try check(AudioHardwareCreateProcessTap(description, &tapID), "create the system audio tap")

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Synara audio level",
            kAudioAggregateDeviceUIDKey: "synara-audio-level-\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ],
            ],
        ]
        try check(
            AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateDeviceID),
            "create the audio level device"
        )

        let accumulator = accumulator
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateDeviceID, queue) { _, input, _, _, _ in
                // Taps deliver 32-bit float PCM.
                for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)) {
                    guard let data = buffer.mData else { continue }
                    let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                    accumulator.add(data.assumingMemoryBound(to: Float.self), count: count)
                }
            },
            "attach the audio level reader"
        )
        try check(AudioDeviceStart(aggregateDeviceID, ioProcID), "start the audio level reader")
    }

    private func check(_ status: OSStatus, _ action: String) throws {
        guard status == noErr else {
            stop()
            throw AppSnapFailure(
                code: "system_audio_unavailable",
                message: "Could not \(action) (OSStatus \(status))."
            )
        }
    }
}

/// The chosen input device (or the default one), via an AVAudioEngine input tap.
///
/// Microphone access belongs to the Synara app that spawned this helper, the
/// same grant voice notes use. The first opt-in can request access; a denied
/// grant is reported without prompting again.
final class MicrophoneLevelReader {
    let accumulator = AudioLevelAccumulator(silenceFloorDecibels: microphoneSilenceFloorDecibels)
    private let engine = AVAudioEngine()
    private let deviceUID: String?
    private let queue = DispatchQueue(label: "synara.audio-level.microphone")
    private var deviceID = AudioDeviceID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    init(deviceUID: String?) {
        self.deviceUID = deviceUID
    }

    func start() throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined {
            let granted = DispatchSemaphore(value: 0)
            var allowed = false
            AVCaptureDevice.requestAccess(for: .audio) { result in
                allowed = result
                granted.signal()
            }
            // Consent can stay open indefinitely. Keep the main run loop
            // servicing SIGTERM and the parent monitor while waiting, so
            // switching the source off or quitting still releases this helper.
            while granted.wait(timeout: .now()) != .success {
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
            }
            guard allowed else { throw denied() }
        } else if status != .authorized {
            throw denied()
        }

        if let deviceUID {
            try startDeviceReader(uid: deviceUID)
            return
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw AppSnapFailure(code: "microphone_unavailable", message: "No microphone is available.")
        }
        let accumulator = accumulator
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let channels = buffer.floatChannelData else { return }
            let count = Int(buffer.frameLength)
            for channel in 0..<Int(buffer.format.channelCount) {
                accumulator.add(channels[channel], count: count)
            }
        }
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw AppSnapFailure(code: "microphone_unavailable", message: error.localizedDescription)
        }
    }

    func stop() {
        if deviceID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(deviceID, ioProcID)
            AudioDeviceDestroyIOProcID(deviceID, ioProcID)
            self.ioProcID = nil
            deviceID = AudioDeviceID(kAudioObjectUnknown)
            return
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    /// Reads one device straight from Core Audio. AVAudioEngine shares one
    /// unit between input and output on macOS, so pointing its input at a
    /// device other than the current output fails to start. A missing device
    /// fails instead of falling back to the default input, which may be a
    /// Bluetooth headset whose playback quality drops once its microphone opens.
    private func startDeviceReader(uid: String) throws {
        guard let device = audioInputDeviceID(uid: uid) else {
            throw AppSnapFailure(code: "microphone_unavailable", message: "The chosen microphone is not connected.")
        }
        let accumulator = accumulator
        var procID: AudioDeviceIOProcID?
        var status = AudioDeviceCreateIOProcIDWithBlock(&procID, device, queue) { _, input, _, _, _ in
            // HAL IO procs deliver 32-bit float PCM.
            for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)) {
                guard let data = buffer.mData else { continue }
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                accumulator.add(data.assumingMemoryBound(to: Float.self), count: count)
            }
        }
        guard status == noErr, let procID else {
            throw AppSnapFailure(
                code: "microphone_unavailable",
                message: "Could not attach to the chosen microphone (OSStatus \(status))."
            )
        }
        status = AudioDeviceStart(device, procID)
        guard status == noErr else {
            AudioDeviceDestroyIOProcID(device, procID)
            throw AppSnapFailure(
                code: "microphone_unavailable",
                message: "Could not start the chosen microphone (OSStatus \(status))."
            )
        }
        deviceID = device
        ioProcID = procID
    }

    private func denied() -> AppSnapFailure {
        AppSnapFailure(code: "microphone_denied", message: "Microphone access is off for Synara.")
    }
}

// MARK: - Input devices

/// Every device that can record, for the microphone picker. Only names and
/// identifiers are read; no device is opened.
func listAudioInputDevices() -> [[String: Any]] {
    let defaultInput: AudioDeviceID? = readAudioProperty(
        AudioObjectID(kAudioObjectSystemObject),
        kAudioHardwarePropertyDefaultInputDevice
    )
    return audioDeviceIDs().compactMap { deviceID in
        guard audioDeviceHasInput(deviceID),
              let uid = readAudioString(deviceID, kAudioDevicePropertyDeviceUID) else { return nil }
        let transport: UInt32 = readAudioProperty(deviceID, kAudioDevicePropertyTransportType) ?? 0
        return [
            "id": uid,
            "name": readAudioString(deviceID, kAudioObjectPropertyName) ?? uid,
            "bluetooth": transport == kAudioDeviceTransportTypeBluetooth
                || transport == kAudioDeviceTransportTypeBluetoothLE,
            "default": deviceID == defaultInput,
        ]
    }
}

func audioInputDeviceID(uid: String) -> AudioDeviceID? {
    audioDeviceIDs().first { deviceID in
        audioDeviceHasInput(deviceID) && readAudioString(deviceID, kAudioDevicePropertyDeviceUID) == uid
    }
}

private func audioDeviceIDs() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func audioDeviceHasInput(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr && size > 0
}

private func readAudioProperty<Value>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Value? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<Value>.size)
    let pointer = UnsafeMutablePointer<Value>.allocate(capacity: 1)
    defer { pointer.deallocate() }
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, pointer) == noErr else { return nil }
    return pointer.pointee
}

private func readAudioString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value) == noErr,
          let string = value?.takeRetainedValue() else { return nil }
    return string as String
}
