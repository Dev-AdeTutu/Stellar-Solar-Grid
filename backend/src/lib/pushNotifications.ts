import webpush, { PushSubscription } from "web-push";
import { logger } from "./logger.js";
import {
  deletePushSubscriptionByEndpoint,
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

export async function sendLowBalanceNotification(input: LowBalanceNotificationInput): Promise<void> {
  if (!pushConfigured) {
    return;
  }

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
