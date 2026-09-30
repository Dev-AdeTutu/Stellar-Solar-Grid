# Stellar Solar Grid Mobile

Standalone React Native application built with Expo for iOS and Android. The
mobile package is separate from the Next.js web app so native APIs do not leak
into the web bundle.

## Features

- Owner meter list, live balance/status, low-balance indication and recent usage.
- Wallet tab with a public-address view and a top-up handoff to the existing
  web wallet flow. Signing remains in the wallet; the mobile app never asks for
  or stores a Stellar secret key.
- Local biometric unlock using Face ID, Touch ID or Android biometrics. This
  protects the saved dashboard address on the device; it is not a replacement
  for wallet signature authorization.
- Native Expo push registration. Low-balance alerts are delivered through the
  Expo Push Service from the backend.

## Local Development

```sh
cd mobile
npm install
cp .env.example .env
# Set EXPO_PUBLIC_BACKEND_URL and EXPO_PUBLIC_WEB_APP_URL in .env.
npm start
```

Use a physical device for push registration. Push requires an EAS project and
its project ID in `EAS_PROJECT_ID`. Biometrics require a physical device with
biometric hardware enrolled. Android emulator networking may need the host
gateway instead of `localhost` for the backend URL.

## Native Builds

Install EAS CLI and authenticate to the project owner, then configure an Expo
project and set its project ID in `EAS_PROJECT_ID`/the build environment. For local
native builds use `npm run android` or `npm run ios` (iOS requires macOS and
Xcode). Production builds use EAS Build after Apple signing credentials and the
Android application signing key are configured. Submit the resulting builds
through App Store Connect and Google Play Console after completing store
metadata, privacy disclosures, and push-notification configuration.

Publishing and store ratings cannot be completed from this source change: they
require the publisher accounts, signing assets, device QA and store review.

## Push API

The app registers Expo tokens with `POST /api/push/native/subscribe` and removes
them with `POST /api/push/native/unsubscribe`. Tokens are scoped to the supplied
Stellar public address, matching the existing web push subscription model.