import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { env } from "@/lib/env";

const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;
const STORAGE_KEY = "solargrid_push_subscription";
const PERMISSION_PROMPT_KEY = "solargrid_push_permission_prompted";

type PushConfigResponse = {
  enabled: boolean;
  vapidPublicKey: string | null;
};

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function base64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64Safe);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getPushConfig(): Promise<PushConfigResponse> {
  const res = await fetchWithTimeout(`${BACKEND_URL}/api/push/config`);
  if (!res.ok) {
    throw new Error(`Push config request failed: ${res.status}`);
  }
  return res.json();
}

export async function setupLowBalancePushNotifications(ownerAddress: string): Promise<void> {
  if (!ownerAddress || !isPushSupported()) {
    return;
  }

  if (Notification.permission !== "granted") {
    return;
  }

  const config = await getPushConfig();
  if (!config.enabled || !config.vapidPublicKey) {
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  const existingSubscription = await registration.pushManager.getSubscription();

  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64ToUint8Array(config.vapidPublicKey) as unknown as BufferSource,
    }));

  const existingEndpoint = window.localStorage.getItem(STORAGE_KEY);
  if (existingEndpoint && existingEndpoint === subscription.endpoint) {
    return;
  }

  const res = await fetchWithTimeout(`${BACKEND_URL}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ownerAddress,
      subscription,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to save push subscription: ${res.status}`);
  }

  window.localStorage.setItem(STORAGE_KEY, subscription.endpoint);
}

export async function requestPushPermissionOnFirstDashboardVisit(): Promise<void> {
  if (!isPushSupported()) {
    return;
  }

  if (window.localStorage.getItem(PERMISSION_PROMPT_KEY)) {
    return;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  window.localStorage.setItem(PERMISSION_PROMPT_KEY, "1");
}
