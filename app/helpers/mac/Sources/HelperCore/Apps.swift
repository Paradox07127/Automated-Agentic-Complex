import AppKit
import Darwin

/// `apps.running`, `apps.installed`, `apps.activate` and `process.usage`.
enum Apps {
    /// Main thread: NSWorkspace updates its list there.
    static func running(_ params: [String: Any]) -> Outcome {
        let regularOnly = flag(params, "regular_only")
        let apps: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { app in
            let regular = app.activationPolicy == .regular
            guard app.processIdentifier > 0, regular || !regularOnly else { return nil }
            return ["pid": Int(app.processIdentifier), "name": JSON.optional(app.localizedName),
                    "app_id": JSON.optional(app.bundleIdentifier),
                    "path": JSON.optional((app.bundleURL ?? app.executableURL)?.path),
                    "launched_at": JSON.optional(app.launchDate?.timeIntervalSince1970), "regular": regular]
        }
        return .success(["apps": apps])
    }

    /// The `.app` entries of these directories, in their listing order.
    static func installed(_ params: [String: Any]) -> Outcome {
        let dirs = ["/Applications", "/Applications/Utilities", "/System/Applications",
                    "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
        let fm = FileManager.default
        let apps: [[String: Any]] = dirs.flatMap { dir in
            ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".app") }.map { name in
                let path = dir + "/" + name
                return ["path": path, "name": fm.displayName(atPath: path)]
            }
        }
        return .success(["apps": apps])
    }

    /// Main thread. `activated` is what NSRunningApplication.activate answers: macOS may still keep another app in front.
    static func activate(_ params: [String: Any]) -> Outcome {
        var app: NSRunningApplication?
        if let pid = JSON.int(params["pid"]) {
            guard pid <= Int(Int32.max), alive(Int32(pid)) else { return .failure(code: "process_gone", message: "no process has that pid") }
            app = withInterface(Int32(pid))
            if app == nil && flag(params, "ancestors") { app = interfaceAncestor(of: Int32(pid)) }
        } else {
            let found = NSRunningApplication.runningApplications(withBundleIdentifier: params["app_id"] as! String)
            app = found.first { $0.activationPolicy == .regular } ?? found.first
        }
        guard let app else { return .success(["activated": false, "pid": NSNull()]) }
        return .success(["activated": app.activate(), "pid": Int(app.processIdentifier)])
    }

    /// A process that exists; one this helper may not signal still exists.
    static func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

    /// The app of `pid` when it has an interface: a Dock app or an agent app, not a background-only process.
    static func withInterface(_ pid: Int32) -> NSRunningApplication? {
        guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy != .prohibited else { return nil }
        return app
    }

    /// The nearest ancestor of `pid` with an interface.
    static func interfaceAncestor(of pid: Int32) -> NSRunningApplication? {
        var current = pid
        while let parent = parentPid(of: current), parent > 1 {
            if let app = withInterface(parent) { return app }
            current = parent
        }
        return nil
    }

    static func parentPid(of pid: Int32) -> Int32? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }
}

enum Processes {
    /// `proc_pid_rusage` times are Mach absolute time units, not nanoseconds, on Apple silicon.
    static let nanosPerTick: Double = {
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        return Double(timebase.numer) / Double(timebase.denom)
    }()

    /// Processes that are gone, or that this helper may not read, are left out.
    static func usage(_ params: [String: Any]) -> Outcome {
        var seen = Set<Int>()
        var usage: [[String: Any]] = []
        for value in params["pids"] as! [Any] {
            guard let pid = JSON.int(value), pid <= Int(Int32.max), seen.insert(pid).inserted else { continue }
            var info = rusage_info_v2()
            let status = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(Int32(pid), RUSAGE_INFO_V2, $0) }
            }
            guard status == 0 else { continue }
            let nanos = Double(info.ri_user_time + info.ri_system_time) * nanosPerTick
            usage.append(["pid": pid, "cpu_time_ns": Int(nanos.rounded()), "resident_bytes": Int(clamping: info.ri_resident_size)])
        }
        return .success(["usage": usage])
    }
}
