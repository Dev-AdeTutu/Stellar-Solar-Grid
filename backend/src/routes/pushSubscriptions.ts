import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  deletePushSubscriptionByEndpoint,
  upsertPushSubscription,
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

export { pushSubscriptionsRouter };
