import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = UIColor(red: 15/255, green: 20/255, blue: 32/255, alpha: 1) // #0f1420
        window?.rootViewController = FinextiumBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // finextium://auth#tokens (Google sign-in) → App.appUrlOpen in js/app-shell.js
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Bridge controller that registers Finextium's local native plugins.
class FinextiumBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppPrintPlugin())
    }
}

/// window.print() does nothing inside WKWebView. js/app-shell.js routes it here → the iOS print
/// sheet (AirPrint or "Save to Files" as PDF). The page's @media print styles apply.
@objc(AppPrintPlugin)
public class AppPrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppPrintPlugin"
    public let jsName = "AppPrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)
    ]

    @objc func print(_ call: CAPPluginCall) {
        let jobName = call.getString("name") ?? "Finextium"
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else {
                call.reject("Web view unavailable")
                return
            }
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = jobName
            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printFormatter = webView.viewPrintFormatter()
            controller.present(animated: true) { _, completed, error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve(["completed": completed])
                }
            }
        }
    }
}
