package com.stellarsolargrid.app.widget

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Lets the web app tell the home-screen widget which meter to show (#901).
 * Register in MainActivity: registerPlugin(WidgetBridgePlugin::class.java).
 */
@CapacitorPlugin(name = "WidgetBridge")
class WidgetBridgePlugin : Plugin() {

    @PluginMethod
    fun configure(call: PluginCall) {
        val meterId = call.getString("meterId")
        val apiUrl = call.getString("apiUrl")
        if (meterId.isNullOrBlank() || apiUrl.isNullOrBlank()) {
            call.reject("meterId and apiUrl are required")
            return
        }
        // Only hit the network when the selection actually changed.
        if (WidgetDataStore.configure(context, meterId, apiUrl)) {
            SolarGridWidgetProvider.updateAll(context)
            WidgetUpdateWorker.refreshNow(context)
        }
        call.resolve()
    }

    @PluginMethod
    fun refresh(call: PluginCall) {
        WidgetUpdateWorker.refreshNow(context)
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        WidgetDataStore.clear(context)
        SolarGridWidgetProvider.updateAll(context)
        call.resolve()
    }
}
