import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// `ptt.register` and `ptt.unregister`: a Carbon hot key
/// with its press and release, or `right_option`'s key state read every 50 ms.
enum PushToTalk {
    enum Combo: Equatable {
        /// `kVK_*` key code plus `cmdKey`/`optionKey`/`controlKey`/`shiftKey` bits.
        case carbon(keyCode: UInt32, modifiers: UInt32)
        /// The right Option key held on its own; Carbon can't register a modifier alone.
        case rightOption
    }

    /// `right_option`, or `control+option+space`-style names; nil when any part is unknown.
    static func parse(_ text: String) -> Combo? {
        if text.lowercased() == "right_option" { return .rightOption }
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let keyName = parts.last, let keyCode = keyCodes[keyName] else { return nil }
        var modifiers = 0
        for part in parts.dropLast() {
            switch part {
            case "command", "cmd": modifiers |= cmdKey
            case "option", "alt": modifiers |= optionKey
            case "control", "ctrl": modifiers |= controlKey
            case "shift": modifiers |= shiftKey
            default: return nil
            }
        }
        return .carbon(keyCode: UInt32(keyCode), modifiers: UInt32(modifiers))
    }

    private static let keyCodes: [String: Int] = {
        var codes = ["space": kVK_Space]
        let letters = [kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E, kVK_ANSI_F, kVK_ANSI_G,
                       kVK_ANSI_H, kVK_ANSI_I, kVK_ANSI_J, kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N,
                       kVK_ANSI_O, kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R, kVK_ANSI_S, kVK_ANSI_T, kVK_ANSI_U,
                       kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X, kVK_ANSI_Y, kVK_ANSI_Z]
        for (letter, code) in zip("abcdefghijklmnopqrstuvwxyz", letters) { codes[String(letter)] = code }
        let digits = [kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4,
                      kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]
        for (digit, code) in digits.enumerated() { codes[String(digit)] = code }
        let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6,
                            kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (i, code) in functionKeys.enumerated() { codes["f\(i + 1)"] = code }
        return codes
    }()

    /// The replay's switch for right_option's no-grant path on a Mac that has Input Monitoring.
    private static let deniedForTests = ProcessInfo.processInfo.environment["AC_HELPER_INPUT_DENIED"] != nil
    /// The replay's switch: right_option's poll reads a scripted hold in place of the keyboard, held for ticks 1–6 with a
    /// key typed at tick 3, so ptt.down, ptt.typed and ptt.up come without a key pressed and without the grant.
    private static let probe = ProcessInfo.processInfo.environment["AC_HELPER_PTT_PROBE"] != nil
    private static var ticks = 0
    private static let state = WatchState()
    private static var combo: Combo?
    private static var hotKey: EventHotKeyRef?
    private static var handler: EventHandlerRef?
    /// right_option's key state poll, or the Carbon event pump: without NSApplication nothing dispatches the hot key events.
    private static var timer: Timer?
    private static var down = false
    private static var started = 0
    /// When the held key went down, and whether ptt.typed went out for this hold.
    private static var pressedAt: TimeInterval = 0
    private static var typed = false

    /// Main thread. A new combo replaces the old one only once it is registered; the same combo again changes nothing.
    static func register(_ params: [String: Any]) -> Outcome {
        let name = params["combo"] as! String
        guard let wanted = parse(name) else { return .failure(code: "bad_hotkey", message: "the combo has a part Config.parseHotkey does not know") }
        if wanted == combo { return .success(["registered": true]) }
        var registered: EventHotKeyRef?
        switch wanted {
        case .rightOption:
            guard probe || (!deniedForTests && CGPreflightListenEventAccess()) else {
                return .failure(code: "permission_denied", message: "right_option needs the Input Monitoring grant")
            }
        case let .carbon(keyCode, modifiers):
            installHandler()
            // Exclusive, so that another app's exclusive registration of the combo shows as hotkey_taken.
            let status = RegisterEventHotKey(keyCode, modifiers, EventHotKeyID(signature: OSType(0x4546_5654), id: 1),
                                             GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &registered)
            guard status == noErr, registered != nil else {
                if hotKey == nil, let handler {
                    RemoveEventHandler(handler)
                    self.handler = nil
                }
                return status == OSStatus(eventHotKeyInvalidErr)
                    ? .failure(code: "bad_hotkey", message: "Carbon refused the combo (\(status))")
                    : .failure(code: "hotkey_taken", message: "another app holds \(name) (\(status))")
            }
        }
        stop(keepingHandler: registered != nil)
        ticks = 0
        combo = wanted
        hotKey = registered
        started = state.start()
        let pumped = Timer(timeInterval: 0.05, repeats: true) { _ in wanted == .rightOption ? poll() : pump() }
        pumped.tolerance = 0.0025
        RunLoop.main.add(pumped, forMode: .common)
        timer = pumped
        return .success(["registered": true])
    }

    /// Main thread.
    static func unregister(_ params: [String: Any]) -> Outcome {
        let had = combo != nil
        stop(keepingHandler: false)
        return .success(["unregistered": had])
    }

    /// No event of the old combo follows, not even the release of a held key.
    private static func stop(keepingHandler: Bool) {
        state.stop()
        timer?.invalidate()
        timer = nil
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = nil
        if !keepingHandler, let handler {
            RemoveEventHandler(handler)
            self.handler = nil
        }
        combo = nil
        down = false
    }

    private static func installHandler() {
        guard handler == nil else { return }
        var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                     EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            guard let event else { return OSStatus(eventNotHandledErr) }
            PushToTalk.changed(GetEventKind(event) == UInt32(kEventHotKeyPressed))
            return noErr
        }, types.count, &types, nil, &handler)
    }

    /// Dispatches the queued Carbon events, the hot key's among them, as NSApplication's event loop would.
    private static func pump() {
        var event: EventRef?
        while ReceiveNextEvent(0, nil, kEventDurationNoWait, true, &event) == noErr, let next = event {
            SendEventToEventTarget(next, GetEventDispatcherTarget())
            ReleaseEvent(next)
            event = nil
        }
    }

    private static func poll() {
        if probe { ticks += 1 }
        poll(pressed: probe ? (1...6).contains(ticks) : CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_RightOption)),
             sinceKey: { probe ? (ticks >= 3 ? 0 : .infinity)
                 : CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown) },
             now: ProcessInfo.processInfo.systemUptime)
    }

    /// One read of right_option: whether it is down, and the seconds since the last key went down.
    static func poll(pressed: Bool, sinceKey: () -> TimeInterval, now: TimeInterval) {
        // A key typed since the press means Option typing, not speaking. Read before the release
        // too, for a key typed since the previous poll.
        if down, !typed, sinceKey() < now - pressedAt {
            typed = true
            let generation = started
            Events.emit("ptt.typed", [:], live: { state.live(generation) })
        }
        changed(pressed, at: now)
    }

    /// One ptt.down per press and one ptt.up per release; a held key's repeats send nothing.
    private static func changed(_ pressed: Bool, at now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard pressed != down else { return }
        down = pressed
        if pressed {
            pressedAt = now
            typed = false
        }
        let generation = started
        Events.emit(pressed ? "ptt.down" : "ptt.up", [:], live: { state.live(generation) })
    }
}
