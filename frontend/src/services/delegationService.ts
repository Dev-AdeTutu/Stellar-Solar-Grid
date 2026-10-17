export type DelegatePermission = "view" | "pay" | "admin" | string;

export type Delegate = {
  delegated_address: string;
  address?: string;
  permissions: DelegatePermission[];
  expiry: number;
  expiresAt?: number;
};

export async function getDelegates(meterId: string): Promise<Delegate[]> {
  try {
    const res = await fetch(`/api/delegates/${encodeURIComponent(meterId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.delegates ?? [];
  } catch {
    return [];
  }
}

export async function addDelegate(
  meterId: string,
  address: string,
  permissions: DelegatePermission[],
  expiry: number,
): Promise<void> {
  const res = await fetch(`/api/delegates/${encodeURIComponent(meterId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delegate: address, permissions, expiry }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to add delegate");
  }
}

export async function removeDelegate(meterId: string, delegateAddress: string): Promise<void> {
  const res = await fetch(
    `/api/delegates/${encodeURIComponent(meterId)}/${encodeURIComponent(delegateAddress)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to remove delegate");
  }
}
