const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

function adminHeaders(): Record<string, string> {
  const token = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("admin_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface AllowlistResponse {
  data: string[];
  total: number;
  page: number;
  limit: number;
}

export async function getAllowlist(page = 1, limit = 50): Promise<AllowlistResponse> {
  const res = await fetch(`${BACKEND_URL}/api/allowlist?page=${page}&limit=${limit}`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch allowlist: ${res.statusText}`);
  return res.json();
}

export async function addToAllowlist(address: string): Promise<{ hash: string }> {
  const res = await fetch(`${BACKEND_URL}/api/allowlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to add address to allowlist");
  }
  return res.json();
}

export async function removeFromAllowlist(address: string): Promise<{ hash: string }> {
  const res = await fetch(`${BACKEND_URL}/api/allowlist`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to remove address from allowlist");
  }
  return res.json();
}
