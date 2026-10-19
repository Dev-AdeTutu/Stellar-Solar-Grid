import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { env } from "@/lib/env";

const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;

export interface PaymentRecord {
  txHash: string;
  date: string;
  meterId: string;
  amountXlm: number;
  plan: string;
  status: "Completed" | "Pending" | "Failed";
  /** Optional free-text note attached to the payment (Issue #766). */
  memo?: string;
  /** Opaque cursor identifying this record for pagination (Issue #767). */
  cursor: string;
}

export interface PaymentHistoryResponse {
  payments: PaymentRecord[];
  pagination: {
    limit: number;
    count: number;
    hasMore: boolean;
    /** Pass as `cursor` to fetch the next page; null when there isn't one. */
    nextCursor: string | null;
  };
}

/** Lifecycle state of an installment plan (Issue #987). */
export type InstallmentPlanStatus =
  | "active"
  | "completed"
  | "defaulted"
  | "cancelled";

/** A single scheduled installment within a plan (Issue #987). */
export interface InstallmentScheduleEntry {
  /** 1-based index of this installment within the plan. */
  index: number;
  /** Amount due for this installment, in stroops. */
  amount: string;
  /** Unix timestamp (seconds) at which this installment becomes due. */
  dueAt: number;
  /** Unix timestamp (seconds) after which a missed payment defaults. */
  graceUntil: number;
  paid: boolean;
  paidAt?: number;
  txHash?: string;
}

/** An installment payment plan for a meter purchase or upgrade (Issue #987). */
export interface InstallmentPlan {
  planId: string;
  id?: string;
  meterId: string;
  payer: string;
  /** Total amount financed, in stroops. */
  total: string;
  /** Amount paid so far, in stroops. */
  paid: string;
  /** Amount still outstanding, in stroops. */
  remaining: string;
  /** Number of installments the total is split into. */
  installments: number;
  /** Grace period after each due date before default, in seconds. */
  graceSecs: number;
  status: InstallmentPlanStatus;
  schedule: InstallmentScheduleEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateInstallmentPlanRequest {
  meterId?: string;
  walletAddress?: string | null;
  payer?: string;
  total: string | number;
  installments: number;
  graceSecs?: number;
}

export interface ProcessDueInstallmentsResponse {
  processed: number;
  paid: string[];
  defaulted: string[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Creates a new installment plan for a meter purchase or upgrade (Issue #987). */
export async function createInstallmentPlan(
  params: CreateInstallmentPlanRequest,
): Promise<InstallmentPlan> {
  return requestJson<InstallmentPlan>(`${BACKEND_URL}/api/installments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/** Fetches a single installment plan by id (Issue #987). */
export async function getInstallmentPlan(
  planId: string,
): Promise<InstallmentPlan> {
  return requestJson<InstallmentPlan>(
    `${BACKEND_URL}/api/installments/${encodeURIComponent(planId)}`,
  );
}

/** Lists all installment plans belonging to a payer (Issue #987). */
export async function getPayerInstallments(
  address: string,
): Promise<InstallmentPlan[]> {
  return requestJson<InstallmentPlan[]>(
    `${BACKEND_URL}/api/installments/payer/${encodeURIComponent(address)}`,
  );
}

/** Pays the next due installment on a plan (Issue #987). */
export async function payInstallment(planId: string): Promise<InstallmentPlan> {
  return requestJson<InstallmentPlan>(
    `${BACKEND_URL}/api/installments/${encodeURIComponent(planId)}/pay`,
    { method: "POST" },
  );
}

/** Triggers automatic deduction processing for the given plans (Issue #987). */
export async function processDueInstallments(
  planIds: string[],
): Promise<ProcessDueInstallmentsResponse> {
  return requestJson<ProcessDueInstallmentsResponse>(
    `${BACKEND_URL}/api/installments/process`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planIds }),
    },
  );
}

/**
 * Fetches a page of payment history using cursor-based pagination.
 *
 * Issue #767: offset pagination (`page`/`total`) duplicated or dropped
 * records whenever a payment was inserted between two page requests, because
 * the "offset" a later page skipped was computed against a numeric position
 * that could shift out from under it. Passing the previous page's
 * `nextCursor` instead anchors each request to a specific, stable record.
 */
export interface PaymentHistoryFilters {
  from?: string; to?: string; min?: string; max?: string; plan?: string; status?: string; q?: string;
}

export async function getPaymentHistory(
  address: string,
  cursor?: string,
  limit = 10,
  sort: "asc" | "desc" = "desc",
  filters: PaymentHistoryFilters = {},
): Promise<PaymentHistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit), sort });
  if (cursor) params.set("cursor", cursor);
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const url = `${BACKEND_URL}/api/payments/${address}?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
