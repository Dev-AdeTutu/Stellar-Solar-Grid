import type { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Stellar Solar Grid",
  slug: "stellar-solar-grid",
  scheme: "stellarsolargrid",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  ios: {
    ...config.ios,
    supportsTablet: true,
    bundleIdentifier: "com.stellarsolargrid.app",
    infoPlist: {
      ...config.ios?.infoPlist,
      NSFaceIDUsageDescription: "Use Face ID to unlock your Solar Grid dashboard.",
    },
  },
  android: {
    ...config.android,
    package: "com.stellarsolargrid.app",
    permissions: [...(config.android?.permissions ?? []), "USE_BIOMETRIC", "USE_FINGERPRINT", "POST_NOTIFICATIONS"],
  },
  plugins: [
    "expo-local-authentication",
    ["expo-secure-store", { faceIDPermission: "Allow Solar Grid to protect your account address." }],
    ["expo-notifications", { color: "#d4f05a", defaultChannel: "energy-updates" }],
  ],
  extra: {
    ...config.extra,
    backendUrl: process.env.EXPO_PUBLIC_BACKEND_URL,
    webAppUrl: process.env.EXPO_PUBLIC_WEB_APP_URL,
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});