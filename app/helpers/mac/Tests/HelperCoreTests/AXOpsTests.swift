// ax.video_rect's walk over a scripted tree and clock: no app is asked.
@testable import HelperCore
import XCTest

final class AXOpsTests: XCTestCase {
    /// A window with `width` children, each with `width` leaves; the last leaf is the video.
    private func tree(_ width: Int) -> [Int: [Int]] {
        var children: [Int: [Int]] = [0: Array(1...width)]
        for k in 1...width { children[k] = Array((k * width + 1)...(k * width + width)) }
        return children
    }

    func testTheWalkFindsTheVideoBreadthFirst() {
        let children = tree(3)
        let found = AXOps.firstVideo(below: 0, read: { (subrole: $0 == 12 ? "AXVideo" : nil, children: children[$0] ?? []) },
                                     cancelled: { false }, deadline: .distantFuture)
        guard case .found(12) = found else { return XCTFail("\(found)") }
    }

    /// Every app answers within its 50 ms, but hundreds of answers would pass the op's 1 s.
    func testTheWalkStopsAtTheOpsDeadline() {
        let children = tree(19)
        var clock = Date(timeIntervalSince1970: 1000)
        let start = clock
        var asked = 0
        let found = AXOps.firstVideo(below: 0, read: { node -> (subrole: String?, children: [Int])? in
            asked += 1
            clock += 0.005
            return (node == 380 ? "AXVideo" : nil, children[node] ?? [])
        }, cancelled: { false }, deadline: start.addingTimeInterval(AXOps.videoSeconds), now: { clock })
        guard case .timedOut = found else { return XCTFail("\(found) after \(asked) reads") }
        XCTAssertLessThanOrEqual(clock.timeIntervalSince(start), AXOps.videoSeconds + 0.005)
    }
}
