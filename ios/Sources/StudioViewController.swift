import UIKit
import UniformTypeIdentifiers
import WebKit

/// Snake's Master Suite on iPhone and iPad: the suite's own pages (the same as the website) in
/// a web view, served from the app (SchemeHandler). It opens on the home page, which lists
/// every Snake app. The pages reach the phone only through window.SnakeIOS (the script below and
/// `handle`): the document picker, the files picked, printing, and switching apps.
final class StudioViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {

    private var web: WKWebView!
    private let files = Files()
    /// A file another app opened with Master Suite, waiting for its page to start.
    private var waiting: URL?
    private var pickerDone: (([URL]) -> Void)?
    private var hideStatusBar = false

    private static let background = UIColor(red: 0x1a / 255.0, green: 0x1e / 255.0, blue: 0x1b / 255.0, alpha: 1)

    /// window.SnakeIOS: the same requests the Android app answers (see kit/host.js).
    private static let bridge = """
    (() => {
      const post = (channel, args) => window.webkit.messageHandlers.snake.postMessage({ channel, args });
      window.SnakeIOS = {
        invoke(id, channel, argsJson) {
          post(channel, JSON.parse(argsJson)).then(
            (v) => window.__snakeReply(id, true, JSON.stringify(v === undefined ? null : v)),
            (e) => window.__snakeReply(id, false, JSON.stringify(String((e && e.message) || e))));
        },
        writeBegin: (fileId) => post('write:begin', [fileId]),
        writeChunk: (token, base64) => post('write:chunk', [token, base64]),
        writeEnd: (token, keep) => post('write:end', [token, keep]).then((v) => JSON.stringify(v)),
      };
    })();
    """

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersStatusBarHidden: Bool { hideStatusBar }
    override var prefersHomeIndicatorAutoHidden: Bool { hideStatusBar }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(files: files), forURLScheme: Files.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        content.addScriptMessageHandler(self, contentWorld: .page, name: "snake")
        content.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content

        web = WKWebView(frame: view.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.background
        web.scrollView.backgroundColor = Self.background
        // The pages keep clear of the notch and home bar themselves (CSS safe-area insets).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        // Swiping in from the left edge goes back to the list of apps.
        web.allowsBackForwardNavigationGestures = true
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        view.addSubview(web)
        load("home")
    }

    private func load(_ app: String) {
        web.load(URLRequest(url: URL(string: "\(Files.origin)/\(app)/index.html")!))
    }

    /// The app that opens a file, by its extension.
    private static func app(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "docx", "odt", "md", "markdown", "rtf", "txt", "html", "htm": return "word"
        case "xlsx", "csv", "tsv", "ods": return "sheets"
        case "pptx": return "slides"
        case "snake": return "compressor"
        case "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "psd", "ora", "heic": return "photo"
        default: return "player"
        }
    }

    /// Another app (Files, Mail...) opened a file with Master Suite.
    func open(_ url: URL) {
        let app = Self.app(for: url)
        if web.url?.path == "/\(app)/index.html" {
            emit("file:opened", [[files.register(url)]])
        } else {
            waiting = url
            load(app)
        }
    }

    private func emit(_ channel: String, _ args: [Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: [channel, json]),
              let call = String(data: quoted, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__snakeEmit && window.__snakeEmit(...\(call))", completionHandler: nil)
    }

    // MARK: - requests from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == Files.scheme,
              let body = message.body as? [String: Any], let channel = body["channel"] as? String else {
            replyHandler(nil, "Not allowed")
            return
        }
        let args = body["args"] as? [Any] ?? []
        handle(channel, args) { result in
            switch result {
            case .success(let value): replyHandler(value ?? NSNull(), nil)
            case .failure(let error): replyHandler(nil, error.localizedDescription)
            }
        }
    }

    private func handle(_ channel: String, _ args: [Any], done: @escaping (Result<Any?, Error>) -> Void) {
        func str(_ i: Int) -> String? { args.count > i ? args[i] as? String : nil }
        func opts() -> [String: Any] { args.first as? [String: Any] ?? [:] }
        let app = web.url?.pathComponents.dropFirst().first ?? "home"
        switch channel {
        case "app:init":
            var start: [[String: Any]] = []
            if let url = waiting, Self.app(for: url) == app {
                start.append(files.register(url))
                waiting = nil
            }
            done(.success(["app": app, "platform": "ios", "files": start, "recent": files.recent(app)]))
        case "write:begin":
            done(.success(files.beginWrite(str(0) ?? "")))
        case "write:chunk":
            done(.success(files.writeChunk(str(0) ?? "", str(1) ?? "")))
        case "write:end":
            done(.success(files.endWrite(str(0) ?? "", keep: args.count > 1 && (args[1] as? Bool ?? false))))
        case "file:open":
            let multiple = opts()["multiple"] as? Bool ?? false
            pick(types: Self.types(opts()["filters"]), multiple: multiple) { [files] urls in
                done(.success(urls.map { url -> [String: Any] in
                    let f = files.register(url)
                    files.remember(url, name: url.lastPathComponent, app: app)
                    return f
                }))
            }
        case "file:openFolder":
            let exts = Set(Self.extensions(opts()["filters"]))
            pick(types: [.folder], multiple: false) { [files] urls in
                guard let folder = urls.first else { return done(.success([Any]())) }
                done(.success(files.listFolder(folder, exts: exts).map { files.register($0.0, name: $0.1) }))
            }
        case "file:saveAs":
            saveAs(name: opts()["name"] as? String ?? "Untitled") { [files] url in
                guard let url else { return done(.success(nil)) }
                let f = files.register(url)
                files.remember(url, name: url.lastPathComponent, app: app)
                done(.success(f))
            }
        case "file:recent":
            done(.success(files.recent(app)))
        case "file:openRecent":
            done(Result<Any?, Error> { try self.files.openRecent(app, key: str(0) ?? "") })
        case "file:forgetRecent":
            done(.success(files.forgetRecent(app, key: str(0))))
        case "print":
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = str(0) ?? "Snake's Master Suite"
            info.outputType = .general
            let printer = UIPrintInteractionController.shared
            printer.printInfo = info
            printer.printFormatter = web.viewPrintFormatter()
            printer.present(animated: true, completionHandler: nil)
            done(.success(nil))
        case "win:title":
            done(.success(nil))
        case "win:fullScreen":
            hideStatusBar = (args.first as? Bool) ?? !hideStatusBar
            setNeedsStatusBarAppearanceUpdate()
            setNeedsUpdateOfHomeIndicatorAutoHidden()
            emit("win:fullScreen", [hideStatusBar])
            done(.success(nil))
        case "win:close":
            // An iPhone app does not close itself: back to the list of apps.
            load("home")
            done(.success(nil))
        case "launch":
            let target = str(0) ?? "home"
            guard target.allSatisfy({ $0.isLetter }) else { return done(.failure(StudioError("No such app"))) }
            load(target)
            done(.success(nil))
        case "openExternal":
            if let s = str(0), let url = URL(string: s), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
            done(.success(nil))
        default:
            done(.failure(StudioError("Unknown request: \(channel)")))
        }
    }

    // MARK: - pickers

    private static func extensions(_ filters: Any?) -> [String] {
        (filters as? [[String: Any]] ?? []).flatMap { ($0["exts"] as? [String] ?? []).map { $0.lowercased() } }
    }

    /// The document types of a page's filters ({ name, exts }), or anything when one is unknown.
    private static func types(_ filters: Any?) -> [UTType] {
        let exts = extensions(filters)
        let types = exts.map { UTType(filenameExtension: $0) }
        if exts.isEmpty || types.contains(where: { $0 == nil }) { return [.item] }
        return types.compactMap { $0 }
    }

    private func pick(types: [UTType], multiple: Bool, done: @escaping ([URL]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = multiple
        picker.delegate = self
        pickerDone = done
        present(picker, animated: true)
    }

    /// Save As: the person chooses where an (empty) file named `name` goes; the page then writes it.
    private func saveAs(name: String, done: @escaping (URL?) -> Void) {
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(safe.isEmpty ? "Untitled" : safe)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data().write(to: file)
        } catch {
            return done(nil)
        }
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: false)
        picker.delegate = self
        pickerDone = { urls in
            try? FileManager.default.removeItem(at: dir)
            done(urls.first)
        }
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickerDone?(urls)
        pickerDone = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerDone?([])
        pickerDone = nil
    }

    // MARK: - navigation: the pages never leave the app; links open in Safari

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Files.scheme { return decisionHandler(.allow) }
        if ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? ""), action.navigationType == .linkActivated {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    // Movie Maker's voice-over: iOS asks the person about the microphone itself.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == Files.scheme && type == .microphone ? .grant : .deny)
    }

    // The page's own confirm() and alert() (rare: the apps have their own dialogs).
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
