import Network
import SwiftUI
import UIKit
import WebKit

/// Snake's Net on iPhone and iPad: this device's live download and upload speeds (Wi-Fi and
/// mobile data apart), and the Snake's Net web view of your computers over Tailscale. iOS does
/// not let an app see other apps' traffic, so there is no per-app list here; a computer's page
/// has one for that computer.
final class NetViewController: UIHostingController<NetView> {
    init(onClose: @escaping () -> Void) {
        super.init(rootView: NetView(onClose: onClose))
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) {
        fatalError("Snake's Net is not made from a storyboard")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(NetColors.bg)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}

enum NetColors {
    static let bg = Color(red: 0x1a / 255, green: 0x1e / 255, blue: 0x1b / 255)
    static let card = Color(red: 0x15 / 255, green: 0x19 / 255, blue: 0x16 / 255)
    static let border = Color(red: 0x25 / 255, green: 0x2b / 255, blue: 0x27 / 255)
    static let input = Color(red: 0x12 / 255, green: 0x15 / 255, blue: 0x13 / 255)
    static let fg = Color(red: 0xd5 / 255, green: 0xdd / 255, blue: 0xd7 / 255)
    static let fg2 = Color(red: 0x8a / 255, green: 0x97 / 255, blue: 0x8e / 255)
    static let fg3 = Color(red: 0x5d / 255, green: 0x6a / 255, blue: 0x62 / 255)
    static let highlight = Color(red: 0x7e / 255, green: 0xe7 / 255, blue: 0x87 / 255)
    static let down = Color(red: 0x6f / 255, green: 0xd1 / 255, blue: 0x8a / 255)
    static let up = Color(red: 0xf2 / 255, green: 0x77 / 255, blue: 0xa8 / 255)
}

// MARK: - numbers

func netRate(_ bytesPerSecond: Double) -> String {
    var v = bytesPerSecond * 8
    let units = ["b/s", "Kb/s", "Mb/s", "Gb/s"]
    var i = 0
    while v >= 1000 && i < units.count - 1 { v /= 1000; i += 1 }
    if i == 0 { return String(format: "%.0f %@", v, units[i]) }
    return String(format: v < 100 ? "%.1f %@" : "%.0f %@", v, units[i])
}

func netSize(_ bytes: UInt64) -> String {
    var v = Double(bytes)
    let units = ["B", "KB", "MB", "GB", "TB"]
    var i = 0
    while v >= 1000 && i < units.count - 1 { v /= 1000; i += 1 }
    if i == 0 { return String(format: "%.0f %@", v, units[i]) }
    return String(format: v < 100 ? "%.1f %@" : "%.0f %@", v, units[i])
}

/// Bytes in and out of every network interface since it came up (32-bit counters that wrap).
private func interfaceCounters() -> [String: (UInt32, UInt32)] {
    var out: [String: (UInt32, UInt32)] = [:]
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return out }
    defer { freeifaddrs(list) }
    var p: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = p?.pointee {
        defer { p = ifa.ifa_next }
        guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_LINK), let data = ifa.ifa_data else { continue }
        let stats = data.assumingMemoryBound(to: if_data.self).pointee
        out[String(cString: ifa.ifa_name)] = (stats.ifi_ibytes, stats.ifi_obytes)
    }
    return out
}

/// Live speeds of this iPhone, once a second.
final class PhoneNet: ObservableObject {
    static let history = 120

    @Published var down = 0.0, up = 0.0
    @Published var wifiDown = 0.0, wifiUp = 0.0, cellDown = 0.0, cellUp = 0.0
    @Published var histDown = [Double](repeating: 0, count: history)
    @Published var histUp = [Double](repeating: 0, count: history)
    @Published var peakDown = 0.0, peakUp = 0.0
    @Published var totalDown: UInt64 = 0, totalUp: UInt64 = 0
    @Published var wifiOn = false, cellOn = false

    private var last: [String: (UInt32, UInt32)] = [:]
    private var lastTime = Date()
    private var timer: Timer?
    private let monitor = NWPathMonitor()

    func start() {
        guard timer == nil else { return }
        last = interfaceCounters()
        lastTime = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.wifiOn = path.status == .satisfied && path.usesInterfaceType(.wifi)
                self?.cellOn = path.availableInterfaces.contains { $0.type == .cellular }
            }
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        monitor.cancel()
    }

    private func tick() {
        let now = interfaceCounters()
        let t = Date()
        let dt = max(0.2, t.timeIntervalSince(lastTime))
        var wifi = (UInt64(0), UInt64(0)), cell = (UInt64(0), UInt64(0)), other = (UInt64(0), UInt64(0))
        for (name, value) in now {
            guard let previous = last[name] else { continue }
            let (i, o) = value
            let (pi, po) = previous
            // The counters wrap at 4 GB: subtract around the circle; a reset reads as nothing.
            let di = i &- pi, dout = o &- po
            let din64 = di < (1 << 31) ? UInt64(di) : 0
            let dout64 = dout < (1 << 31) ? UInt64(dout) : 0
            if name == "en0" { wifi.0 += din64; wifi.1 += dout64 }
            else if name.hasPrefix("pdp_ip") { cell.0 += din64; cell.1 += dout64 }
            else if name.hasPrefix("en") { other.0 += din64; other.1 += dout64 } // USB Ethernet
            // lo0, utun (VPNs, which would count traffic twice), awdl/llw (AirDrop) are left out.
        }
        last = now
        lastTime = t
        let inBytes = wifi.0 + cell.0 + other.0, outBytes = wifi.1 + cell.1 + other.1
        down = Double(inBytes) / dt
        up = Double(outBytes) / dt
        wifiDown = Double(wifi.0) / dt; wifiUp = Double(wifi.1) / dt
        cellDown = Double(cell.0) / dt; cellUp = Double(cell.1) / dt
        histDown = Array((histDown + [down]).suffix(Self.history))
        histUp = Array((histUp + [up]).suffix(Self.history))
        peakDown = max(peakDown, down); peakUp = max(peakUp, up)
        totalDown += inBytes; totalUp += outBytes
    }
}

// MARK: - computers

struct Computer: Codable, Identifiable, Equatable {
    var name: String
    var url: String
    var id: String { url }

    static let key = "snakes-net-computers"

    static func load() -> [Computer] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let list = try? JSONDecoder().decode([Computer].self, from: data) else { return [] }
        return list
    }

    static func save(_ list: [Computer]) {
        if let data = try? JSONEncoder().encode(list) { UserDefaults.standard.set(data, forKey: key) }
    }

    /// "mainrig", "100.1.2.3", "mainrig:7878" or a full http address -> the page's address.
    static func url(for address: String) -> String? {
        var a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while a.hasSuffix("/") { a.removeLast() }
        if a.isEmpty || a.contains(" ") { return nil }
        if !a.hasPrefix("http://") && !a.hasPrefix("https://") { a = "http://" + a }
        let host = a.components(separatedBy: "://").last ?? ""
        let afterBracket = host.components(separatedBy: "]").last ?? host
        return afterBracket.contains(":") ? a : a + ":7878"
    }
}

// MARK: - screens

struct NetView: View {
    let onClose: () -> Void
    @StateObject private var phone = PhoneNet()
    @State private var tab = 0
    @State private var computers = Computer.load()
    @State private var adding = false
    @State private var newName = ""
    @State private var newAddress = ""
    @State private var opened: Computer?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: onClose) {
                    Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold))
                }
                .foregroundColor(NetColors.fg)
                .accessibilityLabel("Back to the apps")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Snake's Net").font(.headline).foregroundColor(NetColors.fg)
                    Text(tab == 0 ? "This iPhone" : "Computers").font(.caption).foregroundColor(NetColors.fg2)
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            Picker("", selection: $tab) {
                Text("This iPhone").tag(0)
                Text("Computers").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.bottom, 8)
            ScrollView {
                VStack(spacing: 10) {
                    if tab == 0 { phoneCards } else { computerCards }
                }
                .padding(12)
            }
        }
        .background(NetColors.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear { phone.start() }
        .onDisappear { phone.stop() }
        .alert("Add a computer", isPresented: $adding) {
            TextField("Name (optional)", text: $newName)
            TextField("mainrig or 100.x.y.z", text: $newAddress)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Add") { addComputer() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("On the computer, press w in Snake's Net: it shows the address.")
        }
        .fullScreenCover(item: $opened) { c in ComputerPage(computer: c) { opened = nil } }
    }

    private func card<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).foregroundColor(NetColors.fg2)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(NetColors.card)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NetColors.border))
        .cornerRadius(8)
    }

    private func line(_ label: String, _ value: String, _ color: Color = NetColors.fg) -> some View {
        HStack {
            Text(label).foregroundColor(NetColors.fg2)
            Spacer()
            Text(value).font(.system(.footnote, design: .monospaced)).foregroundColor(color)
        }
    }

    @ViewBuilder private var phoneCards: some View {
        card("Speed") {
            HStack {
                VStack(alignment: .leading) {
                    Text("▼ Download").font(.caption).foregroundColor(NetColors.fg2)
                    Text(netRate(phone.down)).font(.system(size: 24, weight: .bold, design: .monospaced)).foregroundColor(NetColors.down)
                    Text("peak \(netRate(phone.peakDown))").font(.caption2).foregroundColor(NetColors.fg3)
                }
                Spacer()
                VStack(alignment: .leading) {
                    Text("▲ Upload").font(.caption).foregroundColor(NetColors.fg2)
                    Text(netRate(phone.up)).font(.system(size: 24, weight: .bold, design: .monospaced)).foregroundColor(NetColors.up)
                    Text("peak \(netRate(phone.peakUp))").font(.caption2).foregroundColor(NetColors.fg3)
                }
                Spacer()
            }
            SpeedGraph(down: phone.histDown, up: phone.histUp).frame(height: 170)
            Text("last 2 minutes · since opened: ▼ \(netSize(phone.totalDown))  ▲ \(netSize(phone.totalUp))")
                .font(.caption2).foregroundColor(NetColors.fg3)
        }
        card("Connections") {
            line("Wi-Fi", phone.wifiOn ? "▼ \(netRate(phone.wifiDown))  ▲ \(netRate(phone.wifiUp))" : "off",
                 phone.wifiOn ? NetColors.fg : NetColors.fg3)
            line("Mobile data", phone.cellOn ? "▼ \(netRate(phone.cellDown))  ▲ \(netRate(phone.cellUp))" : "off",
                 phone.cellOn ? NetColors.fg : NetColors.fg3)
        }
        card("Apps") {
            Text("iPhones don't let an app see other apps' traffic, so the list of apps and their speeds is on your computers and Android phones. Under Computers, open a computer to see its apps.")
                .font(.footnote).foregroundColor(NetColors.fg2)
        }
    }

    @ViewBuilder private var computerCards: some View {
        card("Your computers") {
            Text("Watch a computer's Snake's Net from here. On the computer, press w in Snake's Net (or run snakes-net --headless) and add the address it shows, like 100.101.102.103 or its Tailscale name. Tailscale must be on for this iPhone.")
                .font(.footnote).foregroundColor(NetColors.fg2)
            Button {
                newName = ""; newAddress = ""; adding = true
            } label: {
                Label("Add a computer", systemImage: "plus").font(.body.weight(.semibold))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color(red: 0x3f / 255, green: 0xb9 / 255, blue: 0x50 / 255)).foregroundColor(.white).cornerRadius(6)
            }
            .padding(.top, 4)
        }
        if computers.isEmpty {
            Text("No computers yet.").foregroundColor(NetColors.fg2).padding(24)
        }
        ForEach(computers) { c in
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer").foregroundColor(NetColors.highlight)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.name).bold().foregroundColor(NetColors.fg)
                    Text(c.url).font(.system(.caption2, design: .monospaced)).foregroundColor(NetColors.fg3)
                }
                Spacer()
                Button {
                    computers.removeAll { $0 == c }
                    Computer.save(computers)
                } label: { Image(systemName: "trash").foregroundColor(NetColors.fg3) }
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(c.name)")
            }
            .padding(12)
            .background(NetColors.card)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(NetColors.border))
            .cornerRadius(8)
            .contentShape(Rectangle())
            .onTapGesture { opened = c }
        }
    }

    private func addComputer() {
        guard let url = Computer.url(for: newAddress) else { return }
        let name = newName.trimmingCharacters(in: .whitespaces)
        computers.removeAll { $0.url == url }
        computers.append(Computer(name: name.isEmpty ? newAddress.trimmingCharacters(in: .whitespaces) : name, url: url))
        Computer.save(computers)
    }
}

/// Download grows up from the middle, upload down, each on its own scale: like the desktop.
struct SpeedGraph: View {
    let down: [Double]
    let up: [Double]

    private func niceMax(_ v: Double) -> Double {
        let m = max(v, 1000)
        var p = 1.0
        while p * 10 <= m { p *= 10 }
        for k in [1.0, 2.0, 5.0, 10.0] where k * p >= m { return k * p }
        return 10 * p
    }

    /// The graph's line and the area under it, or nil with too few samples.
    private func paths(_ data: [Double], upward: Bool, size: CGSize) -> (Path, Path)? {
        guard data.count > 1 else { return nil }
        let mid = size.height / 2
        let top = niceMax(data.max() ?? 0)
        let step = size.width / CGFloat(data.count - 1)
        var line = Path()
        var fill = Path()
        fill.move(to: CGPoint(x: 0, y: mid))
        for (i, v) in data.enumerated() {
            let h = CGFloat(min(1, v / top)) * (mid - 2)
            let pt = CGPoint(x: CGFloat(i) * step, y: upward ? mid - h : mid + h)
            if i == 0 { line.move(to: pt) } else { line.addLine(to: pt) }
            fill.addLine(to: pt)
        }
        fill.addLine(to: CGPoint(x: size.width, y: mid))
        fill.closeSubpath()
        return (line, fill)
    }

    var body: some View {
        Canvas { ctx, size in
            let mid = size.height / 2
            var axis = Path()
            axis.move(to: CGPoint(x: 0, y: mid))
            axis.addLine(to: CGPoint(x: size.width, y: mid))
            ctx.stroke(axis, with: .color(NetColors.border), lineWidth: 1)
            for (data, upward, color) in [(down, true, NetColors.down), (up, false, NetColors.up)] {
                guard let drawn = paths(data, upward: upward, size: size) else { continue }
                let (line, fill) = drawn
                let colors = upward ? [color.opacity(0.8), color.opacity(0.12)] : [color.opacity(0.12), color.opacity(0.8)]
                ctx.fill(fill, with: .linearGradient(Gradient(colors: colors),
                                                     startPoint: CGPoint(x: 0, y: upward ? 0 : mid),
                                                     endPoint: CGPoint(x: 0, y: upward ? mid : size.height)))
                ctx.stroke(line, with: .color(color), lineWidth: 1.5)
            }
        }
        .background(NetColors.input)
        .cornerRadius(6)
    }
}

/// A computer's Snake's Net page.
struct ComputerPage: View {
    let computer: Computer
    let onClose: () -> Void
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)) }
                    .foregroundColor(NetColors.fg)
                    .accessibilityLabel("Close")
                Text(computer.name).bold().foregroundColor(NetColors.fg)
                Spacer()
                Text(computer.url.replacingOccurrences(of: "http://", with: ""))
                    .font(.system(.caption2, design: .monospaced)).foregroundColor(NetColors.fg3)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            if let failure {
                Text("Can't reach \(computer.name): \(failure). Is Tailscale on here, and Snake's Net sharing (w) on the computer?")
                    .font(.footnote).foregroundColor(Color(red: 1, green: 0.54, blue: 0.54)).padding(12)
            }
            WebPage(url: URL(string: computer.url), failure: $failure)
        }
        .background(Color(red: 0x0b / 255, green: 0x0f / 255, blue: 0x0c / 255).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

struct WebPage: UIViewRepresentable {
    let url: URL?
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0x0b / 255, green: 0x0f / 255, blue: 0x0c / 255, alpha: 1)
        web.navigationDelegate = context.coordinator
        if let url { web.load(URLRequest(url: url)) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: WebPage
        init(_ parent: WebPage) { self.parent = parent }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.failure = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.failure = nil
        }
    }
}
