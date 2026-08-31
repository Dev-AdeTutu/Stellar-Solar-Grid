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

type RequestSchemaSet = {
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
