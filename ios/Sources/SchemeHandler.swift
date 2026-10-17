import WebKit

/// Serves the suite's pages from the app at snake-studio://app/ (the same files as the
/// website, copied into the app as "studio"), and the files the person picked at
/// snake-studio://app/file/<id>/<name>, with byte ranges so video can seek.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let files: Files
    private let root: URL
    private var stopped = Set<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "studio.files", qos: .userInitiated, attributes: .concurrent)
    /// A video asks for "the rest of the file": it gets this much at a time.
    private let slice: Int64 = 8 << 20

    init(files: Files) {
        self.files = files
        root = Bundle.main.bundleURL.appendingPathComponent("studio", isDirectory: true).standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        let range = task.request.value(forHTTPHeaderField: "Range")
        let id = ObjectIdentifier(task)
        queue.async { [weak self] in
            guard let self else { return }
            let (status, headers, body) = path.hasPrefix("/file/") ? self.file(path, range: range) : self.asset(path)
            DispatchQueue.main.async {
                if self.stopped.remove(id) != nil { return } // the page no longer wants it
                guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func notFound() -> (Int, [String: String], Data) {
        (404, ["Content-Type": "text/plain"], Data("Not found".utf8))
    }

    private func asset(_ path: String) -> (Int, [String: String], Data) {
        var file = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), isDir.boolValue {
            file = file.appendingPathComponent("index.html")
        }
        // Only files inside the app's own pages.
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else { return notFound() }
        return (200, ["Content-Type": Files.mime(for: file.lastPathComponent), "Content-Length": String(data.count),
                      "Cache-Control": "no-cache"], data)
    }

    private func file(_ path: String, range: String?) -> (Int, [String: String], Data) {
        let id = path.dropFirst("/file/".count).split(separator: "/").first.map(String.init) ?? ""
        guard let picked = files.picked(id) else { return notFound() }
        var headers = ["Content-Type": Files.mime(for: picked.name), "Accept-Ranges": "bytes", "Cache-Control": "no-store"]
        do {
            guard let range, let wanted = Self.parse(range) else {
                let (data, _, _) = try files.read(id)
                headers["Content-Length"] = String(data.count)
                return (200, headers, data)
            }
            let slice = self.slice
            let (data, total, start) = try files.read(id) { total in
                switch wanted {
                case (.some(let a), .some(let b)): return (a, min(b, total - 1))
                case (.some(let a), .none): return (a, min(total - 1, a + slice - 1))
                case (.none, .some(let n)): return (max(0, total - n), total - 1)
                case (.none, .none): return (0, total - 1)
                }
            }
            if start >= total && total > 0 {
                return (416, ["Content-Range": "bytes */\(total)"], Data())
            }
            headers["Content-Range"] = "bytes \(start)-\(start + Int64(data.count) - 1)/\(total)"
            headers["Content-Length"] = String(data.count)
            return (206, headers, data)
        } catch {
            return (500, ["Content-Type": "text/plain"], Data(error.localizedDescription.utf8))
        }
    }

    /// "bytes=a-b", "bytes=a-" or "bytes=-n" as (a, b), (a, nil) or (nil, n).
    static func parse(_ header: String) -> (Int64?, Int64?)? {
        guard header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2 else { return nil }
        let a = Int64(parts[0])
        let b = Int64(parts[1])
        if a == nil && b == nil { return nil }
        return (a, b)
    }
}
