import type { RequestHandler } from "express";
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

const PaymentPlanSchema = z.enum(["Daily", "Weekly", "Usage", "UsageBased"]);

export const RegisterMeterSchema = z
  .object({
    meter_id: MeterIdSchema,
    owner: z
      .string()
      .regex(STELLAR_ACCOUNT_REGEX, "Invalid Stellar account address format"),
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

export const SmsPaymentWebhookSchema = z
  .object({
    meter_id: MeterIdSchema,
    amount_xlm: z
      .number()
      .positive("amount_xlm must be positive")
      .finite("amount_xlm must be a finite number"),
  })
  .strict();

type RequestSchemaSet = {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
};

export function validateRequest(schemas: RequestSchemaSet): RequestHandler {
  return (req, res, next) => {
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
