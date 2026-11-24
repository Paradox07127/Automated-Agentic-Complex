import Accelerate
import AVFoundation
import Foundation
import Speech

/// At most one event per `interval`.
struct RateLimit {
    let interval: TimeInterval
    private var last: TimeInterval?

    init(interval: TimeInterval) { self.interval = interval }

    mutating func allow(at now: TimeInterval) -> Bool {
        if let last, now - last < interval - 1e-9 { return false }
        last = now
        return true
    }
}

/// The transcript so far: the final pieces, then the volatile one that the next result replaces.
struct Transcript {
    private(set) var final = ""

    /// The text `speech.partial` sends after this result.
    mutating func add(_ piece: String, isFinal: Bool) -> String {
        if isFinal {
            final += piece
            return final
        }
        return final + piece
    }
}

/// CONTRACT §7.7 `speech.locales`, `mic.start` and `mic.stop`: an AVAudioEngine
/// input tap feeding SpeechTranscriber through a SpeechAnalyzer, with each buffer's RMS for `mic.level`.
@available(macOS 26, *)
enum Mic {
    private static let environment = ProcessInfo.processInfo.environment
    /// The replay's switches: the no-grant path, and a synthetic tone in place of the microphone.
    private static let deniedForTests = environment["AC_HELPER_MIC_DENIED"] != nil
    static let synthetic = environment["AC_HELPER_MIC_SYNTHETIC"] != nil
    /// The replay's switch: mic.start sends one speech.download before its answer, as a download would.
    private static let downloadProbe = environment["AC_HELPER_DOWNLOAD_PROBE"] != nil
    /// CONTRACT §7.7: at most 20 mic.level a second.
    static let levelInterval: TimeInterval = 0.05
    /// The download's progress is read every 250 ms.
    static let downloadInterval: Duration = .milliseconds(250)

    private static let lock = NSLock()
    private static var current: Recording?
    private static let levelWriter = DispatchQueue(label: "ac-helper.mic.level")

    private final class LatestLevel: @unchecked Sendable {
        let lock = NSLock()
        var value: Double?
    }

    /// A session from mic.start until mic.stop takes it; `starting` is left once mic.start has answered.
    final class Recording: @unchecked Sendable {
        let id: String
        let starting = DispatchGroup()
        let lock = NSLock()
        /// mic.start's answer is out; its events wait for it (guarded by Mic's lock).
        var answered = false
        var running = false
        var startedAt: TimeInterval = 0
        var engine: AVAudioEngine?
        var tone: DispatchSourceTimer?
        var analyzer: SpeechAnalyzer?
        var input: AsyncStream<AnalyzerInput>.Continuation?
        var text: Task<String, Never>?

        init(_ id: String) {
            self.id = id
            starting.enter()
        }
    }

    /// The helper is recording (attention.sample's mic_active is null then).
    static var active: Bool { lock.withLock { current != nil } }

    /// The new session, or nil when one is open (mic_busy).
    static func reserve(_ id: String) -> Recording? {
        lock.withLock {
            guard current == nil else { return nil }
            let recording = Recording(id)
            current = recording
            return recording
        }
    }

    static func release(_ recording: Recording) {
        lock.withLock { if current === recording { current = nil } }
    }

    static func isCurrent(_ recording: Recording) -> Bool { lock.withLock { current === recording } }

    /// The session's events go out from now on: mic.start's answer has been written.
    static func answered(_ params: [String: Any]) {
        lock.withLock { if current?.id == params["session"] as? String { current?.answered = true } }
    }

    private static func live(_ recording: Recording) -> Bool { lock.withLock { current === recording && recording.answered } }

    /// speech.download goes only while mic.start has not answered (CONTRACT §8 `during`).
    private static func downloading(_ recording: Recording) -> Bool { lock.withLock { current === recording && !recording.answered } }

    private static func progress(_ recording: Recording, _ p: Progress) {
        Events.emit("speech.download", ["session": recording.id, "fraction": min(1, max(0, p.fractionCompleted)),
                                        "completed": max(0, Int(p.completedUnitCount)), "total": max(0, Int(p.totalUnitCount))],
                    live: { downloading(recording) })
    }

    static func locales(_ params: [String: Any]) -> Outcome {
        guard SpeechTranscriber.isAvailable else { return asrUnavailable("SpeechTranscriber is not available") }
        guard let found = waitFor(4, { await SpeechTranscriber.supportedLocales }), case let .success(locales) = found else {
            return asrUnavailable("SpeechTranscriber did not list its locales")
        }
        return .success(["engine": "SpeechTranscriber", "locales": locales.map { $0.identifier(.bcp47) }.sorted()])
    }

    private static func asrUnavailable(_ why: String, retryable: Bool = false) -> Outcome {
        .failure(code: "asr_unavailable", message: why, retryable: retryable)
    }

    private enum Failure: Error {
        case localeUnsupported, noFormat, noConverter, noDevice
    }

    static func start(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        let id = params["session"] as! String, asked = params["locale"] as! String
        let transcribe = JSON.bool(params["transcribe"]) ?? true, levels = flag(params, "level_events")
        guard let recording = reserve(id) else { return .failure(code: "mic_busy", message: "another session is recording") }
        var started = false
        defer {
            if !started { release(recording) }
            recording.starting.leave()
        }
        if !synthetic {
            // Checked before the engine: opening the input without a grant shows the system prompt.
            guard !deniedForTests, AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                return .failure(code: "permission_denied", message: "the helper lacks the Microphone grant")
            }
            guard AVCaptureDevice.default(for: .audio) != nil else {
                return .failure(code: "no_audio_device", message: "there is no audio input device")
            }
        }
        if transcribe, !SpeechTranscriber.isAvailable { return asrUnavailable("SpeechTranscriber is not available") }
        let got = waitFor(115, cancelled: cancelled) {
            try await begin(recording, locale: asked, transcribe: transcribe, levels: levels)
        }
        switch got {
        case nil:
            release(recording)
            teardown(recording)
            return .failure(code: "timeout", message: "the microphone did not start within 115 s", retryable: true)
        case let .failure(error)?:
            teardown(recording)
            switch error {
            case Failure.localeUnsupported:
                return .failure(code: "locale_unsupported", message: "SpeechTranscriber has no locale like \(asked)")
            case Failure.noDevice:
                return .failure(code: "no_audio_device", message: "the audio input has no format")
            case Failure.noFormat, Failure.noConverter:
                return asrUnavailable("the analyzer takes no format the input converts to")
            default:
                return asrUnavailable("starting failed: \(error)", retryable: true)
            }
        case let .success(answer)?:
            if cancelled() {
                release(recording)
                teardown(recording)
            }
            started = true
            return .success(["session": id, "locale": answer.locale, "sample_rate": answer.sampleRate])
        }
    }

    /// Prepares the transcriber (downloading its assets when they are missing) and opens the input.
    private static func begin(_ recording: Recording, locale asked: String, transcribe: Bool,
                              levels: Bool) async throws -> (locale: String, sampleRate: Int) {
        // A start that was cancelled or timed out meanwhile closes what this task opened, also when it then throws.
        defer { if !isCurrent(recording) { teardown(recording) } }
        var locale = Locale(identifier: asked).identifier(.bcp47)
        var analyzerFormat: AVAudioFormat?
        if downloadProbe {
            let probe = Progress(totalUnitCount: 2)
            probe.completedUnitCount = 1
            progress(recording, probe)
        }
        if transcribe {
            guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: asked)) else {
                throw Failure.localeUnsupported
            }
            locale = supported.identifier(.bcp47)
            let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults],
                                                attributeOptions: [])
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                let reader = Task {
                    while !Task.isCancelled {
                        progress(recording, request.progress)
                        try? await Task.sleep(for: downloadInterval, tolerance: .milliseconds(10))
                    }
                }
                defer { reader.cancel() }
                try await request.downloadAndInstall()
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                throw Failure.noFormat
            }
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            try await analyzer.prepareToAnalyze(in: format)
            let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
            let text = Task {
                var transcript = Transcript()
                do {
                    for try await result in transcriber.results {
                        let sofar = transcript.add(String(result.text.characters), isFinal: result.isFinal)
                        Events.emit("speech.partial", ["session": recording.id, "text": sofar],
                                    live: { live(recording) })
                    }
                } catch {}
                return transcript.final
            }
            recording.lock.withLock {
                recording.analyzer = analyzer
                recording.input = input
                recording.text = text
            }
            guard isCurrent(recording) else { throw CancellationError() }
            try await analyzer.start(inputSequence: stream)
            analyzerFormat = format
        }
        let source = synthetic ? Tone.format : nil
        let engine = synthetic ? nil : AVAudioEngine()
        guard let inputFormat = source ?? engine?.inputNode.outputFormat(forBus: 0), inputFormat.sampleRate > 0 else {
            throw Failure.noDevice
        }
        var converter: AVAudioConverter?
        if let analyzerFormat {
            guard let made = AVAudioConverter(from: inputFormat, to: analyzerFormat) else { throw Failure.noConverter }
            made.primeMethod = .none
            converter = made
        }
        let feed = feeder(recording, converter: converter, input: recording.lock.withLock { recording.input }, levels: levels)
        try open(recording) {
            guard let engine else { return (nil, Tone.start(feed)) }
            engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in feed(buffer) }
            engine.prepare()
            try engine.start()
            return (engine, nil)
        }
        return (locale, Int(inputFormat.sampleRate))
    }

    /// Opens the input with `start` and keeps what it opened; a session mic.start no longer waits for opens nothing.
    static func open(_ recording: Recording, _ start: () throws -> (engine: AVAudioEngine?, tone: DispatchSourceTimer?)) throws {
        guard isCurrent(recording) else { throw CancellationError() }
        let (engine, tone) = try start()
        recording.lock.withLock {
            recording.engine = engine
            recording.tone = tone
            recording.startedAt = ProcessInfo.processInfo.systemUptime
            recording.running = true
        }
    }

    /// Each input buffer's RMS for mic.level, and the buffer converted for the analyzer; runs on the audio thread. The
    /// level waits for stdout on `levelWriter`, the newest replacing one not yet written.
    static func feeder(_ recording: Recording, converter: AVAudioConverter?,
                       input: AsyncStream<AnalyzerInput>.Continuation?, levels: Bool) -> (AVAudioPCMBuffer) -> Void {
        var limit = RateLimit(interval: levelInterval)
        let waiting = LatestLevel()
        return { buffer in
            if levels, let samples = buffer.floatChannelData?[0], buffer.frameLength > 0,
               limit.allow(at: ProcessInfo.processInfo.systemUptime) {
                let level = rms(samples, Int(buffer.frameLength))
                if waiting.lock.withLock({ defer { waiting.value = level }; return waiting.value == nil }) {
                    levelWriter.async {
                        guard let level = waiting.lock.withLock({ defer { waiting.value = nil }; return waiting.value }) else { return }
                        Events.emit("mic.level", ["session": recording.id, "rms": level], live: { live(recording) })
                    }
                }
            }
            guard let converter, let input else { return }
            let format = converter.outputFormat
            let capacity = AVAudioFrameCount((Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate).rounded(.up))
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in
                if fed {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                fed = true
                inputStatus.pointee = .haveData
                return buffer
            }
            if status != .error, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
        }
    }

    /// The root mean square of `count` samples, clamped to 0–1.
    static func rms(_ samples: UnsafePointer<Float>, _ count: Int) -> Double {
        var value: Float = 0
        vDSP_rmsqv(samples, 1, &value, vDSP_Length(count))
        return value.isFinite ? min(1, max(0, Double(value))) : 0
    }

    /// Closes the input and the analyzer without waiting for a transcript; safe to call more than once.
    private static func teardown(_ recording: Recording) {
        let (engine, tone, analyzer, input) = recording.lock.withLock { () -> (AVAudioEngine?, DispatchSourceTimer?, SpeechAnalyzer?, AsyncStream<AnalyzerInput>.Continuation?) in
            defer {
                recording.engine = nil
                recording.tone = nil
                recording.analyzer = nil
                recording.input = nil
                recording.running = false
            }
            return (recording.engine, recording.tone, recording.analyzer, recording.input)
        }
        stopAudio(engine, tone)
        input?.finish()
        if let analyzer { Task.detached { await analyzer.cancelAndFinishNow() } }
    }

    private static func stopAudio(_ engine: AVAudioEngine?, _ tone: DispatchSourceTimer?) {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        tone?.cancel()
    }

    static func stop(_ params: [String: Any]) -> Outcome {
        let id = params["session"] as! String
        let notRecording = Outcome.failure(code: "not_recording", message: "no session with that id is recording")
        guard let recording = lock.withLock({ current?.id == id ? current : nil }) else { return notRecording }
        // A mic.start still running finishes first.
        _ = recording.starting.wait(timeout: .now() + 8)
        let taken = lock.withLock { () -> Bool in
            guard current === recording, recording.lock.withLock({ recording.running }) else { return false }
            current = nil
            return true
        }
        guard taken else { return notRecording }
        let (engine, tone, analyzer, input, text, startedAt) = recording.lock.withLock {
            defer {
                recording.engine = nil
                recording.tone = nil
                recording.analyzer = nil
                recording.input = nil
                recording.text = nil
                recording.running = false
            }
            return (recording.engine, recording.tone, recording.analyzer, recording.input, recording.text, recording.startedAt)
        }
        stopAudio(engine, tone)
        let duration = Int(((ProcessInfo.processInfo.systemUptime - startedAt) * 1000).rounded())
        input?.finish()
        var said = ""
        if let analyzer {
            if flag(params, "discard") {
                Task.detached { await analyzer.cancelAndFinishNow() }
            } else {
                let got = waitFor(8) { () async -> String in
                    try? await analyzer.finalizeAndFinishThroughEndOfInput()
                    return await text?.value ?? ""
                }
                guard case let .success(final)? = got else {
                    Task.detached { await analyzer.cancelAndFinishNow() }
                    return .failure(code: "timeout", message: "the transcript did not finish within 8 s", retryable: true)
                }
                said = final
            }
        }
        return .success(["session": id, "text": said, "duration_ms": max(0, duration)])
    }
}

/// The replay's synthetic microphone (AC_HELPER_MIC_SYNTHETIC): a 440 Hz tone at amplitude 0.25 in 50 ms buffers.
enum Tone {
    static let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    static let amplitude: Float = 0.25

    static func start(_ feed: @escaping (AVAudioPCMBuffer) -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ac-helper.tone"))
        let frames = AVAudioFrameCount(format.sampleRate / 20)
        var phase = 0.0
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
            buffer.frameLength = frames
            let samples = buffer.floatChannelData![0]
            for k in 0..<Int(frames) {
                samples[k] = amplitude * Float(sin(phase))
                phase += 2 * Double.pi * 440 / format.sampleRate
            }
            feed(buffer)
        }
        timer.resume()
        return timer
    }
}
