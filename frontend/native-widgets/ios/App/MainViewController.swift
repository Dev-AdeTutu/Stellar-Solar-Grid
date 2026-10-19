// Registers app-local Capacitor plugins (#901). In Main.storyboard, set the
// Bridge View Controller's custom class to MainViewController.

import Capacitor
import UIKit

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WidgetBridgePlugin())
    }
}
