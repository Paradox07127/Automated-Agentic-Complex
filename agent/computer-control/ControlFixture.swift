import AppKit

/// Deliberately synthetic acceptance surface; never opens user files or accounts.
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let result = NSTextField(labelWithString: "未执行")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window=NSWindow(contentRect:CGRect(x:180,y:180,width:440,height:240),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
        window.title="Agentic Complex Computer Control · Synthetic Fixture"
        window.isReleasedWhenClosed=false
        let content=NSView(frame:window.contentView!.bounds)
        let heading=NSTextField(labelWithString:"仅用于控制桥验收 · 不含用户数据")
        heading.frame=CGRect(x:24,y:184,width:390,height:24)
        let input=NSTextField(frame:CGRect(x:24,y:132,width:390,height:30));input.placeholderString="输入合成测试文本"
        input.setAccessibilityIdentifier("fixture-input")
        let button=NSButton(title:"执行测试",target:self,action:#selector(runTest))
        button.frame=CGRect(x:24,y:76,width:140,height:34);button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("fixture-run")
        result.frame=CGRect(x:190,y:80,width:220,height:26);result.setAccessibilityIdentifier("fixture-result")
        [heading,input,button,result].forEach(content.addSubview)
        window.contentView=content;window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
    }
    @objc func runTest() { result.stringValue="桥已打通 · Verified" }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { true }
}
let app=NSApplication.shared
let delegate=FixtureDelegate()
app.delegate=delegate
app.setActivationPolicy(.regular)
app.run()
