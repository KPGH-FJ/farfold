import AppKit
import Foundation
import WebKit

// Ephemeral WKWebView, no window, no .app, no Farfold data or bridge.
final class Probe: NSObject, WKURLSchemeHandler, WKScriptMessageHandler {
    let input: [String: Any]
    let csp: String
    var web: WKWebView!
    var finished = false
    var requests: [String] = []
    init(input: [String: Any]) {
        self.input = input
        csp = input["csp"] as! String
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "tauri")
        config.setURLSchemeHandler(self, forURLScheme: "asset")
        config.userContentController.add(self, name: "receipt")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        var receipt = message.body as! [String: Any]
        receipt["requests"] = requests
        receipt["csp"] = csp
        receipt["os"] = ProcessInfo.processInfo.operatingSystemVersionString
        let data = try! JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        finished = true
    }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        requests.append(url.absoluteString)
        let data: Data
        let mime: String
        if url.path == "/index.html" {
            mime = "text/html"
            data = Data("<!doctype html><meta charset=\"utf-8\"><title>CSP probe</title><script src=\"tauri://localhost/probe.js\"></script>".utf8)
        } else if url.path == "/probe.js" {
            mime = "text/javascript"
            let images = String(data: try! JSONSerialization.data(withJSONObject: input["images"]!), encoding: .utf8)!
            data = Data(("const specimens = " + images + ";\n" + Self.script).utf8)
        } else {
            let image = (input["images"] as! [[String: Any]])[0]
            mime = image["mime"] as! String
            data = Data(base64Encoded: image["base64"] as! String)!
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Content-Security-Policy": csp])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    static let script = #"""
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push({directive:event.effectiveDirective,blockedURI:event.blockedURI,disposition:event.disposition}));
    const held = [];
    async function image(name, url) {
      return new Promise(resolve => {
        const img = new Image(); img.alt=name;
        const deadline = setTimeout(() => done(false,'timeout'),4000);
        function done(ok,reason) { clearTimeout(deadline); img.onload=null; img.onerror=null; resolve({name,ok,reason,width:img.naturalWidth,height:img.naturalHeight,url}); }
        img.onload=()=>done(true,'load'); img.onerror=()=>done(false,'error');
        img.src=url; document.documentElement.append(img);
      });
    }
    (async()=>{
      const results=[];
      for(const specimen of specimens) {
        const bytes=Uint8Array.from(atob(specimen.base64),value=>value.charCodeAt(0));
        const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:specimen.mime}));
        held.push(url); results.push(await image('blob:'+specimen.name,url));
      }
      results.push(await image('data-png','data:'+specimens[0].mime+';base64,'+specimens[0].base64));
      results.push(await image('same-origin','tauri://localhost/image.png'));
      results.push(await image('asset','asset://localhost/image.png'));
      results.push(await image('external-https','https://farfold-docx-csp.invalid/not-requested.png'));
      results.push(await image('external-http','http://farfold-docx-csp.invalid/not-requested.png'));
      await new Promise(resolve=>setTimeout(resolve,0));
      window.webkit.messageHandlers.receipt.postMessage({href:location.href,origin:location.origin,userAgent:navigator.userAgent,results,violations,heldUntilAllResults:held.length});
      held.forEach(URL.revokeObjectURL);
    })().catch(error=>window.webkit.messageHandlers.receipt.postMessage({error:String(error)}));
    """#
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let probe = Probe(input: try JSONSerialization.jsonObject(with: data) as! [String: Any])
probe.web.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
let deadline = Date().addingTimeInterval(25)
while !probe.finished && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}
probe.web.stopLoading()
probe.web.configuration.userContentController.removeScriptMessageHandler(forName: "receipt")
if !probe.finished { fputs("WK probe deadline exceeded\n", stderr); exit(2) }
