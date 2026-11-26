import AppKit
import CoreGraphics

/// `screens.list`, in CG global points.
enum Screens {
    /// Main thread: NSScreen belongs to it.
    static func list(_ params: [String: Any]) -> Outcome {
        let screens = NSScreen.screens
        // AppKit's screens have a bottom-left origin on the primary screen, which is first and holds the menu bar.
        let mainHeight = screens.first?.frame.height ?? 0
        func flipped(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height) }
        let list: [[String: Any]] = screens.compactMap { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            let id = number.uint32Value
            return ["display_id": Int(id), "frame": rectJSON(flipped(screen.frame)), "visible": rectJSON(flipped(screen.visibleFrame)),
                    "scale": Double(screen.backingScaleFactor), "primary": CGDisplayIsMain(id) != 0]
        }
        return .success(["screens": list])
    }
}

/// `windows.list` and `windows.at_point` over CGWindowList, front to back.
enum Windows {
    struct Window {
        let id: Int
        let pid: Int32
        let bounds: CGRect
        let layer: Int
        let alpha: Double
        let title: String?
        let owner: String?
    }

    /// On-screen windows without the desktop's own; titles need the screen-recording grant and are nil without it, and
    /// are not read unless `titles`.
    static func onScreen(titles: Bool = true) -> [Window] {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.compactMap { window($0, titles: titles) }
    }

    static func window(_ w: [String: Any], titles: Bool) -> Window? {
        guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.intValue, id > 0,
              let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0,
              let dict = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dict) else { return nil }
        return Window(id: id, pid: pid, bounds: bounds, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                      alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                      title: titles ? w[kCGWindowName as String] as? String : nil,
                      owner: titles ? w[kCGWindowOwnerName as String] as? String : nil)
    }

    /// Bundle ids by pid, each looked up once per op.
    final class BundleIds {
        private var ids: [Int32: String?] = [:]

        func of(_ pid: Int32) -> String? {
            if let known = ids[pid] { return known }
            let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
            ids[pid] = id
            return id
        }
    }

    static func json(_ w: Window, titles: Bool, ids: BundleIds) -> [String: Any] {
        var v: [String: Any] = ["window_id": w.id, "pid": Int(w.pid), "bounds": rectJSON(w.bounds), "layer": w.layer, "alpha": w.alpha]
        if titles {
            v["title"] = JSON.optional(w.title)
            v["app_name"] = JSON.optional(w.owner)
            v["app_id"] = JSON.optional(ids.of(w.pid))
        }
        return v
    }

    static func list(_ params: [String: Any]) -> Outcome {
        let pid = JSON.int(params["pid"]), limit = JSON.int(params["limit"])
        let layer0 = flag(params, "layer0_only"), titles = flag(params, "include_titles")
        let ids = BundleIds()
        var windows: [[String: Any]] = []
        for w in onScreen(titles: titles) {
            if let limit, windows.count >= limit { break }
            if let pid, Int(w.pid) != pid { continue }
            if layer0 && w.layer != 0 { continue }
            windows.append(json(w, titles: titles, ids: ids))
        }
        return .success(["windows": windows])
    }

    /// The front-most visible window under `point` (CG global points); fully transparent windows are not under it.
    static func atPoint(_ params: [String: Any]) -> Outcome {
        let point = params["point"] as! [String: Any]
        let p = CGPoint(x: JSON.number(point["x"])!, y: JSON.number(point["y"])!)
        let excluded = Set(((params["exclude_pids"] as? [Any]) ?? []).compactMap { JSON.int($0) })
        let layer0 = flag(params, "layer0_only"), titles = flag(params, "include_titles")
        let found = onScreen(titles: titles).first { w in
            !excluded.contains(Int(w.pid)) && w.alpha > 0 && (!layer0 || w.layer == 0) && w.bounds.contains(p)
        }
        return .success(["window": found.map { json($0, titles: titles, ids: BundleIds()) } ?? NSNull()])
    }
}
