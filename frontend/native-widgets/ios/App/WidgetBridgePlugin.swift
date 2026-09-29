// Capacitor plugin that lets the web app tell the home-screen widget which
// meter to show (#901). Add this file to the *App* target (not the widget
// extension) together with WidgetData.swift, and register the plugin in
// MainViewController.swift.

import Capacitor
import WidgetKit

@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func configure(_ call: CAPPluginCall) {
        guard let meterId = call.getString("meterId"), !meterId.isEmpty,
              let apiUrl = call.getString("apiUrl"), !apiUrl.isEmpty
        else {
            call.reject("meterId and apiUrl are required")
            return
        }
        // Only wake the widget when something changed — avoids needless refreshes.
        if WidgetStore.configure(meterId: meterId, apiUrl: apiUrl) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    @objc func refresh(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        WidgetStore.clear()
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
