package com.stellarsolargrid.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.stellarsolargrid.app.widget.WidgetBridgePlugin

/** Replaces the generated MainActivity to register app-local plugins (#901). */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(WidgetBridgePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
