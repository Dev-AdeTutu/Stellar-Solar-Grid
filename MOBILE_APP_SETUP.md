# Mobile App Setup Guide

This guide covers setting up and building the Stellar Solar Grid mobile app using Capacitor.

## Overview

The mobile app wraps the existing React/Next.js frontend with Capacitor to provide:

- ✅ Native app feel and performance
- ✅ Push notifications (even when app closed)
- ✅ Offline capabilities with background sync
- ✅ Biometric authentication (fingerprint/Face ID)
- ✅ Secure keychain storage
- ✅ App store presence (iOS & Android)

## Prerequisites

### General Requirements

- Node.js 18+ and npm
- Git

### iOS Requirements

- macOS with Xcode 14+
- CocoaPods (`sudo gem install cocoapods`)
- Apple Developer Account (for deployment)

### Android Requirements

- Android Studio (latest stable)
- Java Development Kit (JDK) 17+
- Android SDK (API level 33+)
- Google Play Developer Account (for deployment)

## Initial Setup

### 1. Install Capacitor Dependencies

```bash
cd frontend

# Install Capacitor and native dependencies
npm install @capacitor/core @capacitor/cli
npm install @capacitor/ios @capacitor/android
npm install @capacitor/app @capacitor/haptics @capacitor/keyboard
npm install @capacitor/network @capacitor/preferences
npm install @capacitor/push-notifications @capacitor/splash-screen @capacitor/status-bar
npm install @capawesome/capacitor-biometric-auth @capawesome/capacitor-background-task
npm install firebase
```

### 2. Initialize Capacitor

```bash
# Initialize Capacitor (creates capacitor.config.ts)
npx cap init "Stellar Solar Grid" "com.stellarsolargrid.app"

# Add iOS platform
npx cap add ios

# Add Android platform
npx cap add android
```

### 3. Configure Next.js for Static Export

Update `next.config.js` to use the mobile configuration:

```bash
# Backup current config
cp next.config.js next.config.web.js

# Use mobile config
cp next.config.mobile.js next.config.js
```

Or modify `next.config.js` directly:

```javascript
module.exports = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};
```

## Development Workflow

### Building for Mobile

```bash
# Build Next.js app as static export
npm run build

# This creates 'out' directory with static files
# Capacitor will use this as webDir

# Sync changes to native projects
npm run capacitor:sync

# Or sync individual platforms
npm run capacitor:sync:ios
npm run capacitor:sync:android
```

### Running on Devices/Emulators

#### iOS

```bash
# Open Xcode
npm run capacitor:open:ios

# Or run directly
npm run capacitor:run:ios
```

In Xcode:
1. Select target device/simulator
2. Click Run (▶) button
3. App builds and launches

#### Android

```bash
# Open Android Studio
npm run capacitor:open:android

# Or run directly
npm run capacitor:run:android
```

In Android Studio:
1. Select target device/emulator
2. Click Run (▶) button
3. App builds and installs

### Live Reload During Development

For faster iteration, point Capacitor to your local dev server:

```javascript
// capacitor.config.ts
server: {
  url: 'http://192.168.1.100:3000', // Your local IP
  cleartext: true,
}
```

Then:
1. Start Next.js dev server: `npm run dev`
2. Run app on device
3. App loads from your dev server with hot reload

**Note**: Remove `server.url` before production builds!

## Native Features Implementation

### 1. Push Notifications

#### Setup Firebase Cloud Messaging

1. Create Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Add iOS app (Bundle ID: `com.stellarsolargrid.app`)
3. Download `GoogleService-Info.plist` → place in `ios/App/App/`
4. Add Android app (Package name: `com.stellarsolargrid.app`)
5. Download `google-services.json` → place in `android/app/`

#### iOS Setup

Add to `ios/App/App/Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>remote-notification</string>
</array>
```

#### Android Setup

Automatically configured via `google-services.json`.

#### Usage in Code

```typescript
import { requestPushPermissions, registerPushNotifications } from '@/lib/capacitor';

// Request permission
const granted = await requestPushPermissions();

if (granted) {
  // Register and get token
  const token = await registerPushNotifications();
  // Send token to backend
  await fetch('/api/push-subscriptions', {
    method: 'POST',
    body: JSON.stringify({ token: token.value }),
  });
}
```

### 2. Biometric Authentication

```typescript
import { BiometricAuth } from '@capawesome/capacitor-biometric-auth';

// Check if biometrics available
const result = await BiometricAuth.checkBiometry();

if (result.isAvailable) {
  // Authenticate
  try {
    await BiometricAuth.authenticate({
      reason: 'Confirm payment',
    });
    // Success - proceed with payment
  } catch (error) {
    // Authentication failed
  }
}
```

### 3. Secure Storage

```typescript
import { setSecureValue, getSecureValue } from '@/lib/capacitor';

// Store private key securely
await setSecureValue('stellar_private_key', privateKey);

// Retrieve later
const key = await getSecureValue('stellar_private_key');
```

### 4. Background Sync

```typescript
import { BackgroundTask } from '@capawesome/capacitor-background-task';

// Schedule background task
const taskId = await BackgroundTask.beforeExit(async () => {
  // Sync payment status
  await syncPaymentStatus();
  
  // Finish task
  BackgroundTask.finish({ taskId });
});
```

### 5. Haptic Feedback

```typescript
import { triggerHapticFeedback } from '@/lib/capacitor';

// On payment success
await triggerHapticNotification('SUCCESS');

// On button press
await triggerHapticFeedback();
```

## Building for Production

### iOS App Store

#### 1. Configure Signing

In Xcode:
1. Select project → Signing & Capabilities
2. Select your Team
3. Enable Automatic Signing

#### 2. Create App Store Connect Record

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
2. Create new app
3. Bundle ID: `com.stellarsolargrid.app`
4. Fill app information

#### 3. Build Archive

```bash
# Ensure production config
npm run build

# Sync to iOS
npm run capacitor:sync:ios

# Open Xcode
npm run capacitor:open:ios
```

In Xcode:
1. Product → Archive
2. Distribute App → App Store Connect
3. Upload

#### 4. Submit for Review

In App Store Connect:
1. Complete app information
2. Upload screenshots
3. Submit for review

### Android Play Store

#### 1. Generate Signing Key

```bash
keytool -genkey -v -keystore stellar-solar-grid.keystore \
  -alias stellar-solar-grid -keyalg RSA -keysize 2048 -validity 10000
```

Store keystore securely!

#### 2. Configure Signing

Update `android/app/build.gradle`:

```gradle
android {
    signingConfigs {
        release {
            storeFile file('../../stellar-solar-grid.keystore')
            storePassword System.getenv('KEYSTORE_PASSWORD')
            keyAlias 'stellar-solar-grid'
            keyPassword System.getenv('KEY_PASSWORD')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

#### 3. Build Release APK/AAB

```bash
# Sync changes
npm run capacitor:sync:android

# Open Android Studio
npm run capacitor:open:android
```

In Android Studio:
1. Build → Generate Signed Bundle/APK
2. Select Android App Bundle (AAB)
3. Select keystore
4. Build release

#### 4. Upload to Play Console

1. Go to [play.google.com/console](https://play.google.com/console)
2. Create new app
3. Upload AAB file
4. Complete store listing
5. Submit for review

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build Mobile Apps

on:
  push:
    branches: [main]
    paths:
      - 'frontend/**'

jobs:
  build-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        working-directory: frontend
        run: npm ci
      
      - name: Build Next.js
        working-directory: frontend
        run: npm run build
      
      - name: Sync Capacitor
        working-directory: frontend
        run: npx cap sync ios
      
      - name: Build iOS app
        working-directory: frontend/ios/App
        run: xcodebuild -workspace App.xcworkspace -scheme App -configuration Release

  build-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'
      
      - name: Install dependencies
        working-directory: frontend
        run: npm ci
      
      - name: Build Next.js
        working-directory: frontend
        run: npm run build
      
      - name: Sync Capacitor
        working-directory: frontend
        run: npx cap sync android
      
      - name: Build Android app
        working-directory: frontend/android
        run: ./gradlew assembleRelease
```

## Troubleshooting

### iOS Build Errors

**Error: Pod install failed**
```bash
cd ios/App
pod repo update
pod install --repo-update
```

**Error: Code signing**
- Ensure Apple Developer account is active
- Check Bundle ID matches
- Verify provisioning profile

### Android Build Errors

**Error: SDK not found**
- Open Android Studio
- Tools → SDK Manager → Install required SDKs

**Error: Gradle build failed**
```bash
cd android
./gradlew clean
./gradlew build
```

### App Crashes on Launch

1. Check `capacitor.config.ts` is correct
2. Verify `webDir: 'out'` matches Next.js output
3. Check console logs in Xcode/Android Studio
4. Ensure all required permissions in Info.plist/AndroidManifest.xml

## Performance Optimization

### 1. Enable Hermes (Android)

In `android/app/build.gradle`:

```gradle
project.ext.react = [
    enableHermes: true,
]
```

### 2. Optimize Bundle Size

```bash
# Analyze bundle
npm run build -- --analyze

# Remove unused dependencies
npm prune
```

### 3. Enable Caching

Service worker for offline support:

```typescript
// public/service-worker.js
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('v1').then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        // Add critical assets
      ]);
    })
  );
});
```

## Testing

### Unit Tests

```bash
npm test
```

### E2E Tests

Use Appium or Detox for cross-platform mobile testing.

### Beta Testing

- **iOS**: TestFlight
- **Android**: Internal testing track in Play Console

## Resources

- [Capacitor Documentation](https://capacitorjs.com/docs)
- [Next.js Static Export](https://nextjs.org/docs/app/building-your-application/deploying/static-exports)
- [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging)
- [App Store Connect](https://developer.apple.com/app-store-connect/)
- [Google Play Console](https://play.google.com/console)

## Support

For issues specific to Stellar Solar Grid mobile app:
1. Check this documentation
2. Search existing GitHub issues
3. Create new issue with logs from Xcode/Android Studio
