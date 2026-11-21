// terminal.focus over a fake system: the replay never sends it, since a real script may show the Automation prompt and
// brings a terminal to the front.
import Foundation
@testable import HelperCore
import XCTest

final class TerminalTests: XCTestCase {
    func testStringsEscapeBackslashesThenQuotes() {
        XCTAssertEqual(Terminal.appleScriptString(#"a\"b\c"#), #""a\\\"b\\c""#)
        XCTAssertEqual(Terminal.appleScriptString(""), #""""#)
    }

    func testTheTerminalScript() {
        XCTAssertEqual(Terminal.terminalScript(tty: #"/dev/tty"a\b"#), #"""
            set targetTTY to "/dev/tty\"a\\b"
            if application id "com.apple.Terminal" is not running then return "not-running"
            tell application id "com.apple.Terminal"
              repeat with w in windows
                repeat with t in tabs of w
                  if (tty of t) is targetTTY then
                    if miniaturized of w then set miniaturized of w to false
                    set selected tab of w to t
                    set index of w to 1
                    activate
                    return "ok"
                  end if
                end repeat
              end repeat
            end tell
            return "not-found"
            """#)
    }

    func testTheITermScript() {
        XCTAssertEqual(Terminal.iTermScript(tty: #"/dev/tty"a\b"#), #"""
            set targetTTY to "/dev/tty\"a\\b"
            if application id "com.googlecode.iterm2" is not running then return "not-running"
            tell application id "com.googlecode.iterm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if (tty of s) is targetTTY then
                      select w
                      select t
                      select s
                      activate
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            return "not-found"
            """#)
    }

    func testTheGhosttyScript() {
        XCTAssertEqual(Terminal.ghosttyScript(cwd: #"/Users/me/"x"\y"#), #"""
            set targetCwd to "/Users/me/\"x\"\\y"
            if application id "com.mitchellh.ghostty" is not running then return "not-running"
            tell application id "com.mitchellh.ghostty"
              set found to every terminal whose working directory is targetCwd
              if (count of found) is 0 then return "not-found"
              focus (item 1 of found)
              activate
            end tell
            return "ok"
            """#)
    }

    /// A system where every app runs and every script answers `output` or fails with `error`.
    private func system(_ asked: Recorder, running: Bool = true, output: String? = "ok",
                        error: NSDictionary? = nil) -> Terminal.System {
        Terminal.System(running: { asked.add("running \($0)"); return running },
                        run: { asked.add($0); return (output, error) })
    }

    func testEachAppRunsItsScriptOnItsTtyOrCwd() {
        for (params, bundle, script) in [
                (["app": "terminal", "tty": "/dev/ttys004"], "com.apple.Terminal", Terminal.terminalScript(tty: "/dev/ttys004")),
                (["app": "iterm", "tty": "/dev/ttys005"], "com.googlecode.iterm2", Terminal.iTermScript(tty: "/dev/ttys005")),
                (["app": "ghostty", "cwd": "/tmp/p"], "com.mitchellh.ghostty", Terminal.ghosttyScript(cwd: "/tmp/p"))] {
            let asked = Recorder()
            let answer = Terminal.focus(params, system(asked))
            XCTAssertEqual(asked.names, ["running \(bundle)", script])
            guard case .success(let result) = answer else { return XCTFail("\(params): \(answer)") }
            XCTAssertEqual(result as? [String: Bool], ["focused": true])
        }
    }

    func testAnAppNotRunningGetsNoScript() {
        let asked = Recorder()
        let answer = Terminal.focus(["app": "ghostty", "cwd": "/tmp/p"], system(asked, running: false))
        XCTAssertEqual(asked.names, ["running com.mitchellh.ghostty"])
        XCTAssertEqual(code(answer), "not_found")
    }

    func testScriptErrorsAndOutputsMapToCodes() {
        for (output, error, want) in [
                ("ok", nil, nil), ("not-found", nil, "not_found"), ("not-running", nil, "not_found"), (nil, nil, "not_found"),
                (nil, [NSAppleScript.errorNumber: -1743] as NSDictionary, "automation_denied"),
                (nil, [NSAppleScript.errorNumber: -600] as NSDictionary, "not_found"),
                (nil, [NSAppleScript.errorNumber: -2741] as NSDictionary, "script_failed"),
                (nil, [NSAppleScript.errorMessage: "x"] as NSDictionary, "script_failed")] as [(String?, NSDictionary?, String?)] {
            let answer = Terminal.focus(["app": "terminal", "tty": "/dev/ttys004"], system(Recorder(), output: output, error: error))
            XCTAssertEqual(code(answer), want, "\(output ?? "nil") \(error ?? [:])")
        }
    }

    /// The main run loop keeps serving the input tap and the hotkey poll while a script waits. The scripts here send no
    /// Apple event to another app.
    func testAScriptLeavesTheMainThreadFree() {
        let ran = expectation(description: "script")
        let answers = Recorder()
        DispatchQueue.global().async {
            answers.add(AppleScript.run("delay 0.5\nreturn \"done\"").output ?? "nil")
            answers.add(AppleScript.run("return {\"https://example.com/\", \"normal\"}").output ?? "nil")
            let (output, error) = AppleScript.run("error \"no\" number -1743")
            answers.add("\(output == nil) \(error?[NSAppleScript.errorNumber] as? Int ?? 0)")
            ran.fulfill()
        }
        let free = expectation(description: "main")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { free.fulfill() }
        wait(for: [free], timeout: 0.3)
        wait(for: [ran], timeout: 5)
        XCTAssertEqual(answers.names, ["done", "https://example.com/, normal", "true -1743"])
    }

    private func code(_ outcome: Outcome) -> String? {
        if case .failure(let code, _, _) = outcome { return code }
        return nil
    }
}
