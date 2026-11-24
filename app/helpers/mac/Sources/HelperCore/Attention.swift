import AppKit
import ApplicationServices
import Carbon
import CoreAudio
import CoreMediaIO
import IOKit
import IOKit.pwr_mgt

/// CONTRACT §7.3 `attention.sample`: the raw readings; whatever cannot be
/// read is null. The device reads need no camera or microphone grant, so none can prompt.
enum Attention {
    private static let videoTypes: Set<String> = ["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"]
    private static let captureIndicator = "com.apple.menuextra.audiovideo"
    private static let menuBarAgent = "com.apple.MenuBarAgent"
    private static let lock = NSLock()
    private static var categories: [String: String?] = [:]
    private static var gpuBase: (pid: pid_t, gpuNs: UInt64, wallNs: UInt64)?
    private static var gpuLast: Double?

    static func sample(_ params: [String: Any]) -> Outcome {
        let titles = flag(params, "include_titles")
        let windows = Windows.onScreen().filter { $0.layer == 0 }
        let ids = Windows.BundleIds()
        let frontApp = DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication }
        var front: [String: Any]?
        if let app = frontApp {
            let pid = app.processIdentifier
            let window = windows.first { $0.pid == pid }
            front = self.front(pid: pid, name: app.localizedName, appId: app.bundleIdentifier,
                               window: window.map { Windows.json($0, titles: titles, ids: ids) } ?? NSNull(), category: category(app),
                               focusedWindowTitle: titles ? .some(AX.trusted ? AXOps.focusedWindow(pid)?.title : nil) : nil)
        }
        let mouse = CGEvent(source: nil)?.location
        let under = mouse.flatMap { p in windows.first { $0.bounds.contains(p) } }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let focus = focusRoles()
        var result: [String: Any] = [
            "ts": Date().timeIntervalSince1970, "front": front ?? NSNull(),
            "mouse_window": under.map { Windows.json($0, titles: titles, ids: ids) } ?? NSNull(),
            "idle_s": CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!),
            "locked": session?["CGSSessionScreenIsLocked"] as? Bool ?? false, "secure_input": IsSecureEventInputEnabled(),
            "focus_role": JSON.optional(focus.role), "focus_native_role": JSON.optional(focus.role),
            "focus_window_role": JSON.optional(focus.windowRole), "focus_window_native_role": JSON.optional(focus.windowRole),
            "focus_window_subrole": JSON.optional(focus.windowSubrole),
            "camera_active": JSON.optional(Devices.cameraActive()), "mic_active": JSON.optional(Devices.micActive()),
            "audio_clients": NSNull(), "input_counters": NSNull(), "input_idles": NSNull(),
            "video_pids": JSON.optional(videoPids()?.sorted().map(Int.init)),
            "front_gpu_busy": JSON.optional(frontApp.flatMap { gpuBusy(pid: $0.processIdentifier) }),
            "capture_indicator": JSON.optional(captureIndicatorShown()),
        ]
        if flag(params, "include_audio") { result["audio_clients"] = JSON.optional(Devices.audioClients()) }
        if flag(params, "include_input") {
            func count(_ type: CGEventType) -> Int { Int(CGEventSource.counterForEventType(.combinedSessionState, eventType: type)) }
            func idle(_ type: CGEventType) -> Double { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type) }
            // Event counts only; the counter API never sees which key was pressed.
            result["input_counters"] = ["keys": count(.keyDown), "left_clicks": count(.leftMouseDown), "right_clicks": count(.rightMouseDown),
                                        "scrolls": count(.scrollWheel), "moves": count(.mouseMoved)]
            result["input_idles"] = ["key": idle(.keyDown), "pointer": idle(.mouseMoved), "scroll": idle(.scrollWheel),
                                     "click": min(idle(.leftMouseDown), idle(.rightMouseDown))]
        }
        return .success(result)
    }

    /// A `front`; `focused_window_title` only when titles were asked (`focusedWindowTitle` not nil).
    static func front(pid: Int32, name: String?, appId: String?, window: Any, category: String?,
                      focusedWindowTitle: String??) -> [String: Any] {
        var front: [String: Any] = ["pid": Int(pid), "name": JSON.optional(name), "app_id": JSON.optional(appId), "window": window,
                                    "category": JSON.optional(category)]
        if let focusedWindowTitle { front["focused_window_title"] = JSON.optional(focusedWindowTitle) }
        return front
    }

    /// LSApplicationCategoryType, read once per bundle id.
    private static func category(_ app: NSRunningApplication) -> String? {
        guard let id = app.bundleIdentifier else { return nil }
        if let known = lock.withLock({ categories[id] }) { return known }
        let found = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["LSApplicationCategoryType"] as? String }
        lock.withLock { categories[id] = .some(found) }
        return found
    }

    /// The focused element's role, and its window's or sheet's: its AXWindow, else the first window or sheet up the
    /// AXParent chain. Nil without the grant.
    private static func focusRoles() -> (role: String?, windowRole: String?, windowSubrole: String?) {
        guard AX.trusted else { return (nil, nil, nil) }
        let reader = AXReader(pid: 0, limit: AX.text)
        guard let focused = reader.element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) else { return (nil, nil, nil) }
        let role = reader.string(focused, kAXRoleAttribute)
        if let window = reader.element(focused, kAXWindowAttribute) {
            let d = reader.describe(window)
            return (role, d.role, d.subrole)
        }
        var ancestors: [(role: String?, subrole: String?)] = []
        var current = focused
        for _ in 0..<16 {
            guard let parent = reader.element(current, kAXParentAttribute) else { break }
            let d = reader.describe(parent)
            ancestors.append((d.role, d.subrole))
            if AXRules.focusWindow(ancestors: [(d.role, d.subrole)]) != nil { break }
            current = parent
        }
        guard let k = AXRules.focusWindow(ancestors: ancestors) else { return (role, nil, nil) }
        return (role, ancestors[k].role, ancestors[k].subrole)
    }

    /// Apps holding a display-sleep assertion; one held for another process counts for that process's app.
    private static func videoPids() -> Set<pid_t>? {
        var byPid: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsByProcess(&byPid) == kIOReturnSuccess, let all = byPid?.takeRetainedValue() as NSDictionary? else { return nil }
        var pids: Set<pid_t> = []
        for case let (owner as NSNumber, assertions as [[String: Any]]) in all {
            for a in assertions {
                let types = [a[kIOPMAssertionTypeKey as String] as? String, a["AssertionTrueType"] as? String].compactMap { $0 }
                // Display types only: WebKit names audio-only and hidden playback the same, with a System type.
                guard types.contains(where: videoTypes.contains) else { continue }
                if let app = appPid((a["AssertionOnBehalfOfPID"] as? NSNumber)?.int32Value ?? owner.int32Value) { pids.insert(app) }
            }
        }
        return pids
    }

    /// The pid itself or its nearest ancestor that is a regular (Dock) app.
    private static func appPid(_ pid: pid_t) -> pid_t? {
        var p = pid
        while p > 1 {
            if NSRunningApplication(processIdentifier: p)?.activationPolicy == .regular { return p }
            var info = kinfo_proc()
            var size = MemoryLayout<kinfo_proc>.stride
            var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, p]
            guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_eproc.e_ppid != p else { return nil }
            p = info.kp_eproc.e_ppid
        }
        return nil
    }

    /// The pid's share of GPU time since the previous read, 0...1; nil on the first read for a pid. A read less than
    /// 1 s after the previous one answers the previous share.
    private static func gpuBusy(pid: pid_t) -> Double? {
        let wall = DispatchTime.now().uptimeNanoseconds
        if let answer = lock.withLock({ () -> Double?? in
            if let base = gpuBase, base.pid == pid, wall - base.wallNs < 1_000_000_000 { return .some(gpuLast) }
            return nil
        }) { return answer }
        guard let gpu = gpuTimeNs(pid) else { return nil }
        return lock.withLock {
            if let base = gpuBase, base.pid == pid, wall > base.wallNs {
                gpuLast = min(1, Double(gpu &- base.gpuNs) / Double(wall - base.wallNs))
            } else {
                gpuLast = nil
            }
            gpuBase = (pid, gpu, wall)
            return gpuLast
        }
    }

    /// Sum of accumulatedGPUTime (ns) over the pid's AGX user clients; 0 without one, nil when the registry can't be read.
    private static func gpuTimeNs(_ pid: pid_t) -> UInt64? {
        var accelerators: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &accelerators) == KERN_SUCCESS else { return nil }
        let creator = "pid \(pid),"
        var total: UInt64 = 0
        // User clients aren't registered services, so they are only reached as the accelerator's children.
        forEach(accelerators) { accelerator in
            var clients: io_iterator_t = 0
            guard IORegistryEntryGetChildIterator(accelerator, kIOServicePlane, &clients) == KERN_SUCCESS else { return }
            forEach(clients) { client in
                guard IOObjectConformsTo(client, "AGXDeviceUserClient") != 0,
                      (IORegistryEntryCreateCFProperty(client, "IOUserClientCreator" as CFString, kCFAllocatorDefault, 0)?
                        .takeRetainedValue() as? String)?.hasPrefix(creator) == true,
                      let usage = IORegistryEntryCreateCFProperty(client, "AppUsage" as CFString, kCFAllocatorDefault, 0)?
                        .takeRetainedValue() as? [[String: Any]] else { return }
                for u in usage { total &+= (u["accumulatedGPUTime"] as? NSNumber)?.uint64Value ?? 0 }
            }
        }
        return total
    }

    private static func forEach(_ iterator: io_iterator_t, _ body: (io_registry_entry_t) -> Void) {
        defer { IOObjectRelease(iterator) }
        var entry = IOIteratorNext(iterator)
        while entry != 0 {
            body(entry)
            IOObjectRelease(entry)
            entry = IOIteratorNext(iterator)
        }
    }

    /// The indicator among MenuBarAgent's own items: window > group > hosting view > item. Nil without the grant.
    private static func captureIndicatorShown() -> Bool? {
        guard AX.trusted, let agent = NSRunningApplication.runningApplications(withBundleIdentifier: menuBarAgent).first else { return nil }
        let pid = agent.processIdentifier
        guard !AX.skipped(pid) else { return nil }
        let reader = AXReader(pid: pid, limit: AX.probe)
        var level = reader.elements(reader.app(), kAXWindowsAttribute)
        for depth in 0..<4 {
            var next: [AXUIElement] = []
            for element in level {
                if depth == 3 {
                    if reader.string(element, kAXIdentifierAttribute) == captureIndicator { return true }
                    continue
                }
                // Other apps' status items sit under MenuBarAgent's groups as their own AXApplication.
                next += reader.elements(element, kAXChildrenAttribute).filter { var owner: pid_t = 0; return AXUIElementGetPid($0, &owner) == .success && owner == pid }
            }
            if reader.timedOut { return nil }
            level = next
        }
        return false
    }
}

/// Camera, microphone and audio-client reads from the HAL without opening any device.
enum Devices {
    /// Unknown unless some device is known active or all are known idle.
    static func anyActive(_ states: [Bool?]) -> Bool? {
        if states.contains(true) { return true }
        return states.contains(nil) ? nil : false
    }

    /// A device that also has output may only be playing, so its "running" counts as unknown.
    static func micActive(_ inputs: [(hasOutput: Bool, running: Bool?)]) -> Bool? {
        anyActive(inputs.map { $0.hasOutput && $0.running == true ? nil : $0.running })
    }

    static func cameraActive() -> Bool? {
        let system = CMIOObjectID(kCMIOObjectSystemObject)
        var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
                                                mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                                mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var size: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
        var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
        guard CMIOObjectGetPropertyData(system, &address, 0, nil, size, &size, &ids) == noErr else { return nil }
        address.mSelector = CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere)
        return anyActive(ids.map { id in
            var running: UInt32 = 0, used: UInt32 = 0
            guard CMIOObjectGetPropertyData(id, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &used, &running) == noErr else { return nil }
            return running != 0
        })
    }

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var a = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func objects(_ selector: AudioObjectPropertySelector) -> [AudioObjectID]? {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var a = address(selector)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &ids) == noErr else { return nil }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    private static func hasStreams(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Bool {
        var a = address(kAudioDevicePropertyStreams, scope)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr && size > 0
    }

    /// Unknown while the helper records, since its own input would count.
    static func micActive() -> Bool? {
        if #available(macOS 26, *), Mic.active { return nil }
        guard let ids = objects(kAudioHardwarePropertyDevices) else { return nil }
        return micActive(ids.compactMap { id -> (hasOutput: Bool, running: Bool?)? in
            guard hasStreams(id, kAudioObjectPropertyScopeInput) else { return nil }
            return (hasStreams(id, kAudioObjectPropertyScopeOutput), uint32(id, kAudioDevicePropertyDeviceIsRunningSomewhere).map { $0 != 0 })
        })
    }

    /// The HAL's process objects: processes with audio I/O open. Nil when one's pid or input state can't be read.
    static func audioClients() -> [[String: Any]]? {
        guard let ids = objects(kAudioHardwarePropertyProcessObjectList) else { return nil }
        var clients: [[String: Any]] = []
        for id in ids {
            guard let raw = uint32(id, kAudioProcessPropertyPID), let input = uint32(id, kAudioProcessPropertyIsRunningInput) else { return nil }
            let pid = Int32(bitPattern: raw)
            guard pid > 0 else { continue }
            let app = NSRunningApplication(processIdentifier: pid)
            clients.append(["pid": Int(pid), "app_id": JSON.optional(bundleId(id) ?? app?.bundleIdentifier),
                            "name": JSON.optional(app?.localizedName), "running_input": input != 0,
                            "running_output": JSON.optional(uint32(id, kAudioProcessPropertyIsRunningOutput).map { $0 != 0 })])
        }
        return clients
    }

    private static func bundleId(_ id: AudioObjectID) -> String? {
        var a = address(kAudioProcessPropertyBundleID)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr,
              let bundle = value?.takeRetainedValue() as String?, !bundle.isEmpty else { return nil }
        return bundle
    }
}

/// CONTRACT §7.3 `input.modifiers`.
enum Modifiers {
    static func read(_ params: [String: Any]) -> Outcome { .success(json(CGEventSource.flagsState(.combinedSessionState))) }

    static func json(_ flags: CGEventFlags) -> [String: Any] {
        ["alt": flags.contains(.maskAlternate), "shift": flags.contains(.maskShift), "control": flags.contains(.maskControl),
         "meta": flags.contains(.maskCommand)]
    }
}

/// CONTRACT §7.3 `browser.front_tab`: an AppleScript, sent only when Automation is
/// already granted, so it never prompts.
enum Browser {
    static let safari = "com.apple.Safari"
    static let chrome = "com.google.Chrome"
    // A hung browser must not hold the request past 1 s.
    private static let safariSource = "with timeout of 1 second\ntell application id \"\(safari)\" to get URL of front document\nend timeout"
    private static let chromeSource = """
        with timeout of 1 second
            tell application id "\(chrome)"
                set windowMode to mode of front window
                if windowMode is not "normal" then return {"", windowMode}
                return {URL of active tab of front window, windowMode}
            end tell
        end timeout
        """

    /// Off the main thread: AEDeterminePermissionToAutomateTarget can wait on the browser.
    static func frontTab(_ params: [String: Any]) -> Outcome {
        let appId = params["app_id"] as! String
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: appId).isEmpty else {
            return .failure(code: "process_gone", message: "no running app has that app id")
        }
        guard appId == safari || appId == chrome else { return .success(["url_host": NSNull(), "incognito": NSNull()]) }
        let target = NSAppleEventDescriptor(bundleIdentifier: appId)
        let status = withExtendedLifetime(target) {
            AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
        }
        if Int(status) == Int(procNotFound) { return .failure(code: "process_gone", message: "the app quit") }
        guard status == noErr else { return .failure(code: "automation_denied", message: "Automation of that app is not allowed") }
        let tab = tab(appId: appId, output: AppleScript.run(appId == safari ? safariSource : chromeSource).output)
        return .success(["url_host": JSON.optional(tab.host), "incognito": JSON.optional(tab.incognito)])
    }

    /// The script's output: Safari's URL, or Chrome's URL and window mode as osascript prints the list, "url, mode".
    static func tab(appId: String, output: String?) -> (host: String?, incognito: Bool?) {
        guard appId == chrome else { return tab(appId: appId, url: output, mode: nil) }
        guard let output, let comma = output.range(of: ", ", options: .backwards) else { return tab(appId: appId, url: nil, mode: nil) }
        return tab(appId: appId, url: String(output[..<comma.lowerBound]), mode: String(output[comma.upperBound...]))
    }

    /// Safari's dictionary has no private-window property; Chrome's mode is "normal" or "incognito".
    static func tab(appId: String, url: String?, mode: String?) -> (host: String?, incognito: Bool?) {
        let host = url.flatMap { URLComponents(string: $0)?.host }.flatMap { $0.isEmpty ? nil : $0 }
        if appId == safari { return (host, nil) }
        switch mode {
        case "incognito": return (nil, true)
        case "normal": return (host, false)
        default: return (nil, nil)
        }
    }
}
