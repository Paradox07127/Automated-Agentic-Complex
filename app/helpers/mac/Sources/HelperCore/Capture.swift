import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The result of an async system call, waited for on the calling thread; nil when `seconds` passed or `cancelled` turned
/// true first. The task is cancelled then and its result dropped; one cancelled before the call is never started.
func waitFor<T>(_ seconds: TimeInterval, cancelled: () -> Bool = { false },
                _ body: @escaping () async throws -> T) -> Result<T, Error>? {
    if cancelled() { return nil }
    let box = ResultBox<T>()
    let done = DispatchSemaphore(value: 0)
    let task = Task.detached {
        let value: Result<T, Error>
        do { value = .success(try await body()) } catch { value = .failure(error) }
        box.lock.withLock { box.value = value }
        done.signal()
    }
    let deadline = Date().addingTimeInterval(seconds)
    while done.wait(timeout: .now() + 0.1) == .timedOut {
        if cancelled() || Date() >= deadline {
            task.cancel()
            return nil
        }
    }
    return box.lock.withLock { box.value }
}

private final class ResultBox<T>: @unchecked Sendable {
    let lock = NSLock()
    var value: Result<T, Error>?
}

/// Screen Recording, checked without the prompt SCShareableContent would show: unattended requests must not prompt.
enum ScreenGrant {
    /// The replay's switch for the no-grant path on a Mac that has the grant.
    private static let deniedForTests = ProcessInfo.processInfo.environment["AC_HELPER_SCREEN_DENIED"] != nil

    static var granted: Bool { !deniedForTests && CGPreflightScreenCaptureAccess() }

    static let denied = Outcome.failure(code: "permission_denied", message: "the helper lacks the Screen Recording grant")
}

/// CONTRACT §7.5 `capture.window` and `capture.ambient`.
enum Capture {
    /// Under the ops' 5 s timeout_ms.
    static let limit: TimeInterval = 4

    /// One window at its backing pixel size without the cursor, and its points-to-pixels scale; the failure is an outcome.
    static func windowImage(_ id: Int, cancelled: () -> Bool = { false }) -> Result<(image: CGImage, scale: Double), Failure> {
        guard ScreenGrant.granted else { return .failure(Failure(ScreenGrant.denied)) }
        let got = waitFor(limit, cancelled: cancelled) { () async throws -> (CGImage, Double)? in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            try Task.checkCancellation()
            guard let window = content.windows.first(where: { Int($0.windowID) == id }) else { return nil }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = Int((window.frame.width * CGFloat(filter.pointPixelScale)).rounded())
            configuration.height = Int((window.frame.height * CGFloat(filter.pointPixelScale)).rounded())
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            return (image, Double(filter.pointPixelScale))
        }
        switch got {
        case nil:
            return .failure(Failure(.failure(code: "timeout", message: "the capture took longer than 4 s", retryable: true)))
        case let .failure(error)?:
            return .failure(Failure(.failure(code: "capture_failed", message: "ScreenCaptureKit failed: \(error)")))
        case .success(nil)?:
            return .failure(Failure(.failure(code: "window_gone", message: "window \(id) is not on screen")))
        case let .success(found?)?:
            return .success((found.0, found.1))
        }
    }

    struct Failure: Error {
        let outcome: Outcome

        init(_ outcome: Outcome) { self.outcome = outcome }
    }

    static func window(_ params: [String: Any], _ cancelled: @escaping () -> Bool) -> Outcome {
        let jpeg = params["format"] as? String == "jpeg"
        switch windowImage(JSON.int(params["window_id"])!, cancelled: cancelled) {
        case let .failure(failure):
            return failure.outcome
        case let .success((image, scale)):
            guard let encoded = encode(image, jpeg: jpeg, maxLongSide: JSON.int(params["max_long_side"])) else {
                return .failure(code: "capture_failed", message: "the image could not be encoded")
            }
            if let most = JSON.int(params["max_bytes"]), encoded.data.count > most {
                return .failure(code: "too_large", message: "the encoded image has \(encoded.data.count) bytes, over max_bytes")
            }
            return .success(["image": ["format": jpeg ? "jpeg" : "png", "width": encoded.width, "height": encoded.height,
                                       "data": encoded.data.base64EncodedString()],
                             "scale": scale])
        }
    }

    /// The long side scaled down to `maxLongSide` when it is longer, the other side rounded to nearest.
    static func scaledSize(width: Int, height: Int, maxLongSide: Int?) -> (width: Int, height: Int) {
        let longSide = max(width, height)
        guard let maxLongSide, longSide > maxLongSide else { return (width, height) }
        let scale = Double(maxLongSide) / Double(longSide)
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// PNG, or JPEG at quality 0.8 with transparent pixels on white.
    static func encode(_ image: CGImage, jpeg: Bool, maxLongSide: Int?) -> (data: Data, width: Int, height: Int)? {
        let (width, height) = scaledSize(width: image.width, height: image.height, maxLongSide: maxLongSide)
        var output = image
        let opaque = [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
        if width != image.width || height != image.height || (jpeg && !opaque) {
            let info = jpeg ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: space, bitmapInfo: info.rawValue) else { return nil }
            let rect = CGRect(x: 0, y: 0, width: width, height: height)
            if jpeg {
                context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                context.fill(rect)
            }
            context.interpolationQuality = .high
            context.draw(image, in: rect)
            guard let drawn = context.makeImage() else { return nil }
            output = drawn
        }
        let data = NSMutableData()
        let type = (jpeg ? UTType.jpeg : UTType.png).identifier as CFString
        guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else { return nil }
        let options = jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary : nil
        CGImageDestinationAddImage(destination, output, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data, width, height)
    }

    /// `side`×`side` sRGB RGBA8 of `image`, rows top to bottom.
    static func rgba(_ image: CGImage, side: Int) -> [UInt8]? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let data = context.data else { return nil }
        return Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: side * side * 4))
    }

    /// `rect` (CG global points) on the display of `frame`, in the display's own top-left points; nil when they miss.
    static func sourceRect(_ rect: CGRect, displayFrame frame: CGRect) -> CGRect? {
        let part = rect.intersection(frame)
        guard !part.isNull, !part.isEmpty else { return nil }
        return part.offsetBy(dx: -frame.minX, dy: -frame.minY)
    }

    static func ambient(_ params: [String: Any], _ cancelled: @escaping () -> Bool) -> Outcome {
        let side = JSON.int(params["side"])!
        let given = JSON.int(params["display_id"])
        let display = given.flatMap { CGDirectDisplayID(exactly: $0) }
        if given != nil && display == nil { return .failure(code: "capture_failed", message: "no display has that display_id") }
        let pixels: [UInt8]
        if params["source"] as? String == "wallpaper" {
            guard let got = wallpaper(display ?? CGMainDisplayID(), side: side) else {
                return .failure(code: "capture_failed", message: "the wallpaper of that display could not be read")
            }
            pixels = got
        } else {
            guard ScreenGrant.granted else { return ScreenGrant.denied }
            let pids = Set(((params["exclude_pids"] as? [Any]) ?? []).compactMap(JSON.int))
            let got = waitFor(limit, cancelled: cancelled) {
                try await screen(rect: rectParam(params["rect"]), display: display, excluding: pids, side: side)
            }
            switch got {
            case nil:
                return .failure(code: "timeout", message: "the capture took longer than 4 s", retryable: true)
            case let .failure(error)?:
                return .failure(code: "capture_failed", message: "ScreenCaptureKit failed: \(error)")
            case .success(nil)?:
                return .failure(code: "capture_failed", message: "no display holds that rect")
            case let .success(found?)?:
                pixels = found
            }
        }
        return .success(["width": side, "height": side, "rgba": Data(pixels).base64EncodedString()])
    }

    /// The display (`display`, else the one holding most of `rect`, else the main one) without the windows of `pids`.
    private static func screen(rect: CGRect?, display: CGDirectDisplayID?, excluding pids: Set<Int>,
                               side: Int) async throws -> [UInt8]? {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        try Task.checkCancellation()
        let displays = content.displays.filter { display == nil || $0.displayID == display }
        let chosen: (SCDisplay, CGRect?)?
        if let rect {
            chosen = displays.compactMap { d in sourceRect(rect, displayFrame: d.frame).map { (d, Optional($0)) } }
                .max { $0.1!.width * $0.1!.height < $1.1!.width * $1.1!.height }
        } else {
            chosen = (displays.first { display != nil || $0.displayID == CGMainDisplayID() }).map { ($0, nil) }
        }
        guard let (target, source) = chosen else { return nil }
        let excluded = content.windows.filter { $0.owningApplication.map { pids.contains(Int($0.processID)) } == true }
        let configuration = SCStreamConfiguration()
        configuration.width = side
        configuration.height = side
        if let source { configuration.sourceRect = source }
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: target, excludingWindows: excluded), configuration: configuration)
        return rgba(image, side: side)
    }

    /// The display's wallpaper through a 256 px thumbnail, so a 6K picture is never decoded in full.
    private static func wallpaper(_ display: CGDirectDisplayID, side: Int) -> [UInt8]? {
        let url = DispatchQueue.main.sync { () -> URL? in
            let screen = NSScreen.screens.first {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
            }
            return screen.flatMap { NSWorkspace.shared.desktopImageURL(for: $0) }
        }
        guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 256,
                  kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        return rgba(image, side: side)
    }
}
