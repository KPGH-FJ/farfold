import ApplicationServices
import AppKit
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
let processes = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.farfold.desktop")
guard processes.count == 1, let process = processes.first,
      process.executableURL?.path == "/Applications/Farfold.app/Contents/MacOS/farfold" else {
    print("STOP unexpected application identity"); exit(2)
}
let app = AXUIElementCreateApplication(process.processIdentifier)
let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "controls"
let requested = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let allowed = Set([
    "读取模型选项", "沿用当前设置", "已读取当前模型选项", "探索 Agent", "管理已添加的 Agent", "我的 Agent", "重新发现", "搜索 Agent", "清除搜索",
    "查看详情 · Pi", "查看详情 · Codex", "管理 Agent · Pi", "管理 Agent · Codex", "关闭准备",
    "程序", "账号与服务", "模型", "继续设置账号与服务", "继续选择模型", "返回程序",
    "返回账号与服务", "暂时返回", "保留当前程序", "已有设置", "管理接入", "更换接入方式",
    "重新检查程序连接", "检查连接", "重新检查连接", "关闭", "登录 ChatGPT", "ChatGPT",
    "ChatGPT 账号", "API Key", "OpenAI API Key", "模型 API 服务", "选择 API 服务",
    "终端设置", "模型服务", "启动设置终端", "继续终端设置", "重新打开设置",
    "已保存设置，结束终端并检查连接", "确认已保存，结束终端并检查连接", "继续在终端操作",
    "取消登录", "结束终端并返回", "取消设置", "查看登录进度", "返回接入方式",
    "查看当前选择", "重新读取模型", "保存设置", "返回所有对话", "API 配置", "设置",
    "刷新", "断开连接后管理", "保留连接", "使用此 Agent", "使用已有设置", "全部",
    "进行中", "等你回应", "打开账号设置", "准备使用",
    "暂时收起", "继续登录", "查看设置操作", "运行官方设置程序", "返回", "查看配置终端", "前往模型选择", "重新读取配置操作"
])
let cards = [
    "终端设置在终端中完成设置。": "终端设置",
    "ChatGPT按Agent提示完成授权。": "ChatGPT",
    "OpenAIAPIKey使用OpenAIAPI计费。": "OpenAI API Key",
    "模型API服务使用自定义地址和模型。": "模型 API 服务"
]
func normalized(_ value: String) -> String { value.filter { !$0.isWhitespace } }
let controlRoles = Set(["AXButton", "AXRadioButton", "AXCheckBox", "AXDisclosureTriangle", "AXPopUpButton"])
var modelLabels: Set<String> = []
var controls: [[String: Any]] = [], found: [AXUIElement] = [], visited = 0
func visit(_ element: AXUIElement, _ depth: Int) {
    guard depth < 35 && visited < 5000 else { return }; visited += 1
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    // No AXValue, text fields, static text, terminal buffers or unknown labels are exported.
    if controlRoles.contains(role) {
        let title = attribute(element, kAXTitleAttribute) as? String ?? ""
        let description = attribute(element, kAXDescriptionAttribute) as? String ?? ""
        if role == "AXButton" {
            let help = attribute(element, kAXHelpAttribute) as? String ?? ""
            for label in [title, description, help] {
                if label.range(of: "^(deepseek|zai-coding-cn|cohere|openrouter|openai|anthropic|gemini)/[A-Za-z0-9._:/-]+", options: [.regularExpression, .caseInsensitive]) != nil { modelLabels.insert(label) }
            }
        }
        let labels = [title, description].map { cards[normalized($0)] ?? $0 }
        if let label = labels.first(where: { allowed.contains($0) }) {
            let enabled = attribute(element, kAXEnabledAttribute) as? Bool ?? false
            controls.append(["label": label, "role": role, "enabled": enabled])
            if mode == "press" && labels.contains(requested) && allowed.contains(requested) { found.append(element) }
        }
    }
    if role == "AXTextArea" || role == "AXTextField" || role == "AXSecureTextField" { return }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { visit(child, depth + 1) }
    }
}
if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
    for window in windows { visit(window, 0) }
}
if mode == "press" {
    // Both source-verified sidebar entries invoke the same explore callback.
    if requested == "探索 Agent" && found.count == 2 { found = [found[0]] }
    guard found.count == 1 else { print("STOP expected one control, found", found.count); exit(3) }
    guard attribute(found[0], kAXEnabledAttribute) as? Bool == true else { print("STOP disabled"); exit(4) }
    let result = AXUIElementPerformAction(found[0], kAXPressAction as CFString)
    print("action", requested, result.rawValue); exit(result == .success ? 0 : 5)
}
let result: [String: Any] = ["pid": process.processIdentifier, "knownControls": controls, "visitedRoles": visited, "readsTextOrInputValues": false, "modelControlLabels": modelLabels.sorted()]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
