import ApplicationServices
import AppKit
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.farfold.desktop")
guard apps.count == 1, let app = apps.first,
      app.executableURL?.path == "/Applications/Farfold.app/Contents/MacOS/farfold" else {
    print("STOP unexpected formal app identity"); exit(2)
}
let application = AXUIElementCreateApplication(app.processIdentifier)
guard let menuBar = attribute(application, kAXMenuBarAttribute) as! AXUIElement?,
      let items = attribute(menuBar, kAXChildrenAttribute) as? [AXUIElement],
      let appMenu = items.first(where: { attribute($0, kAXTitleAttribute) as? String == "Farfold" }) else {
    print("STOP no Farfold application menu"); exit(3)
}
let open = AXUIElementPerformAction(appMenu, kAXPressAction as CFString)
guard open == .success else { print("STOP menu unavailable"); exit(4) }
let allowed = Set(["Quit Farfold", "退出 Farfold"])
var matches: [AXUIElement] = []
func visit(_ element: AXUIElement, _ depth: Int) {
    guard depth < 4 else { return }
    if let title = attribute(element, kAXTitleAttribute) as? String, allowed.contains(title) { matches.append(element) }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { visit(child, depth + 1) }
    }
}
visit(appMenu, 0)
guard matches.count == 1 else { print("STOP quit menu not unique"); exit(5) }
let result = AXUIElementPerformAction(matches[0], kAXPressAction as CFString)
print("normalQuitMenuRequested", result.rawValue)
exit(result == .success ? 0 : 6)
