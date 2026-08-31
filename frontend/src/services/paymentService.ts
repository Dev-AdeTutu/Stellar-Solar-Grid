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
