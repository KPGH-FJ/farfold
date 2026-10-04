import AppKit
import WebKit

// Controlled native feasibility probe. Never accepts arbitrary JS, URLs, paths,
// browser connections or credentials from a caller. No MCP server or network port.
// All page content and cookie values below are synthetic fixtures.
struct Ticket { let task: String; let epoch: Int }

@MainActor final class Gate {
    var epoch = 0
    var phase = "shared"
    var grants: Set<String> = ["task-a", "task-b"]
    var writer = "task-a"
    var cache: [String: String] = [:]
    var emissions: [[String: String]] = []
    var dropped: [String: Int] = [:]
    var denied: [String: Int] = [:]
    var dispatchCount = 0

    func ticket(_ task: String, _ channel: String, write: Bool = false) -> Ticket? {
        guard phase == "shared", grants.contains(task), !write || writer == task else {
            denied[channel, default: 0] += 1
            return nil
        }
        dispatchCount += 1
        return Ticket(task: task, epoch: epoch)
    }
    func accepts(_ t: Ticket) -> Bool {
        phase == "shared" && t.epoch == epoch && grants.contains(t.task)
    }
    @discardableResult func emit(_ ticket: Ticket, channel: String, value: String) -> Bool {
        guard accepts(ticket) else { dropped[channel, default: 0] += 1; return false }
        cache[channel] = value
        emissions.append(["task": ticket.task, "channel": channel, "value": value])
        return true
    }
    func enterHuman() {
        phase = "human"
        epoch += 1
        grants.removeAll()
        cache.removeAll()
    }
    func identityChanged() {
        epoch += 1
        grants.removeAll()
        cache.removeAll()
        phase = "awaiting-authorization"
    }
    func authorize(_ task: String) {
        phase = "shared"
        writer = task
        grants.insert(task)
    }
}

@MainActor final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let output: URL
    let gate = Gate()
    let storeA = WKWebsiteDataStore.nonPersistent()
    let storeB = WKWebsiteDataStore.nonPersistent()
    var web: WKWebView!
    var window: NSWindow!
    var checks: [[String: Any]] = []
    var completed = false
    var started = false
    var listenerEpoch = 0
    var navigationRequests: [String] = []
    let canary = "SYNTHETIC_SECRET_CANARY_7b3a"

    init(output: URL) { self.output = output }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = storeA
        configuration.userContentController.add(self, name: "fixtureEgress")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 740, height: 440), configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Farfold — controlled WK probe (synthetic page only)"
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; img-src 'none'; frame-src 'none'">
        <style>body{font:18px system-ui;padding:40px;background:#f5f6fb;color:#171c30}button{padding:10px 24px;font:inherit}#value{font-size:32px}small{display:block;margin-top:24px}</style>
        <title>Controlled WK fixture</title></head><body>
        <h1>Controlled WK fixture</h1><p>Only synthetic content. No external page or account.</p>
        <p id="value">Count: 0</p><button id="increment" onclick="window.count++;document.getElementById('value').textContent='Count: '+window.count">Increment</button>
        <div id="secret"></div><small>Private temporary website data store</small>
        <script>window.count=0;window.observerPaused=false;window.fixturePost=(channel,value)=>{try{window.webkit.messageHandlers.fixtureEgress.postMessage({channel,value})}catch(e){}};</script>
        </body></html>
        """
        // about:blank content only; no HTTP server and no external navigation.
        web.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self = self, !self.completed else { return }
            self.check("bounded_real_wk_execution", false, "WK probe did not finish within 25 seconds")
            self.finish()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = action.request.url?.scheme ?? "unknown"
        navigationRequests.append(scheme)
        decisionHandler(scheme == "about" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        Task { await run() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        check("real_wk_load", false, "WK navigation failed")
        finish()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        check("real_wk_load", false, "WK provisional navigation failed")
        finish()
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === web, message.frameInfo.isMainFrame,
              let body = message.body as? [String: String],
              let channel = body["channel"], ["observer", "console-fixture", "trace-fixture"].contains(channel),
              let value = body["value"] else { return }
        // An old listener cannot mint a new authorization after a handoff.
        gate.emit(Ticket(task: "task-a", epoch: listenerEpoch), channel: channel, value: value)
    }
    func check(_ name: String, _ pass: Bool, _ detail: String = "") {
        checks.append(["name": name, "pass": pass, "detail": detail])
    }
    func js(_ source: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            web.evaluateJavaScript(source) { value, error in
                if let error = error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
        }
    }
    func read(_ task: String) async throws -> String? {
        guard let ticket = gate.ticket(task, "read") else { return nil }
        let text = try await js("document.body.innerText") as? String ?? ""
        return gate.emit(ticket, channel: "read", value: text) ? text : nil
    }
    func click(_ task: String) async throws -> String? {
        guard let ticket = gate.ticket(task, "click", write: true) else { return nil }
        let text = try await js("document.getElementById('increment').click();document.getElementById('value').textContent") as? String ?? ""
        return gate.emit(ticket, channel: "click", value: text) ? text : nil
    }
    func snapshot(_ task: String, save: Bool) async throws -> Bool {
        guard let ticket = gate.ticket(task, "screenshot") else { return false }
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            web.takeSnapshot(with: nil) { image, error in
                if let error = error { continuation.resume(throwing: error) }
                else if let image = image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: NSError(domain: "probe", code: 1)) }
            }
        }
        guard gate.emit(ticket, channel: "screenshot", value: "controlled snapshot; pixels withheld from result JSON") else { return false }
        if save, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: output.appendingPathComponent("wk-fixture.png"))
        }
        return true
    }
    func cookies(_ store: WKWebsiteDataStore) async -> [HTTPCookie] {
        await withCheckedContinuation { c in store.httpCookieStore.getAllCookies { c.resume(returning: $0) } }
    }
    func delay(_ milliseconds: UInt64) async {
        try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }

    func run() async {
        do {
            check("real_wk_loaded", web.url?.absoluteString == "about:blank")
            check("temporary_stores", !storeA.isPersistent && !storeB.isPersistent)
            let initial = try await read("task-a")
            check("real_dom_read", initial?.contains("Count: 0") == true)
            let result = try await click("task-a")
            check("real_dom_click_and_return", result == "Count: 1")
            let second = try await read("task-b")
            check("same_context_other_task_observes_result", second?.contains("Count: 1") == true)
            let deniedClick = try await click("task-b")
            check("single_writer", deniedClick == nil)
            let shot = try await snapshot("task-a", save: true)
            check("real_wk_snapshot", shot)

            let cookie = HTTPCookie(properties: [.domain: "probe.invalid", .path: "/", .name: "probe_only", .value: "synthetic_cookie_value", .secure: "TRUE"])!
            await withCheckedContinuation { c in storeA.httpCookieStore.setCookie(cookie) { c.resume() } }
            let cookiesA = await cookies(storeA)
            let cookiesB = await cookies(storeB)
            check("temporary_cookie_store_a", cookiesA.contains { $0.name == "probe_only" })
            check("independent_temporary_store_b_empty", !cookiesB.contains { $0.name == "probe_only" })

            listenerEpoch = gate.epoch
            _ = try await js("window.observerTimer=setInterval(()=>{if(!window.observerPaused)window.fixturePost('observer',document.getElementById('value').textContent)},30)")
            await delay(80)
            check("actual_wk_listener_before_handoff", gate.emissions.contains { $0["channel"] == "observer" })
            let staleTicket = gate.ticket("task-a", "pending-read")!
            // Genuine asynchronous WebKit evaluation remains pending as handoff begins.
            var lateReadDelivered = false
            web.callAsyncJavaScript("await new Promise(r=>setTimeout(r,150));return document.body.innerText", arguments: [:], in: nil, in: .page) { completion in
                if case .success(let result) = completion {
                    lateReadDelivered = self.gate.emit(staleTicket, channel: "pending-read", value: String(describing: result))
                }
            }
            let staleShot = gate.ticket("task-a", "pending-screenshot")!
            var lateSnapshotDelivered = false
            web.takeSnapshot(with: nil) { image, error in
                if image != nil {
                    lateSnapshotDelivered = self.gate.emit(staleShot, channel: "pending-screenshot", value: "stale pixel buffer")
                }
            }
            gate.enterHuman()
            // Stop the live periodic collector before making the synthetic secret visible.
            _ = try await js("clearInterval(window.observerTimer);window.observerPaused=true;document.getElementById('secret').textContent='\(canary)';['observer','console-fixture','trace-fixture'].forEach(c=>setTimeout(()=>window.fixturePost(c,document.body.innerText),20));true")
            let afterPauseCount = gate.dispatchCount
            let pausedReadA = try await read("task-a")
            let pausedReadB = try await read("task-b")
            let pausedClickA = try await click("task-a")
            let pausedClickB = try await click("task-b")
            let pausedShot = try await snapshot("task-a", save: false)
            check("all_tasks_pre_dispatch_paused", pausedReadA == nil && pausedReadB == nil && pausedClickA == nil && pausedClickB == nil && !pausedShot && afterPauseCount == gate.dispatchCount)
            check("cache_cleared_on_handoff", gate.cache.isEmpty)
            await delay(250)
            check("late_real_dom_response_rejected", !lateReadDelivered && gate.dropped["pending-read", default: 0] > 0)
            check("late_real_snapshot_rejected", !lateSnapshotDelivered && gate.dropped["pending-screenshot", default: 0] > 0)
            for channel in ["observer", "console-fixture", "trace-fixture"] {
                check("stale_\(channel)_rejected", gate.dropped[channel, default: 0] > 0)
            }
            let observerStopped = try await js("window.observerPaused === true") as? Bool ?? false
            check("periodic_observation_disabled", observerStopped)
            check("secret_not_in_agent_egress", !gate.emissions.contains { ($0["value"] ?? "").contains(canary) })

            // Human finishes the synthetic input. No task is implicitly re-authorized.
            _ = try await js("document.getElementById('secret').textContent='';document.getElementById('value').textContent='Count: 2';window.count=2")
            gate.identityChanged()
            let identityA = try await read("task-a")
            let identityB = try await read("task-b")
            check("identity_change_invalidates_every_task", identityA == nil && identityB == nil)
            gate.authorize("task-a")
            check("old_ticket_rejected_after_reauthorization", !gate.emit(staleTicket, channel: "old-cache", value: canary))
            let fresh = try await read("task-a")
            check("explicit_reauthorization_fresh_observation", fresh?.contains("Count: 2") == true)
            let stillBlocked = try await read("task-b")
            check("other_task_not_implicitly_reauthorized", stillBlocked == nil)
            check("only_about_navigation_requested", navigationRequests.allSatisfy { $0 == "about" })
            finish()
        } catch {
            check("native_operation_completed", false, "A native WebKit operation failed; error code \((error as NSError).code)")
            finish()
        }
    }
    func finish() {
        guard !completed else { return }
        completed = true
        let report: [String: Any] = [
            "kind": "native-WKWebView-controlled-probe", "date": ISO8601DateFormatter().string(from: Date()),
            "pass": checks.allSatisfy { $0["pass"] as? Bool == true }, "checks": checks,
            "rejected_egress_channels": gate.dropped, "denied_before_dispatch": gate.denied,
            "allowed_egress": gate.emissions,
            "scope": ["real macOS WKWebView", "in-memory synthetic about:blank page", "two new nonpersistent website data stores", "no network listener or raw control port", "no external navigation", "no Agent or MCP call"],
            "limitations": ["Native proof only; not a Tauri app or production bridge", "No human manually operated this automated probe", "console/trace are synthetic WK script-message channels, not complete native interception", "No arbitrary website, OAuth, popup, iframe, download or crash recovery coverage", "No process-wide or OS security boundary claim"]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: output.appendingPathComponent("result.json"))
            print(String(data: data, encoding: .utf8)!)
        }
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "fixtureEgress")
        web?.stopLoading()
        window?.orderOut(nil)
        NSApplication.shared.terminate(nil)
    }
}

@main struct ProbeMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let delegate = Probe(output: directory)
        application.delegate = delegate
        application.run()
    }
}
