import AppKit

// The replay's own window for the control ops and ax.watch: a small panel that never takes focus, with a text field and
// a button that writes "pressed" into it. Its app tells AX that the field has the focus and the panel is the focused
// window, without taking the keyboard. Prints "<pid> <window number>" once it is on screen; stdin lines: "move" moves it
// 40 points and prints "moved"; "title <text>" retitles the panel, "value <text>" sets the field and "other" posts a
// value change of the button, each printing "done"; stdin closing ends it.
final class Presser: NSObject {
    let field: NSTextField

    init(_ field: NSTextField) { self.field = field }

    @objc func press(_ sender: Any?) { field.stringValue = "pressed" }
}

let app = NSApplication.shared
// Not .accessory: launched from the front app's process tree, an agent app with a window on screen becomes the front app.
app.setActivationPolicy(.prohibited)
let corner = NSScreen.main.map { $0.visibleFrame.origin } ?? .zero
let panel = NSPanel(contentRect: NSRect(x: corner.x + 20, y: corner.y + 20, width: 220, height: 90),
                    styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
panel.title = "c12 replay"
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
let field = NSTextField(frame: NSRect(x: 10, y: 50, width: 200, height: 24))
field.stringValue = "c12 replay"
let presser = Presser(field)
let button = NSButton(title: "Press", target: presser, action: #selector(Presser.press(_:)))
button.frame = NSRect(x: 10, y: 10, width: 100, height: 30)
panel.contentView?.addSubview(field)
panel.contentView?.addSubview(button)
panel.orderFrontRegardless()
app.setAccessibilityApplicationFocusedUIElement(field.cell)
app.setAccessibilityFocusedWindow(panel)

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

DispatchQueue.main.async { say("\(getpid()) \(panel.windowNumber)") }
Thread {
    while let line = readLine() {
        let (command, text) = line.firstIndex(of: " ").map { (String(line[..<$0]), String(line[line.index(after: $0)...])) } ?? (line, "")
        DispatchQueue.main.async {
            switch command {
            case "move":
                panel.setFrameOrigin(NSPoint(x: panel.frame.minX + 40, y: panel.frame.minY))
                say("moved")
            case "title":
                panel.title = text
                NSAccessibility.post(element: panel, notification: .titleChanged)
                say("done")
            case "value":
                field.stringValue = text
                NSAccessibility.post(element: field.cell!, notification: .valueChanged)
                say("done")
            case "other":
                NSAccessibility.post(element: button.cell!, notification: .valueChanged)
                say("done")
            default:
                break
            }
        }
    }
    exit(0)
}.start()
app.run()
