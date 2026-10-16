import Foundation
import UniformTypeIdentifiers

/// An error the page shows as it is.
struct StudioError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// The files the person picked, as the page knows them: id, name, ext, size, mtime, writable.
/// The page reads one at snake-studio://app/file/<id>/<name> (SchemeHandler, with byte ranges
/// so video can seek) and writes it in pieces. An id exists only for a file the person chose,
/// or opened Snake's Studio with; nothing else on the phone is reachable.
final class Files {
    static let scheme = "snake-studio"
    static let origin = "\(scheme)://app"

    private struct Picked { let url: URL; let name: String }
    private struct Writing { let fileId: String; let temp: URL; let handle: FileHandle }

    private var open: [String: Picked] = [:]
    private var writes: [String: Writing] = [:]
    private var seq = 0
    private let lock = NSLock()
    private let defaults = UserDefaults.standard

    private func next(_ prefix: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        seq += 1
        return "\(prefix)\(seq)"
    }

    // MARK: - describing

    /// Make a picked file known to the page. Access to it lasts while the app runs.
    func register(_ url: URL, name: String? = nil) -> [String: Any] {
        _ = url.startAccessingSecurityScopedResource()
        let id = next("i")
        lock.lock()
        open[id] = Picked(url: url, name: name ?? url.lastPathComponent)
        lock.unlock()
        return describe(id)
    }

    func picked(_ id: String) -> (url: URL, name: String)? {
        lock.lock()
        defer { lock.unlock() }
        guard let p = open[id] else { return nil }
        return (p.url, p.name)
    }

    func describe(_ id: String) -> [String: Any] {
        guard let p = picked(id) else { return [:] }
        let values = try? p.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isWritableKey])
        return [
            "id": id,
            "name": p.name,
            "ext": (p.name as NSString).pathExtension.lowercased(),
            "size": values?.fileSize ?? -1,
            "mtime": Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
            "writable": values?.isWritable ?? true,
        ]
    }

    static func mime(for name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    // MARK: - reading

    /// Bytes of a picked file: all of it, or the part `range` picks once the size is known
    /// (first and last byte, inclusive). Returns the bytes, the file's size and where they start.
    func read(_ id: String, range: ((Int64) -> (Int64, Int64))? = nil) throws -> (data: Data, total: Int64, start: Int64) {
        guard let p = picked(id) else { throw StudioError("That file is not open.") }
        var result: Result<(Data, Int64, Int64), Error> = .failure(StudioError("“\(p.name)” could not be read."))
        var coordination: NSError?
        NSFileCoordinator().coordinate(readingItemAt: p.url, options: [], error: &coordination) { url in
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let total = Int64(try handle.seekToEnd())
                let (start, end) = range?(total) ?? (0, total - 1)
                try handle.seek(toOffset: UInt64(max(0, start)))
                let data = end >= start ? (try handle.read(upToCount: Int(end - start + 1)) ?? Data()) : Data()
                result = .success((data, total, start))
            } catch {
                result = .failure(error)
            }
        }
        if let coordination { throw coordination }
        let (data, total, start) = try result.get()
        return (data, total, start)
    }

    // MARK: - writing (to a temporary file first, so a failure halfway leaves the original alone)

    func beginWrite(_ fileId: String) -> String? {
        guard picked(fileId) != nil else { return nil }
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: temp.path, contents: nil),
              let handle = try? FileHandle(forWritingTo: temp) else { return nil }
        let token = next("w")
        lock.lock()
        writes[token] = Writing(fileId: fileId, temp: temp, handle: handle)
        lock.unlock()
        return token
    }

    func writeChunk(_ token: String, _ base64: String) -> Bool {
        lock.lock()
        let w = writes[token]
        lock.unlock()
        guard let w, let data = Data(base64Encoded: base64) else { return false }
        do {
            try w.handle.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    func endWrite(_ token: String, keep: Bool) -> [String: Any] {
        lock.lock()
        let w = writes.removeValue(forKey: token)
        lock.unlock()
        guard let w else { return ["error": "Nothing is being saved."] }
        try? w.handle.close()
        defer { try? FileManager.default.removeItem(at: w.temp) }
        guard keep else { return ["cancelled": true] }
        guard let p = picked(w.fileId) else { return ["error": "That file is not open."] }
        var failure: Error?
        var coordination: NSError?
        NSFileCoordinator().coordinate(writingItemAt: p.url, options: .forReplacing, error: &coordination) { url in
            do {
                try Data(contentsOf: w.temp).write(to: url)
            } catch {
                failure = error
            }
        }
        if let error = (coordination as Error?) ?? failure { return ["error": error.localizedDescription] }
        let d = describe(w.fileId)
        return ["size": d["size"] ?? 0, "mtime": d["mtime"] ?? 0]
    }

    // MARK: - recent files (bookmarks keep access after a restart)

    private func recentList(_ app: String) -> [[String: Any]] {
        defaults.array(forKey: "recent-\(app)") as? [[String: Any]] ?? []
    }

    private func resolve(_ entry: [String: Any]) -> URL? {
        guard let data = entry["bookmark"] as? Data else { return nil }
        var stale = false
        return try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    }

    func remember(_ url: URL, name: String, app: String) {
        guard let bookmark = try? url.bookmarkData() else { return }
        var list = recentList(app).filter { ($0["path"] as? String) != url.path }
        list.insert(["name": name, "path": url.path, "bookmark": bookmark, "time": Date().timeIntervalSince1970 * 1000], at: 0)
        defaults.set(Array(list.prefix(20)), forKey: "recent-\(app)")
    }

    func recent(_ app: String) -> [[String: Any]] {
        recentList(app).enumerated().map { i, entry in
            ["key": String(i), "name": entry["name"] as? String ?? "", "dir": "",
             "time": entry["time"] as? Double ?? 0, "exists": resolve(entry) != nil]
        }
    }

    func openRecent(_ app: String, key: String) throws -> [String: Any] {
        let list = recentList(app)
        guard let i = Int(key), i < list.count, let url = resolve(list[i]) else {
            throw StudioError("That file is no longer there.")
        }
        let name = list[i]["name"] as? String ?? url.lastPathComponent
        let file = register(url, name: name)
        remember(url, name: name, app: app)
        return file
    }

    func forgetRecent(_ app: String, key: String?) -> [[String: Any]] {
        var list = recentList(app)
        if let key {
            if let i = Int(key), i < list.count { list.remove(at: i) }
        } else {
            list = []
        }
        defaults.set(list, forKey: "recent-\(app)")
        return recent(app)
    }

    // MARK: - folders

    /// The files in a folder the person picked (and its subfolders), at most `limit`.
    func listFolder(_ folder: URL, exts: Set<String>, limit: Int = 2000) -> [(URL, String)] {
        _ = folder.startAccessingSecurityScopedResource()
        var out: [(URL, String)] = []
        let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
        while let url = enumerator?.nextObject() as? URL, out.count < limit {
            if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { continue }
            if exts.isEmpty || exts.contains(url.pathExtension.lowercased()) { out.append((url, url.lastPathComponent)) }
        }
        return out.sorted { $0.1.lowercased() < $1.1.lowercased() }
    }
}
