const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

export interface PaymentRecord {
  txHash: string;
  date: string;
  meterId: string;
  amountXlm: number;
  plan: string;
}

export interface PaymentHistoryResponse {
  payments: PaymentRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export async function getPaymentHistory(
  address: string,
  page = 1,
  limit = 10,
  sort: "asc" | "desc" = "desc"
): Promise<PaymentHistoryResponse> {
  const url = `${BACKEND_URL}/api/payments/${address}?page=${page}&limit=${limit}&sort=${sort}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
