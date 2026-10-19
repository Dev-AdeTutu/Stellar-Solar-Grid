import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  deletePushSubscriptionByEndpoint,
  deleteNativePushSubscription,
  upsertPushSubscription,
  upsertNativePushSubscription,
} from "../lib/pushSubscriptions.js";
import { getVapidPublicKey, isPushConfigured } from "../lib/pushNotifications.js";

const pushSubscriptionsRouter = Router();

const SubscriptionSchema = z.object({
  ownerAddress: z
    .string()
    .trim()
    .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar owner address"),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const NativeSubscriptionSchema = z.object({
  ownerAddress: z.string().trim().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar owner address"),
  token: z.string().min(20).max(256).regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/, "Invalid Expo push token"),
  platform: z.enum(["ios", "android"]),
});

const NativeUnsubscribeSchema = z.object({
  token: z.string().min(20).max(256).regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/),
});

pushSubscriptionsRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: isPushConfigured(),
      vapidPublicKey: getVapidPublicKey(),
    });
  }),
);

pushSubscriptionsRouter.post(
  "/subscribe",
  asyncHandler(async (req, res) => {
    const parsed = SubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid subscription payload",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { ownerAddress, subscription } = parsed.data;
    upsertPushSubscription({
      ownerAddress,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });

    return res.status(201).json({ ok: true });
  }),
);

pushSubscriptionsRouter.post(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const parsed = UnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid unsubscribe payload",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    deletePushSubscriptionByEndpoint(parsed.data.endpoint);
    return res.json({ ok: true });
  }),
);

pushSubscriptionsRouter.post("/native/subscribe", (req, res) => {
  const parsed = NativeSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid native subscription payload", details: parsed.error.flatten().fieldErrors });
  }
  upsertNativePushSubscription(parsed.data);
  return res.status(201).json({ ok: true });
});

pushSubscriptionsRouter.post("/native/unsubscribe", (req, res) => {
  const parsed = NativeUnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid native token" });
  deleteNativePushSubscription(parsed.data.token);
  return res.json({ ok: true });
});

export { pushSubscriptionsRouter };
