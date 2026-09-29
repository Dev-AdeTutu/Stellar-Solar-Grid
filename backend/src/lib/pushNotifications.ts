import webpush, { PushSubscription } from "web-push";
import { logger } from "./logger.js";
import {
  deletePushSubscriptionByEndpoint,
  deleteNativePushSubscription,
  listNativePushSubscriptionsByOwner,
  listPushSubscriptionsByOwner,
  type PushSubscriptionRecord,
} from "./pushSubscriptions.js";

const VAPID_SUBJECT = process.env.WEB_PUSH_VAPID_SUBJECT;
const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;

const pushConfigured = Boolean(VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT!, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
} else {
  logger.warn(
    "Web push not configured. Set WEB_PUSH_VAPID_SUBJECT/WEB_PUSH_VAPID_PUBLIC_KEY/WEB_PUSH_VAPID_PRIVATE_KEY to enable notifications.",
  );
}

type LowBalanceNotificationInput = {
  ownerAddress: string;
  emergencyContactAddress?: string;
  meterId: string;
  balanceStroops: number;
  thresholdStroops: number;
  weeklyTypicalStroops?: number;
};

function toWebPushSubscription(record: PushSubscriptionRecord): PushSubscription {
  return {
    endpoint: record.endpoint,
    keys: {
      p256dh: record.p256dh,
      auth: record.auth,
    },
  };
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY ?? null;
}

export function isPushConfigured(): boolean {
  return pushConfigured;
}

async function sendNativePush(ownerAddresses: string[], notification: { title: string; body: string; data: Record<string, unknown> }): Promise<void> {
  const tokens = [...new Set(ownerAddresses.flatMap((address) =>
    listNativePushSubscriptionsByOwner(address).map((subscription) => subscription.token),
  ))];
  for (let offset = 0; offset < tokens.length; offset += 100) {
    const chunk = tokens.slice(offset, offset + 100);
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(chunk.map((to) => ({ to, ...notification, sound: "default" }))),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, tokenCount: chunk.length }, "Expo push request failed");
        continue;
      }
      const result = await response.json() as { data?: Array<{ status?: string; details?: { error?: string } }> };
      for (const [index, ticket] of (result.data ?? []).entries()) {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          deleteNativePushSubscription(chunk[index]);
        }
      }
    } catch (err) {
      logger.warn({ err, tokenCount: chunk.length }, "Expo push delivery failed");
    }
  }
}

export async function sendLowBalanceNotification(input: LowBalanceNotificationInput): Promise<void> {
  const recipients = new Set(
    [input.ownerAddress, input.emergencyContactAddress].filter(
      (address): address is string => Boolean(address),
    ),
  );
  const subscriptions = [...recipients]
    .flatMap((address) => listPushSubscriptionsByOwner(address))
    .filter((record, index, records) => records.findIndex((candidate) => candidate.endpoint === record.endpoint) === index);
  if (subscriptions.length === 0) {
    return;
  }

  const payload = JSON.stringify({
    title: "Low Balance Alert",
    body: input.emergencyContactAddress
      ? "Low balance alert: a designated meter contact may need to top up to avoid interruption."
      : "Low balance: your meter balance is running low. Top up now to avoid interruption.",
    icon: "/icons/push-warning.svg",
    badge: "/icons/push-badge.svg",
    tag: `low-balance-${input.meterId}`,
    data: {
      type: "LOW_BALANCE",
      meterId: input.meterId,
      balanceStroops: input.balanceStroops,
      thresholdStroops: input.thresholdStroops,
      weeklyTypicalStroops: input.weeklyTypicalStroops ?? null,
      topUpPath: "/pay",
    },
    actions: [
      {
        action: "top-up",
        title: "Top Up",
      },
    ],
  });

  await sendNativePush([...recipients], {
    title: "Low Balance Alert",
    body: input.emergencyContactAddress
      ? "A designated meter may need a top up to avoid interruption."
      : "Your meter balance is running low. Top up to avoid interruption.",
    data: { type: "LOW_BALANCE", meterId: input.meterId, topUpPath: "/pay" },
  });

  if (!pushConfigured) return;
  await Promise.all(
    subscriptions.map(async (record) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(record), payload);
      } catch (error: any) {
        const statusCode = error?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deletePushSubscriptionByEndpoint(record.endpoint);
          logger.info({ endpoint: record.endpoint }, "Deleted stale web push subscription");
          return;
        }

        logger.error(
          {
            endpoint: record.endpoint,
            err: error instanceof Error ? error.message : String(error),
          },
          "Failed to send web push notification",
        );
      }
    }),
  );
}

/** Send a generic push notification to every subscription owned by an address. */
export async function sendPushToOwner(
  ownerAddress: string,
  notification: { title: string; body: string; tag: string; url?: string },
): Promise<void> {
  await sendNativePush([ownerAddress], {
    title: notification.title,
    body: notification.body,
    data: { url: notification.url ?? "/dashboard", tag: notification.tag },
  });
  if (!pushConfigured) return;
  const payload = JSON.stringify({
    ...notification,
    icon: "/icons/push-badge.svg",
    data: { url: notification.url ?? "/dashboard" },
  });
  await Promise.all(
    listPushSubscriptionsByOwner(ownerAddress).map(async (record) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(record), payload);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) deletePushSubscriptionByEndpoint(record.endpoint);
        else logger.warn({ err, ownerAddress }, "Push notification failed");
      }
    }),
  );
}
