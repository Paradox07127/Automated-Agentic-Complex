// clipboard.read's shaping over a private pasteboard: the replay cannot fill one, and must not read the user's.
import AppKit
@testable import HelperCore
import XCTest

final class ClipboardTests: XCTestCase {
    private var pasteboard: NSPasteboard!

    override func setUp() {
        pasteboard = NSPasteboard.withUniqueName()
    }

    override func tearDown() {
        pasteboard.releaseGlobally()
    }

    private func put(_ items: [[String: String]]) {
        pasteboard.clearContents()
        pasteboard.writeObjects(items.map { strings in
            let item = NSPasteboardItem()
            for (type, value) in strings { item.setString(value, forType: NSPasteboard.PasteboardType(type)) }
            return item
        })
    }

    func testFileThenURLThenTextWithEveryType() throws {
        put([["public.file-url": "file:///tmp/a%20b.txt", "public.utf8-plain-text": "/tmp/a b.txt"],
             ["public.url": "https://example.com/x", "public.utf8-plain-text": "https://example.com/x"],
             ["public.utf8-plain-text": "plain"],
             ["com.example.private": "x"]])
        let read = Clipboard.read(pasteboard, [:])
        let items = try XCTUnwrap(read["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 4)
        XCTAssertEqual(items[0]["file"] as? String, "/tmp/a b.txt")
        XCTAssertNil(items[0]["text"])
        XCTAssertEqual(Set(items[0]["types"] as? [String] ?? []), ["public.file-url", "public.utf8-plain-text"])
        XCTAssertEqual(items[1]["url"] as? String, "https://example.com/x")
        XCTAssertEqual(items[2]["text"] as? String, "plain")
        XCTAssertEqual(items[3]["types"] as? [String], ["com.example.private"])
        XCTAssertNil(items[3]["text"])
        XCTAssertEqual(read["concealed"] as? Bool, false)
        XCTAssertEqual(read["truncated"] as? Bool, false)
    }

    func testAConcealedItemLeavesTheWholePasteboardUnread() throws {
        put([["public.utf8-plain-text": "visible"], ["public.utf8-plain-text": "secret", "org.nspasteboard.ConcealedType": ""]])
        let read = Clipboard.read(pasteboard, [:])
        XCTAssertEqual((read["items"] as? [Any])?.count, 0)
        XCTAssertEqual(read["concealed"] as? Bool, true)
    }

    func testLimitsCutItemsAndTextAtAScalarBoundary() throws {
        put([["public.utf8-plain-text": "中文字"], ["public.utf8-plain-text": "b"], ["public.utf8-plain-text": "c"]])
        let cut = Clipboard.read(pasteboard, ["max_items": 2, "max_text_bytes": 4])
        let items = try XCTUnwrap(cut["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0]["text"] as? String, "中")
        XCTAssertEqual(cut["truncated"] as? Bool, true)
        let first = Clipboard.read(pasteboard, ["first_only": true])
        XCTAssertEqual((first["items"] as? [Any])?.count, 1)
        XCTAssertEqual(first["truncated"] as? Bool, false)
    }
}
