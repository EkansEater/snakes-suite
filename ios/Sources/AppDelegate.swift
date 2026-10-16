import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = StudioViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// A file opened with Snake's Studio from another app (Files, Mail, Safari...).
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.isFileURL, let studio = window?.rootViewController as? StudioViewController else { return false }
        studio.open(url)
        return true
    }
}
