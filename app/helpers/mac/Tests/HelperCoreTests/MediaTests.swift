// The pure parts of the capture, OCR and voice ops: sizes and encodings, line order, levels, transcripts, combos and the
// one recording session. No screen is captured and no microphone opened.
import AVFoundation
import Carbon.HIToolbox
import CoreGraphics
import CoreText
@testable import HelperCore
import ImageIO
import XCTest

final class MediaTests: XCTestCase {
    func testTheLongSideScalesDownOnly() {
        XCTAssertTrue(Capture.scaledSize(width: 2560, height: 1600, maxLongSide: 1280) == (1280, 800))
        XCTAssertTrue(Capture.scaledSize(width: 1000, height: 3001, maxLongSide: 1000) == (333, 1000))
        XCTAssertTrue(Capture.scaledSize(width: 640, height: 480, maxLongSide: 1280) == (640, 480))
        XCTAssertTrue(Capture.scaledSize(width: 640, height: 480, maxLongSide: nil) == (640, 480))
        XCTAssertTrue(Capture.scaledSize(width: 4000, height: 1, maxLongSide: 10) == (10, 1))
    }

    func testEncodingsKeepTheirFormatAndScaledSize() throws {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())  // transparent everywhere
        let png = try XCTUnwrap(Capture.encode(image, jpeg: false, maxLongSide: 10))
        XCTAssertTrue(png.width == 10 && png.height == 5)
        XCTAssertEqual(Array(png.data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        let jpeg = try XCTUnwrap(Capture.encode(image, jpeg: true, maxLongSide: nil))
        XCTAssertTrue(jpeg.width == 40 && jpeg.height == 20)
        XCTAssertEqual(Array(jpeg.data.prefix(2)), [0xFF, 0xD8])
        // Transparent pixels go on white.
        let decoded = try XCTUnwrap(CGImageSourceCreateWithData(jpeg.data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        let pixels = try XCTUnwrap(Capture.rgba(decoded, side: 2))
        XCTAssertTrue(pixels.count == 16 && pixels.allSatisfy { $0 > 240 })
    }

    func testAmbientRectsAreCutToTheDisplay() {
        let second = CGRect(x: 1512, y: -200, width: 1920, height: 1080)
        XCTAssertEqual(Capture.sourceRect(CGRect(x: 1400, y: 0, width: 300, height: 100), displayFrame: second),
                       CGRect(x: 0, y: 200, width: 188, height: 100))
        XCTAssertNil(Capture.sourceRect(CGRect(x: 0, y: 0, width: 100, height: 100), displayFrame: second))
    }

    func testOCRLinesRunTopToBottomThenLeftToRightWithTopLeftBounds() {
        let lines = OCR.lines([
            (text: "right", box: CGRect(x: 0.6, y: 0.8, width: 0.2, height: 0.1), confidence: 0.5),
            (text: "low", box: CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.1), confidence: nil),
            (text: "left", box: CGRect(x: 0.1, y: 0.8, width: 0.2, height: 0.1), confidence: 1),
        ])
        XCTAssertEqual(lines.map { $0["text"] as? String }, ["left", "right", "low"])
        let bounds = lines[2]["bounds"] as? [String: Double]
        XCTAssertEqual(bounds?["x"] ?? -1, 0.1, accuracy: 1e-9)
        XCTAssertEqual(bounds?["y"] ?? -1, 0.8, accuracy: 1e-9)
        XCTAssertEqual(bounds?["height"] ?? -1, 0.1, accuracy: 1e-9)
        XCTAssertTrue(lines[2]["confidence"] is NSNull)
    }

    func testRecognizeReadsTextDrawnIntoAnImage() throws {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: 480, height: 96, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 480, height: 96))
        let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
        let text = NSAttributedString(string: "Endfield 42", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1)])
        context.textPosition = CGPoint(x: 24, y: 30)
        CTLineDraw(CTLineCreateWithAttributedString(text), context)
        let png = try XCTUnwrap(Capture.encode(try XCTUnwrap(context.makeImage()), jpeg: false, maxLongSide: nil))
        let outcome = OCR.recognize(["image": ["format": "png", "width": 480, "height": 96, "data": png.data.base64EncodedString()],
                                     "languages": ["en-US", "xx-YY"]])
        guard case let .success(result) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(result["text"] as? String, "Endfield 42")
        XCTAssertEqual(result["languages"] as? [String], ["en-US"])
        let bounds = try XCTUnwrap((result["lines"] as? [[String: Any]])?.first?["bounds"] as? [String: Double])
        XCTAssertTrue(bounds["x"]! > 0 && bounds["y"]! > 0.2 && bounds["y"]! + bounds["height"]! < 0.9, "\(bounds)")
    }

    func testLevelsAreRMSClampedAndAtMostTwentyASecond() {
        let half = [Float](repeating: 0.5, count: 8), loud = [Float](repeating: -3, count: 8)
        XCTAssertEqual(half.withUnsafeBufferPointer { Mic.rms($0.baseAddress!, 8) }, 0.5, accuracy: 1e-6)
        XCTAssertEqual(loud.withUnsafeBufferPointer { Mic.rms($0.baseAddress!, 8) }, 1)
        var limit = RateLimit(interval: Mic.levelInterval)
        let sent = stride(from: 0.0, to: 1.0, by: 0.01).filter { limit.allow(at: 100 + $0) }
        XCTAssertEqual(sent.count, 20)
    }

    /// The audio thread never waits for stdout: a level goes out from elsewhere while the main process is not reading.
    func testTheTapDoesNotWaitForStdout() throws {
        let recording = try XCTUnwrap(Mic.reserve("v-tap"))
        defer { Mic.release(recording) }
        Mic.answered(["session": "v-tap"])
        let stdout = DispatchSemaphore(value: 0)
        let written = expectation(description: "mic.level")
        Events.connect { name, _, live in
            if name == "mic.level", live() { written.fulfill() }
            stdout.wait()
        }
        defer {
            Events.connect { _, _, _ in }
            for _ in 0..<4 { stdout.signal() }
        }
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: Tone.format, frameCapacity: 800))
        buffer.frameLength = 800
        for k in 0..<800 { buffer.floatChannelData![0][k] = 0.25 }
        let feed = Mic.feeder(recording, converter: nil, input: nil, levels: true)
        let fed = expectation(description: "fed")
        DispatchQueue.global().async {
            feed(buffer)
            fed.fulfill()
        }
        wait(for: [fed], timeout: 1)
        wait(for: [written], timeout: 1)
    }

    /// A mic.start that timed out or was cancelled has released its session; its start task opens no input after that.
    func testAReleasedSessionOpensNoInput() throws {
        let recording = try XCTUnwrap(Mic.reserve("v-late"))
        Mic.release(recording)
        let opened = Recorder()
        XCTAssertThrowsError(try Mic.open(recording) {
            opened.add("input")
            return (nil, nil)
        })
        XCTAssertEqual(opened.names, [])
        XCTAssertFalse(recording.running)
    }

    func testPartialsCarryTheFinalPiecesAndTheVolatileOne() {
        var transcript = Transcript()
        XCTAssertEqual(transcript.add("帮我", isFinal: false), "帮我")
        XCTAssertEqual(transcript.add("帮我看", isFinal: true), "帮我看")
        XCTAssertEqual(transcript.add("一下", isFinal: false), "帮我看一下")
        XCTAssertEqual(transcript.add("一下这个窗口", isFinal: true), "帮我看一下这个窗口")
        XCTAssertEqual(transcript.final, "帮我看一下这个窗口")
    }

    func testCombosParseAsConfigParseHotkey() {
        XCTAssertEqual(PushToTalk.parse("right_option"), .rightOption)
        XCTAssertEqual(PushToTalk.parse("Control+Option+Space"),
                       .carbon(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)))
        XCTAssertEqual(PushToTalk.parse("cmd+shift+f12"), .carbon(keyCode: UInt32(kVK_F12), modifiers: UInt32(cmdKey | shiftKey)))
        for bad in ["control+f99", "hyper+a", "control+", "", "option+right_option"] { XCTAssertNil(PushToTalk.parse(bad), bad) }
    }

    func testOneRecordingAtATimeAndMicActiveIsUnknownMeanwhile() throws {
        let first = try XCTUnwrap(Mic.reserve("v-1"))
        defer { Mic.release(first) }
        XCTAssertNil(Mic.reserve("v-2"))
        XCTAssertTrue(Mic.active)
        XCTAssertNil(Devices.micActive())
        Mic.release(first)
        XCTAssertFalse(Mic.active)
        let second = try XCTUnwrap(Mic.reserve("v-2"))
        XCTAssertTrue(Mic.isCurrent(second))
        Mic.release(second)
    }
}
