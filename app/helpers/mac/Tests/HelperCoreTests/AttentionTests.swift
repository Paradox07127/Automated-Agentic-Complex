// The pure parts of the attention ops: device states, browser answers, modifier flags, input.activity's kinds and rate limit.
import CoreGraphics
@testable import HelperCore
import XCTest

final class AttentionTests: XCTestCase {
    func testDeviceStatesAreUnknownUnlessOneIsActiveOrAllAreIdle() {
        XCTAssertEqual(Devices.anyActive([false, nil, true]), true)
        XCTAssertNil(Devices.anyActive([false, nil]))
        XCTAssertEqual(Devices.anyActive([]), false)
        XCTAssertNil(Devices.micActive([(hasOutput: true, running: true)]))
        XCTAssertEqual(Devices.micActive([(hasOutput: false, running: true), (hasOutput: true, running: false)]), true)
        XCTAssertEqual(Devices.micActive([(hasOutput: false, running: false)]), false)
    }

    func testBrowserAnswers() {
        let safari = Browser.tab(appId: Browser.safari, url: "https://github.com/a/b", mode: nil)
        XCTAssertEqual(safari.host, "github.com")
        XCTAssertNil(safari.incognito)
        let chrome = Browser.tab(appId: Browser.chrome, url: "https://example.com/", mode: "normal")
        XCTAssertEqual(chrome.host, "example.com")
        XCTAssertEqual(chrome.incognito, false)
        let hidden = Browser.tab(appId: Browser.chrome, url: "", mode: "incognito")
        XCTAssertNil(hidden.host)
        XCTAssertEqual(hidden.incognito, true)
        let unknown = Browser.tab(appId: Browser.chrome, url: "https://example.com/", mode: "kiosk")
        XCTAssertNil(unknown.host)
        XCTAssertNil(unknown.incognito)
        XCTAssertNil(Browser.tab(appId: Browser.safari, url: "about:blank", mode: nil).host)
    }

    /// osascript prints Chrome's {URL, mode} as "URL, mode"; a URL never holds ", ".
    func testBrowserOutputs() {
        XCTAssertEqual(Browser.tab(appId: Browser.safari, output: "https://github.com/a/b").host, "github.com")
        let normal = Browser.tab(appId: Browser.chrome, output: "https://example.com/a,b, normal")
        XCTAssertEqual(normal.host, "example.com")
        XCTAssertEqual(normal.incognito, false)
        let hidden = Browser.tab(appId: Browser.chrome, output: ", incognito")
        XCTAssertNil(hidden.host)
        XCTAssertEqual(hidden.incognito, true)
        let failed = Browser.tab(appId: Browser.chrome, output: nil)
        XCTAssertNil(failed.host)
        XCTAssertNil(failed.incognito)
    }

    func testModifiers() {
        let both = Modifiers.json([.maskAlternate, .maskCommand])
        XCTAssertEqual(both as NSDictionary, ["alt": true, "shift": false, "control": false, "meta": true] as NSDictionary)
        XCTAssertEqual(Modifiers.json([.maskShift, .maskControl]) as NSDictionary,
                       ["alt": false, "shift": true, "control": true, "meta": false] as NSDictionary)
    }

    func testOneActivityOfAKindPerHundredMilliseconds() {
        var throttle = ActivityThrottle()
        XCTAssertTrue(throttle.allow("key", at: 10))
        XCTAssertFalse(throttle.allow("key", at: 10.05))
        XCTAssertTrue(throttle.allow("mouse_down", at: 10.05))
        XCTAssertTrue(throttle.allow("key", at: 10.1))
        XCTAssertFalse(throttle.allow("key", at: 10.15))
    }

    func testEveryMousePressAndReleaseIsSent() {
        var throttle = ActivityThrottle()
        for at in [20, 20.01, 20.02] {
            XCTAssertTrue(throttle.allow("mouse_down", at: at))
            XCTAssertTrue(throttle.allow("mouse_up", at: at))
        }
    }

    func testTheTapReadsEachButtonsPressAndRelease() {
        let tapped: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp]
        XCTAssertTrue(tapped.allSatisfy { InputWatch.types.contains($0) })
        XCTAssertEqual(tapped.map(InputWatch.kind), ["mouse_down", "mouse_down", "mouse_down", "mouse_up", "mouse_up", "mouse_up"])
        XCTAssertEqual([CGEventType.keyDown, .scrollWheel].map(InputWatch.kind), ["key", "scroll"])
    }
}
