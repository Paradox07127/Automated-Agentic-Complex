// permissions.request over fake system prompts: the replay never sends it, since a real request may show a system prompt.
@testable import HelperCore
import XCTest

final class PermissionsTests: XCTestCase {
    private static let states: [String: String] = ["accessibility": "granted", "screenRecording": "denied", "microphone": "granted",
                                                   "automation": "notDetermined", "inputMonitoring": "denied"]

    /// Prompts that record what was called; the microphone answers `micGranted`, the speech permission is `speechUndecided`.
    private func prompts(_ calls: Recorder, micGranted: Bool = true, speechUndecided: Bool = true) -> PermissionPrompts {
        PermissionPrompts(accessibility: { calls.add("accessibility") }, screenRecording: { calls.add("screenRecording") },
                          microphone: { calls.add("microphone"); return micGranted },
                          speechUndecided: { calls.add("speechUndecided"); return speechUndecided }, speech: { calls.add("speech") },
                          automation: { calls.add("automation") }, inputMonitoring: { calls.add("inputMonitoring") },
                          states: { calls.add("states"); return Self.states })
    }

    func testEachKindAsksItsOwnPromptThenReadsItsState() {
        for kind in ["accessibility", "screenRecording", "automation", "inputMonitoring", "microphone"] {
            let calls = Recorder()
            let answer = Permissions.request(["kind": kind], prompts(calls, speechUndecided: false))
            let asked = kind == "microphone" ? ["microphone", "speechUndecided"] : [kind]
            XCTAssertEqual(calls.names, asked + ["states"], kind)
            guard case .success(let result) = answer else { return XCTFail("\(kind): \(answer)") }
            XCTAssertEqual(result as? [String: String], ["state": Self.states[kind]!], kind)
        }
    }

    func testTheMicrophoneAsksForSpeechOnlyWhenGrantedAndSpeechUndecided() {
        for (granted, undecided, asked) in [(true, true, ["microphone", "speechUndecided", "speech"]),
                                            (true, false, ["microphone", "speechUndecided"]),
                                            (false, true, ["microphone"])] {
            let calls = Recorder()
            _ = Permissions.request(["kind": "microphone"], prompts(calls, micGranted: granted, speechUndecided: undecided))
            XCTAssertEqual(calls.names, asked + ["states"], "granted \(granted), undecided \(undecided)")
        }
    }
}

final class Recorder: @unchecked Sendable {
    private(set) var names: [String] = []
    func add(_ name: String) { names.append(name) }
}
