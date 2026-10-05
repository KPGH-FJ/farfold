import AppKit
import CoreServices
import CryptoKit
import UniformTypeIdentifiers

let applicationPath = "/Applications/Farfold.app"
let phase = CommandLine.arguments.dropFirst().first ?? "before"
guard ["before", "after", "sandbox"].contains(phase) else { exit(2) }
let outputPrefix = "/tmp/farfold-application-icon-" + phase
let workspace = NSWorkspace.shared
let renderedSize = 512

func export(_ input: NSImage, suffix: String) throws -> [String: Any] {
    let image = input.copy() as! NSImage
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: renderedSize,
        pixelsHigh: renderedSize, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: renderedSize * 4, bitsPerPixel: 32)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.clear.set()
    NSRect(x: 0, y: 0, width: renderedSize, height: renderedSize).fill()
    image.draw(in: NSRect(x: 0, y: 0, width: renderedSize, height: renderedSize))
    NSGraphicsContext.restoreGraphicsState()
    let png = rep.representation(using: .png, properties: [:])!
    let destination = outputPrefix + "-" + suffix + ".png"
    try png.write(to: URL(fileURLWithPath: destination))
    let pixels = Data(bytes: rep.bitmapData!, count: rep.bytesPerRow * rep.pixelsHigh)
    return ["path": destination, "pixelSha256": SHA256.hash(data: pixels).map { String(format: "%02x", $0) }.joined(),
        "representations": image.representations.map { ["pixelsWide": $0.pixelsWide, "pixelsHigh": $0.pixelsHigh] }]
}

let displayed = workspace.icon(forFile: applicationPath)
let resource = NSImage(contentsOfFile: applicationPath + "/Contents/Resources/icon.icns")!
let generic = workspace.icon(for: .application)
let registered = LSCopyApplicationURLsForBundleIdentifier("ai.farfold.desktop" as CFString, nil)?.takeRetainedValue() as? [URL] ?? []
let running = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.farfold.desktop").filter { $0.executableURL?.path == applicationPath + "/Contents/MacOS/farfold" }
let runningIcons: [[String: Any]] = try running.enumerated().map { index, app in
    var result: [String: Any] = ["pid": app.processIdentifier, "executablePath": app.executableURL!.path]
    if let icon = app.icon { result["icon"] = try export(icon, suffix: "running-" + String(index)) }
    else { result["icon"] = NSNull() }
    return result
}
let data: [String: Any] = [
    "applicationPath": applicationPath,
    "runningApplications": runningIcons,
    "scope": "Public application metadata and isolated application icons only; no app launch, windows, accessibility, accounts or environment reads.",
    "registeredApplicationPaths": registered.map { $0.path },
    "preferredApplicationPath": workspace.urlForApplication(withBundleIdentifier: "ai.farfold.desktop")?.path ?? NSNull(),
    "workspaceIcon": try export(displayed, suffix: "workspace"),
    "resourceIcon": try export(resource, suffix: "resource"),
    "genericIcon": try export(generic, suffix: "generic")
]
let json = try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
print(String(data: json, encoding: .utf8)!)
