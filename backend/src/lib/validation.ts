import { z } from "zod";

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const RegisterMeterSchema = z.object({
  meter_id: z.string().min(1, "meter_id is required").max(32, "meter_id must be at most 32 characters"),
  owner: z.string().regex(STELLAR_ADDRESS_REGEX, "Invalid Stellar address format"),
});

export const UsageUpdateSchema = z.object({
  units: z.number().int("units must be an integer").positive("units must be positive"),
  cost: z.number().int("cost must be an integer").positive("cost must be positive"),
});

export const MakePaymentSchema = z.object({
  token_address: z.string().regex(STELLAR_ADDRESS_REGEX, "Invalid token_address format"),
  payer: z.string().regex(STELLAR_ADDRESS_REGEX, "Invalid payer address format"),
  amount_stroops: z.number().int("amount_stroops must be an integer").positive("amount_stroops must be positive"),
  plan: z.string().min(1, "plan is required"),
});

export type RegisterMeterInput = z.infer<typeof RegisterMeterSchema>;
export type UsageUpdateInput = z.infer<typeof UsageUpdateSchema>;
export type MakePaymentInput = z.infer<typeof MakePaymentSchema>;
