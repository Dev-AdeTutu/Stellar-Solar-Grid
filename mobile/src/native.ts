import Constants from "expo-constants";
import * as Device from "expo-device";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { api } from "./api";

const OWNER_KEY = "solargrid.owner-address";
const PUSH_TOKEN_KEY = "solargrid.expo-push-token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function readSavedOwner(): Promise<string | null> {
  return SecureStore.getItemAsync(OWNER_KEY);
}

export async function hasNativePushEnabled(): Promise<boolean> {
  return Boolean(await SecureStore.getItemAsync(PUSH_TOKEN_KEY));
}

export async function unlockOwner(ownerAddress: string): Promise<boolean> {
  const capability = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!capability || !enrolled) return false;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock your energy dashboard",
    cancelLabel: "Use another account",
    disableDeviceFallback: false,
  });
  if (!result.success) return false;
  await SecureStore.setItemAsync(OWNER_KEY, ownerAddress);
  return true;
}

export async function registerNativePush(ownerAddress: string): Promise<void> {
  if (!Device.isDevice) throw new Error("Push notifications require a physical device");
  const permission = await Notifications.getPermissionsAsync();
  const granted = permission.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) throw new Error("Notification permission was not granted");

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("energy-updates", {
      name: "Energy updates",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#d4f05a",
    });
  }

  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== "string" || projectId.includes("configure-with")) {
    throw new Error("Configure EAS_PROJECT_ID before registering mobile push");
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api("/api/push/native/subscribe", {
    method: "POST",
    body: JSON.stringify({ ownerAddress, token, platform: Platform.OS }),
  });
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
}

export async function unregisterNativePush(): Promise<void> {
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (!token) return;
  await api("/api/push/native/unsubscribe", { method: "POST", body: JSON.stringify({ token }) });
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
}