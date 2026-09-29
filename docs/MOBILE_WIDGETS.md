# Home-Screen Widgets (#901)

SolarGrid ships a home-screen widget for iOS (WidgetKit, Swift) and Android (AppWidget, Kotlin) in three sizes:

| Size | Shows |
| --- | --- |
| Small | Meter ID, active/inactive dot, XLM balance, days remaining |
| Medium | Small + today's usage and a 7-day usage chart |
| Large | Medium + day labels, "updated N min ago" and a **Top up** button |

Tapping the widget opens the app on the meter dashboard (`solargrid://meter/<id>`). The large widget's **Top up** button
opens the pay screen for that meter (`solargrid://pay?meter=<id>`).

## How it works

```
Web app (Capacitor) ──WidgetBridge.configure({ meterId, apiUrl })──▶ shared storage (App Group / SharedPreferences)
                                                                        │
Widget ◀── cached summary ◀── every 15 min: GET /api/widgets/summary?meterId=… (If-None-Match)
```

- `frontend/src/components/WidgetSync.tsx` pushes the meter the user is working with to the native widget and routes
  `solargrid://` deep links. It uses the `window.Capacitor` global, so the regular web build has no Capacitor dependency.
- `GET /api/widgets/summary` returns a response under 1 KB, cached on the server for 5 minutes, with an `ETag`.

### Battery and data

- **One request every 15 minutes at most.** iOS uses a `.after(+15 min)` timeline policy. Android uses a WorkManager
  periodic job (15 minutes is its minimum) with `updatePeriodMillis="0"`, so the system alarm never wakes the device.
- **Android jobs only run with a network connection and when the battery is not low.** WorkManager batches them with
  other work and respects Doze.
- **iOS refreshes skip Low Data Mode connections** (`allowsConstrainedNetworkAccess = false`).
- **Unchanged data costs a bodiless `304`.** Both platforms send `If-None-Match`.
- **Rendering never uses the network.** Widgets draw from the cached summary, so resizing and redraws are free.
- **Failures don't retry immediately.** On a network error the widget keeps its last good data and waits for the next
  scheduled run.

## iOS setup (after `npx cap add ios`)

1. In Xcode, **File → New → Target → Widget Extension** named `SolarGridWidget` (uncheck "Include Configuration Intent").
   Replace the generated sources with `frontend/native-widgets/ios/SolarGridWidget/*`.
2. Enable the **App Groups** capability on both the `App` and `SolarGridWidget` targets, using
   `group.com.stellarsolargrid.app`. The widget's entitlements file is provided.
3. Add `WidgetData.swift` to **both** targets. Add `native-widgets/ios/App/WidgetBridgePlugin.swift` and
   `MainViewController.swift` to the `App` target, then set the storyboard's Bridge View Controller class to
   `MainViewController`.
4. Register the URL scheme in `App/Info.plist`:
   ```xml
   <key>CFBundleURLTypes</key>
   <array><dict>
     <key>CFBundleURLSchemes</key><array><string>solargrid</string></array>
   </dict></array>
   ```
5. The deployment target for the extension must be iOS 16 or later.

## Android setup (after `npx cap add android`)

1. Copy `frontend/native-widgets/android/app/src/main/**` into `frontend/android/app/src/main/`. The provided
   `MainActivity.kt` replaces the generated `MainActivity.java`.
2. `android/app/build.gradle`:
   ```gradle
   dependencies {
       implementation "androidx.work:work-runtime-ktx:2.9.1"
   }
   ```
   Kotlin must be enabled: `apply plugin: 'kotlin-android'`, with the Kotlin Gradle plugin in the root `build.gradle`.
3. `AndroidManifest.xml`, inside `<application>`:
   ```xml
   <receiver android:name=".widget.SolarGridWidgetProvider" android:exported="false">
       <intent-filter>
           <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
       </intent-filter>
       <meta-data android:name="android.appwidget.provider" android:resource="@xml/solargrid_widget_info" />
   </receiver>
   ```
   And on the main `<activity>`:
   ```xml
   <intent-filter>
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="solargrid" />
   </intent-filter>
   ```

## Backend

| Env var | Default | Purpose |
| --- | --- | --- |
| `WIDGET_CACHE_TTL_MS` | `300000` | Server-side cache and `Cache-Control: max-age` for widget summaries |
