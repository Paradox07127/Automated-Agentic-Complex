import ApplicationServices
import AVFoundation
import CoreGraphics
import IOKit.hid
import Speech
import UserNotifications

/// `permissions.status`, read without showing a system prompt, and
/// `permissions.request`, which does. The grants belong to the helper's responsible process, the app that started it.
enum Permissions {
    /// Off the main thread: AEDeterminePermissionToAutomateTarget can wait on the target app.
    static func status(_ params: [String: Any]) -> Outcome { .success(states()) }

    static func states() -> [String: String] {
        [
            "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
            "microphone": microphone(AVCaptureDevice.authorizationStatus(for: .audio)),
            "automation": automation(),
            "inputMonitoring": inputMonitoring(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)),
            "speech": speech(SFSpeechRecognizer.authorizationStatus(), askable: speechAskable()),
            "notifications": notifications(),
        ]
    }

    /// The app's notification grant: inside the app the helper's main bundle is the app's. Outside an app bundle the
    /// notification center raises, so there it is notApplicable.
    static func notifications() -> String {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return "notApplicable" }
        let done = DispatchSemaphore(value: 0)
        let reading = Reading()
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            reading.status = settings.authorizationStatus
            done.signal()
        }
        done.wait()
        return notifications(reading.status)
    }

    static func notifications(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional: "granted"
        case .denied: "denied"
        default: "notDetermined"
        }
    }

    /// notDetermined only where asking is possible, notApplicable where asking ends the process.
    static func speech(_ status: SFSpeechRecognizerAuthorizationStatus, askable: Bool) -> String {
        switch status {
        case .authorized: "granted"
        case .denied, .restricted: "denied"
        default: askable ? "notDetermined" : "notApplicable"
        }
    }

    /// A bundle without the usage description ends the process when it asks for speech recognition.
    static func speechAskable() -> Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
    }

    static func microphone(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: "granted"
        case .denied, .restricted: "denied"
        default: "notDetermined"
        }
    }

    /// Terminal is the session jump's target; macOS asks per target the first time.
    static func automation() -> String {
        switch Int(automationStatus(ask: false)) {
        case Int(noErr): return "granted"
        case Int(errAEEventNotPermitted): return "denied"
        default: return "notDetermined"  // errAEEventWouldRequireUserConsent, or Terminal not running (procNotFound)
        }
    }

    /// With `ask`, shows the Automation prompt for Terminal if it is running.
    static func automationStatus(ask: Bool) -> OSStatus {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.Terminal")
        return withExtendedLifetime(target) {
            AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
        }
    }

    static func inputMonitoring(_ access: IOHIDAccessType) -> String {
        switch access {
        case kIOHIDAccessTypeGranted: "granted"
        case kIOHIDAccessTypeDenied: "denied"
        default: "notDetermined"
        }
    }
}

/// The system calls of `permissions.request`, each showing its prompt where one is still
/// possible; tests pass their own.
struct PermissionPrompts {
    let accessibility: () -> Void
    let screenRecording: () -> Void
    /// Whether the microphone was granted.
    let microphone: () -> Bool
    let speechUndecided: () -> Bool
    let speech: () -> Void
    let automation: () -> Void
    let inputMonitoring: () -> Void
    let notifications: () -> Void
    let states: () -> [String: String]

    static let live = PermissionPrompts(
        accessibility: { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) },
        screenRecording: { _ = CGRequestScreenCaptureAccess() },
        microphone: {
            let done = DispatchSemaphore(value: 0)
            let granted = Flag()
            AVCaptureDevice.requestAccess(for: .audio) { answer in
                granted.value = answer
                done.signal()
            }
            done.wait()
            return granted.value
        },
        // False in a bundle without the usage description, where asking ends the process.
        speechUndecided: { Permissions.speechAskable() && SFSpeechRecognizer.authorizationStatus() == .notDetermined },
        speech: {
            let done = DispatchSemaphore(value: 0)
            SFSpeechRecognizer.requestAuthorization { _ in done.signal() }
            done.wait()
        },
        automation: { _ = Permissions.automationStatus(ask: true) },
        inputMonitoring: { _ = CGRequestListenEventAccess() },
        // Asking also lists the app in System Settings › Notifications. Outside an app bundle the center raises.
        notifications: {
            guard Bundle.main.bundleURL.pathExtension == "app" else { return }
            let done = DispatchSemaphore(value: 0)
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in done.signal() }
            done.wait()
        },
        states: Permissions.states)
}

private final class Flag: @unchecked Sendable {
    var value = false
}

private final class Reading: @unchecked Sendable {
    var status = UNAuthorizationStatus.notDetermined
}

extension Permissions {
    /// Off the main thread: the requests wait for the user's answer. `state` is read again after the request.
    static func request(_ params: [String: Any], _ prompts: PermissionPrompts) -> Outcome {
        let kind = params["kind"] as! String
        switch kind {
        case "screenRecording": prompts.screenRecording()
        case "accessibility": prompts.accessibility()
        case "microphone":
            if prompts.microphone(), prompts.speechUndecided() { prompts.speech() }
        case "automation": prompts.automation()
        case "notifications": prompts.notifications()
        default: prompts.inputMonitoring()
        }
        return .success(["state": prompts.states()[kind]!])
    }
}
