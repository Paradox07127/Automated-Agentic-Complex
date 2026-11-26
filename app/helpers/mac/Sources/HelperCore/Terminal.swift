import AppKit

/// `terminal.focus`: one AppleScript per terminal app.
enum Terminal {
    /// The system calls, replaceable in tests: whether an app with the bundle id runs, and an AppleScript's string
    /// output or its error dictionary.
    struct System {
        let running: (String) -> Bool
        let run: (String) -> (output: String?, error: NSDictionary?)

        static let live = System(
            running: { !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty },
            run: AppleScript.run)
    }

    private static let apps: [String: (name: String, bundleId: String, script: (String) -> String)] = [
        "terminal": ("Terminal", "com.apple.Terminal", { terminalScript(tty: $0) }),
        "iterm": ("iTerm", "com.googlecode.iterm2", { iTermScript(tty: $0) }),
        "ghostty": ("Ghostty", "com.mitchellh.ghostty", { ghosttyScript(cwd: $0) }),
    ]

    /// Any thread; on the main one the script's wait for the terminal stops the input tap and the hotkey poll.
    static func focus(_ params: [String: Any], _ system: System) -> Outcome {
        let app = apps[params["app"] as! String]!
        let target = (params["tty"] ?? params["cwd"]) as! String
        // An Apple event to an app that is not running would launch it.
        guard system.running(app.bundleId) else { return .failure(code: "not_found", message: "\(app.name) is not running") }
        let (output, error) = system.run(app.script(target))
        if let error {
            switch error[NSAppleScript.errorNumber] as? Int {
            case -1743: return .failure(code: "automation_denied", message: "Automation for \(app.name) is not allowed")
            case -600: return .failure(code: "not_found", message: "\(app.name) is not running")
            case let number: return .failure(code: "script_failed", message: "AppleScript error \(number.map(String.init) ?? "unknown")")
            }
        }
        switch output {
        case "ok": return .success(["focused": true])
        case "not-running": return .failure(code: "not_found", message: "\(app.name) is not running")
        default: return .failure(code: "not_found", message: "\(app.name) has no such session")
        }
    }

    static func appleScriptString(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Returns "ok", "not-found" or "not-running".
    static func terminalScript(tty: String) -> String {
        """
        set targetTTY to \(appleScriptString(tty))
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
        """
    }

    /// Returns "ok", "not-found" or "not-running". Selecting a session alone does not change the tab or window.
    static func iTermScript(tty: String) -> String {
        """
        set targetTTY to \(appleScriptString(tty))
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
        """
    }

    /// Returns "ok", "not-found" or "not-running". Ghostty terminals expose no tty, so the first one in `cwd` wins.
    static func ghosttyScript(cwd: String) -> String {
        """
        set targetCwd to \(appleScriptString(cwd))
        if application id "com.mitchellh.ghostty" is not running then return "not-running"
        tell application id "com.mitchellh.ghostty"
          set found to every terminal whose working directory is targetCwd
          if (count of found) is 0 then return "not-found"
          focus (item 1 of found)
          activate
        end tell
        return "ok"
        """
    }
}

/// The scripts of terminal.focus and browser.front_tab, each in an osascript process of its own, waited for on the
/// calling thread: NSAppleScript belongs to the main thread, whose run loop serves the input tap and the hotkey poll.
enum AppleScript {
    /// The result as osascript prints it (a list's items joined by ", "), or nil and an error dictionary with
    /// `NSAppleScript.errorNumber` when the script failed.
    static func run(_ source: String) -> (output: String?, error: NSDictionary?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]
        let output = Pipe(), errors = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        do { try process.run() } catch { return (nil, [NSAppleScript.errorMessage: "osascript did not start: \(error)"]) }
        let printed = output.fileHandleForReading.readDataToEndOfFile()
        let failed = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            // "0:12: execution error: Not authorized to send Apple events to Terminal. (-1743)"
            let number = failed.firstMatch(of: #/\((-?\d+)\)\s*$/#).flatMap { Int($0.1) }
            return (nil, [NSAppleScript.errorNumber: number.map { $0 as Any } ?? NSNull()])
        }
        var text = String(decoding: printed, as: UTF8.self)
        if text.hasSuffix("\n") { text.removeLast() }
        return (text, nil)
    }
}
