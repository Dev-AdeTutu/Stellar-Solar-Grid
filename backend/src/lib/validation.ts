import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";

const STELLAR_ACCOUNT_REGEX = /^G[A-Z2-7]{55}$/;
const STELLAR_ADDRESS_REGEX = /^[GC][A-Z2-7]{55}$/;

const MeterIdSchema = z
  .string()
  .trim()
  .min(1, "meter_id is required")
  .max(12, "meter_id must be at most 12 characters");

const MeterRouteParamsSchema = z
  .object({
    id: MeterIdSchema,
  })
  .strict();

const PaymentPlanSchema = z.enum(["Daily", "Weekly", "Monthly", "Usage", "UsageBased"]);

export const RegisterMeterSchema = z
  .object({
    meter_id: MeterIdSchema,
    owner: z
      .string()
      .regex(STELLAR_ACCOUNT_REGEX, "Invalid Stellar account address format"),
  })
  .strict();

export const BatchRegisterMetersSchema = z
  .object({
    meters: z
      .array(RegisterMeterSchema)
      .min(1, "meters must contain at least one entry")
      .max(100, "batch size cannot exceed 100 meters"),
  })
  .strict();

export const BulkMeterStatusSchema = z
  .object({
    meter_ids: z
      .array(MeterIdSchema)
      .min(1, "meter_ids must contain at least one entry")
      .max(100, "meter_ids cannot exceed 100 per request"),
  })
  .strict();

export const UsageUpdateSchema = z
  .object({
    units: z
      .number()
      .int("units must be an integer")
      .positive("units must be positive"),
    cost: z
      .number()
      .int("cost must be an integer")
      .positive("cost must be positive"),
    // Issue #731: optional monotonic ordering hints so the bridge can
    // resequence usage events that arrive out-of-order over MQTT. `timestamp`
    // is seconds since Unix epoch; `sequence` is an optional per-meter source
    // counter. When neither is present the message falls back to arrival time.
    timestamp: z.number().int().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
  })
  .strict();

/** MQTT payload schema — extends UsageUpdateSchema with meterId from the topic. */
export const MqttPayloadSchema = UsageUpdateSchema.extend({
  meterId: z.string().min(1),
});

export const MeterNoteSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "text is required")
      .max(1000, "text must be at most 1000 characters"),
  })
  .strict();

export const MakePaymentSchema = z
  .object({
    token_address: z
      .string()
      .regex(STELLAR_ADDRESS_REGEX, "Invalid token_address format"),
    payer: z
      .string()
      .regex(STELLAR_ACCOUNT_REGEX, "Invalid payer address format"),
    amount_stroops: z
      .number()
      .int("amount_stroops must be an integer")
      .positive("amount_stroops must be positive"),
    plan: PaymentPlanSchema,
  })
  .strict();

export const ClientErrorReportSchema = z
  .object({
    message: z.string().trim().min(1, "message is required").max(2000),
    stack: z.string().max(10000).optional(),
    componentStack: z.string().max(10000).optional(),
    url: z.string().max(2000).optional(),
    userAgent: z.string().max(500).optional(),
  })
  .strict();

export const SmsPaymentWebhookSchema = z
  .object({
    meter_id: MeterIdSchema,
    amount_xlm: z
      .number()
      .positive("amount_xlm must be positive")
      .finite("amount_xlm must be a finite number"),
    plan: PaymentPlanSchema.optional().default("Daily"),
  })
  .strict();

/** Locales supported by the voice assistant integration (issue #989). */
export const VOICE_SUPPORTED_LOCALES = [
  "en-US",
  "en-GB",
  "es-ES",
  "fr-FR",
  "pt-BR",
  "sw-KE",
] as const;

export const VoiceLocaleSchema = z.enum(VOICE_SUPPORTED_LOCALES);

export const VoiceParseSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "text is required")
      .max(500, "text must be at most 500 characters"),
    locale: VoiceLocaleSchema,
  })
  .strict();

export const VoicePaymentConfirmSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]+$/, "token must be a hexadecimal string")
      .min(32, "token must be at least 32 characters")
      .max(128, "token must be at most 128 characters"),
    pin: z
      .string()
      .trim()
      .min(4, "pin must be at least 4 characters")
      .max(10, "pin must be at most 10 characters"),
  })
  .strict();

export const VoicePaymentCancelSchema = z
  .object({
    token: z.string().trim().min(1, "token is required"),
  })
  .strict();

/**
 * Issue #1064: Regulatory sandbox mode.
 *
 * Sandbox inputs are validated with their own schema set so that experimental
 * payloads can never be coerced into production request shapes. Feature flag
 * keys are restricted to a conservative identifier alphabet to prevent
 * prototype-pollution style keys (`__proto__`, `constructor`, ...).
 */
const SANDBOX_FLAG_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;

export const SandboxFlagKeySchema = z
  .string()
  .trim()
  .regex(SANDBOX_FLAG_KEY_REGEX, "invalid feature flag key");

export const SandboxFeatureFlagToggleSchema = z
  .object({
    flag: SandboxFlagKeySchema,
    enabled: z.boolean(),
    // Optional free-form reason recorded in the sandbox audit trail.
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const SandboxFeatureFlagBulkToggleSchema = z
  .object({
    flags: z
      .array(SandboxFeatureFlagToggleSchema)
      .min(1, "flags must contain at least one entry")
      .max(50, "cannot toggle more than 50 flags per request"),
  })
  .strict();

export const SandboxSyntheticDataRequestSchema = z
  .object({
    // Number of synthetic meters to generate.
    meters: z
      .number()
      .int("meters must be an integer")
      .min(1, "meters must be at least 1")
      .max(500, "meters cannot exceed 500 per request"),
    // Number of synthetic usage events per meter.
    usage_events_per_meter: z
      .number()
      .int("usage_events_per_meter must be an integer")
      .min(0, "usage_events_per_meter cannot be negative")
      .max(1000, "usage_events_per_meter cannot exceed 1000"),
    // Deterministic seed so generated fixtures are reproducible in tests.
    seed: z.number().int().nonnegative().optional(),
    // Optional locale hint for generated human-readable labels.
    locale: VoiceLocaleSchema.optional(),
  })
  .strict();

export const SandboxPromotionRequestSchema = z
  .object({
    // Feature flags to promote from sandbox to production.
    flags: z
      .array(SandboxFlagKeySchema)
      .min(1, "flags must contain at least one entry")
      .max(50, "cannot promote more than 50 flags per request"),
    // Explicit acknowledgement that promotion affects production compliance.
    acknowledge_production_impact: z.literal(true, {
      errorMap: () => ({
        message: "acknowledge_production_impact must be true to promote",
      }),
    }),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

type RequestSchemaSet = {
======
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
};

export function validateRequest(schemas: RequestSchemaSet): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const details: Record<string, unknown> = {};

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (!parsed.success) {
        details.body = parsed.error.flatten().fieldErrors;
      } else {
        req.body = parsed.data as typeof req.body;
      }
    }

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (!parsed.success) {
        details.params = parsed.error.flatten().fieldErrors;
      } else {
        req.params = parsed.data as typeof req.params;
      }
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      if (!parsed.success) {
        details.query = parsed.error.flatten().fieldErrors;
      } else {
        req.query = parsed.data as typeof req.query;
      }
    }

    if (Object.keys(details).length > 0) {
      return res.status(400).json({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details,
      });
    }

    next();
  };
}

export { MeterRouteParamsSchema };

export type RegisterMeterInput = z.infer<typeof RegisterMeterSchema>;
export type UsageUpdateInput = z.infer<typeof UsageUpdateSchema>;
export type MakePaymentInput = z.infer<typeof MakePaymentSchema>;
export type MeterNoteInput = z.infer<typeof MeterNoteSchema>;
export type VoiceParseInput = z.infer<typeof VoiceParseSchema>;
export type VoicePaymentConfirmInput = z.infer<typeof VoicePaymentConfirmSchema>;
export type VoicePaymentCancelInput = z.infer<typeof VoicePaymentCancelSchema>;
export type SandboxFeatureFlagToggleInput = z.infer<
  typeof SandboxFeatureFlagToggleSchema
>;
export type SandboxFeatureFlagBulkToggleInput = z.infer<
  typeof SandboxFeatureFlagBulkToggleSchema
>;
export type SandboxSyntheticDataRequestInput = z.infer<
  typeof SandboxSyntheticDataRequestSchema
>;
export type SandboxPromotionRequestInput = z.infer<
  typeof SandboxPromotionRequestSchema
>;
