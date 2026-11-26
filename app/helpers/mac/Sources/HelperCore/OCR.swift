import CoreGraphics
import Foundation
import ImageIO
import Vision

/// `ocr.languages` and `ocr.recognize`: Vision's accurate level with
/// language correction.
enum OCR {
    static let defaultLanguages = ["zh-Hans", "en-US"]

    /// Vision refuses images with a side of 2 pixels or less; nothing on them is text.
    static let smallestSide = 3

    static func supported() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    static let unavailable = Outcome.failure(code: "ocr_unavailable", message: "Vision offers none of the languages")

    static func languages(_ params: [String: Any]) -> Outcome {
        let languages = supported()
        return languages.isEmpty ? unavailable : .success(["languages": languages])
    }

    /// One recognized line: its text, its Vision box (normalized, origin bottom left) and its confidence.
    typealias Found = (text: String, box: CGRect, confidence: Double?)

    /// `ocr_line`s from top to bottom, then left to right, with top-left boxes.
    static func lines(_ found: [Found]) -> [[String: Any]] {
        found.sorted { $0.box.maxY != $1.box.maxY ? $0.box.maxY > $1.box.maxY : $0.box.minX < $1.box.minX }.map { line in
            let b = line.box
            return ["text": line.text, "confidence": JSON.optional(line.confidence),
                    "bounds": rectJSON(CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height))]
        }
    }

    static func recognize(_ params: [String: Any], _ cancelled: @escaping () -> Bool = { false }) -> Outcome {
        let available = supported()
        let languages = ((params["languages"] as? [String]) ?? defaultLanguages).filter(available.contains)
        guard !languages.isEmpty else { return unavailable }
        let image: CGImage
        if let id = JSON.int(params["window_id"]) {
            switch Capture.windowImage(id, cancelled: cancelled) {
            case let .failure(failure): return failure.outcome
            case let .success(captured): image = captured.image
            }
        } else {
            let given = params["image"] as! [String: Any]
            guard let data = Data(base64Encoded: given["data"] as! String),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                return .failure(code: "bad_request", message: "params.image.data is not an image ImageIO reads")
            }
            image = decoded
        }
        var found: [Found] = []
        if min(image.width, image.height) >= smallestSide {
            if cancelled() { return .failure(code: "cancelled", message: "cancelled before Vision ran") }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = languages
            request.usesLanguageCorrection = true
            do {
                try VNImageRequestHandler(cgImage: image).perform([request])
            } catch {
                return .failure(code: "ocr_unavailable", message: "Vision failed: \(error.localizedDescription)")
            }
            found = (request.results ?? []).compactMap { item in
                item.topCandidates(1).first.map { ($0.string, item.boundingBox, Double($0.confidence)) }
            }
        }
        let lines = lines(found)
        return .success(["text": lines.map { $0["text"] as! String }.joined(separator: "\n"), "lines": lines,
                         "languages": languages])
    }
}
