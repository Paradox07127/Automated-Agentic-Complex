// windows.list and windows.at_point read a window's title and app name only when the request asks for them.
import CoreGraphics
@testable import HelperCore
import XCTest

final class WindowsTests: XCTestCase {
    private let info: [String: Any] = [
        kCGWindowNumber as String: NSNumber(value: 41), kCGWindowOwnerPID as String: NSNumber(value: 702),
        kCGWindowBounds as String: CGRect(x: 10, y: 20, width: 300, height: 200).dictionaryRepresentation,
        kCGWindowLayer as String: NSNumber(value: 0), kCGWindowAlpha as String: NSNumber(value: 1),
        kCGWindowName as String: "Bank statement.pdf", kCGWindowOwnerName as String: "Preview",
    ]

    func testTitlesAndAppNameAreReadOnlyWhenAsked() {
        let bare = Windows.window(info, titles: false)
        XCTAssertEqual(bare?.id, 41)
        XCTAssertEqual(bare?.bounds, CGRect(x: 10, y: 20, width: 300, height: 200))
        XCTAssertNil(bare?.title)
        XCTAssertNil(bare?.owner)
        let titled = Windows.window(info, titles: true)
        XCTAssertEqual(titled?.title, "Bank statement.pdf")
        XCTAssertEqual(titled?.owner, "Preview")
    }
}
