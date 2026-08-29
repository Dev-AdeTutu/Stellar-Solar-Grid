# Mobile App Documentation

## Overview

The Stellar Solar Grid mobile app provides native iOS and Android applications built with Capacitor, wrapping the existing React/Next.js frontend.

### Features

- **Native Performance**: Optimized for mobile devices
- **Push Notifications**: Receive payment reminders even when app is closed
- **Offline Support**: View balances and history without connection
- **Biometric Auth**: Secure payments with fingerprint/Face ID
- **Background Sync**: Automatic payment status updates
- **Secure Storage**: Private keys stored in device keychain
- **Haptic Feedback**: Tactile response for actions
- **Native Sharing**: Share payment receipts and QR codes

## Architecture

```
frontend/
├── out/                      # Next.js static export (Capacitor webDir)
├── ios/                      # iOS native project
├── android/                  # Android native project
├── capacitor.config.ts       # Capacitor configuration
├── next.config.mobile.js     # Next.js mobile build config
└── src/
    └── lib/
        └── capacitor.ts      # Capacitor utilities
```

### Technology Stack

- **Framework**: Capacitor 6.0
- **Frontend**: Next.js 14 (static export)
- **UI**: React 18 + Tailwind CSS
- **State**: Zustand
- **Notifications**: Firebase Cloud Messaging
- **Auth**: Capacitor Biometric Auth plugin
- **Storage**: Capacitor Preferences (secure keychain)

## Platform-Specific Features

### iOS

- **Minimum Version**: iOS 13.0+
- **Biometrics**: Touch ID / Face ID
- **Notifications**: APNs (Apple Push Notification service)
- **Distribution**: App Store

### Android

- **Minimum Version**: Android 6.0 (API 23)+
- **Biometrics**: Fingerprint / Face unlock
- **Notifications**: FCM (Firebase Cloud Messaging)
- **Distribution**: Google Play Store

## Key Capabilities

### 1. Push Notifications

Send low-balance alerts, payment confirmations, and energy updates directly to user's device.

**Backend Integration**:

```typescript
// Send notification via FCM
await admin.messaging().send({
  token: userDeviceToken,
  notification: {
    title: 'Low Balance Alert',
    body: 'Your meter balance is below 100 XLM',
  },
  data: {
    meterId: 'METER_123',
    action: 'top_up',
  },
});
```

**Frontend Handling**:

```typescript
import { addPushNotificationListener } from '@/lib/capacitor';

// Handle notification tap
addPushNotificationListener((notification) => {
  if (notification.data.action === 'top_up') {
    router.push(`/meters/${notification.data.meterId}/payment`);
  }
});
```

### 2. Biometric Authentication

Secure sensitive operations with device biometrics.

```typescript
import { BiometricAuth } from '@capawesome/capacitor-biometric-auth';

// Before payment
const result = await BiometricAuth.authenticate({
  reason: 'Confirm payment of 50 XLM',
});

if (result.isAuthenticated) {
  // Process payment
}
```

### 3. Secure Key Storage

Store Stellar private keys in device's secure enclave/keystore.

```typescript
import { setSecureValue, getSecureValue } from '@/lib/capacitor';

// Store private key
await setSecureValue('stellar_secret_key', secretKey);

// Retrieve when needed
const key = await getSecureValue('stellar_secret_key');
```

**Security**:
- iOS: Keys stored in Keychain with kSecAttrAccessibleWhenUnlockedThisDeviceOnly
- Android: Keys stored in EncryptedSharedPreferences backed by Android Keystore

### 4. Offline Support

Cache critical data for offline access.

```typescript
// Service worker caches API responses
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
```

User can view:
- Last known balance
- Recent payment history
- Meter status

Queued actions sync when online.

### 5. Background Sync

Periodically sync payment status even when app is backgrounded.

```typescript
import { BackgroundTask } from '@capawesome/capacitor-background-task';

const taskId = await BackgroundTask.beforeExit(async () => {
  await syncPaymentStatus();
  await updateMeterBalance();
  BackgroundTask.finish({ taskId });
});
```

**Limitations**:
- iOS: ~30 seconds background time
- Android: Can schedule WorkManager tasks for longer sync

## Development

### Quick Start

```bash
cd frontend

# Install dependencies
npm install

# Setup mobile (installs Capacitor, adds platforms)
chmod +x scripts/setup-mobile.sh
./scripts/setup-mobile.sh

# Build and sync
npm run build
npm run capacitor:sync

# Open in IDE
npm run capacitor:open:ios      # Xcode
npm run capacitor:open:android  # Android Studio
```

### Live Reload

Point Capacitor to your dev server for hot reload:

```typescript
// capacitor.config.ts (development only)
server: {
  url: 'http://192.168.1.100:3000',
  cleartext: true,
}
```

Start dev server and run app on device.

### Testing

```bash
# Unit tests
npm test

# E2E tests (requires Appium)
npm run test:e2e:ios
npm run test:e2e:android
```

## Deployment

### iOS App Store

1. **Configure**:
   - Xcode → Signing & Capabilities → Select Team
   - Set Bundle ID: `com.stellarsolargrid.app`

2. **Build Archive**:
   ```bash
   npm run build
   npm run capacitor:sync:ios
   npm run capacitor:open:ios
   ```
   
   In Xcode: Product → Archive

3. **Upload**:
   - Distribute App → App Store Connect
   - Upload archive

4. **Submit**:
   - App Store Connect → Complete metadata
   - Submit for review

### Google Play Store

1. **Generate Keystore**:
   ```bash
   keytool -genkey -v -keystore stellar-solar-grid.keystore \
     -alias stellar-solar-grid -keyalg RSA -keysize 2048 -validity 10000
   ```

2. **Build AAB**:
   ```bash
   npm run build
   npm run capacitor:sync:android
   npm run capacitor:open:android
   ```
   
   In Android Studio: Build → Generate Signed Bundle

3. **Upload**:
   - Play Console → Create app
   - Upload AAB

4. **Submit**:
   - Complete store listing
   - Submit for review

## Monitoring

### Analytics

```typescript
import { CapacitorApp } from '@capacitor/app';

CapacitorApp.addListener('appStateChange', ({ isActive }) => {
  // Track app opens
  if (isActive) {
    analytics.logEvent('app_opened');
  }
});
```

### Crash Reporting

Integrate Sentry or Firebase Crashlytics:

```typescript
import * as Sentry from '@sentry/capacitor';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: 'mobile',
});
```

### Performance

```typescript
import { performance } from '@capacitor/app';

// Measure critical paths
const start = performance.now();
await loadMeterData();
const duration = performance.now() - start;

analytics.logEvent('meter_load_time', { duration });
```

## Best Practices

### 1. Platform Detection

Always check platform before using native features:

```typescript
import { isNativePlatform } from '@/lib/capacitor';

if (isNativePlatform()) {
  // Use native feature
} else {
  // Fallback for web
}
```

### 2. Error Handling

Gracefully handle missing permissions:

```typescript
try {
  await requestPushPermissions();
} catch (error) {
  // Show user-friendly message
  showToast('Push notifications require permission');
}
```

### 3. Network Awareness

Check connectivity before API calls:

```typescript
import { getNetworkStatus } from '@/lib/capacitor';

const status = await getNetworkStatus();
if (!status.connected) {
  showOfflineMessage();
  return;
}

await makeAPICall();
```

### 4. Battery Optimization

Minimize background tasks:

```typescript
// Only sync critical data
if (isBackground && batteryLevel < 20) {
  skipNonCriticalSync();
}
```

## Troubleshooting

### Common Issues

**iOS: Code signing errors**
- Verify Apple Developer account
- Check Bundle ID matches provisioning profile
- Try: Xcode → Preferences → Accounts → Download Manual Profiles

**Android: Gradle build failed**
```bash
cd android
./gradlew clean
./gradlew build --stacktrace
```

**App crashes on launch**
- Check `capacitor.config.ts` webDir matches build output
- Verify all required permissions in Info.plist/AndroidManifest.xml
- Check device logs in Xcode/Android Studio

**Push notifications not working**
- Verify Firebase configuration files present
- iOS: Check APNs certificate in Firebase Console
- Android: Verify google-services.json package name matches

## Future Enhancements

### Phase 2 Roadmap

- [ ] Widgets (iOS 14+, Android 12+)
- [ ] Apple Watch / Wear OS companion apps
- [ ] Shortcuts / Siri integration
- [ ] NFC payments (tap-to-pay)
- [ ] Augmented Reality meter scanning
- [ ] Voice commands
- [ ] CarPlay / Android Auto support

### Performance Goals

- [ ] App size < 50MB
- [ ] Startup time < 2 seconds
- [ ] 60 FPS animations
- [ ] Battery usage < 5%/hour (background)

## Resources

- [Setup Guide](../MOBILE_APP_SETUP.md)
- [Capacitor Docs](https://capacitorjs.com/docs)
- [Firebase Setup](https://firebase.google.com/docs/cloud-messaging)
- [App Store Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Play Store Policies](https://play.google.com/about/developer-content-policy/)

## Support

For mobile-specific issues:
1. Check device logs (Xcode/Android Studio)
2. Review [MOBILE_APP_SETUP.md](../MOBILE_APP_SETUP.md)
3. Search GitHub issues with `mobile` label
4. Create issue with platform, OS version, and logs
