export type MeterListFilters = {
  owner?: unknown;
  active?: unknown;
  status?: unknown;
  plan?: unknown;
  expiresBeforeMs?: number;
};

const PLAN_MAP: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  usage_based: "UsageBased",
};

export function filterMeters<T extends Record<string, any>>(
  meters: T[],
  filters: MeterListFilters,
): T[] {
  let filtered = meters;

  if (filters.owner !== undefined) {
    filtered = filtered.filter((meter) => meter.owner === String(filters.owner));
  }
  if (filters.active !== undefined) {
    const active = filters.active === "true";
    filtered = filtered.filter((meter) => Boolean(meter.active) === active);
  }
  if (filters.status !== undefined) {
    const active = filters.status === "online";
    filtered = filtered.filter((meter) => Boolean(meter.active) === active);
  }
  if (filters.plan !== undefined) {
    const contractPlan = PLAN_MAP[String(filters.plan)];
    filtered = filtered.filter((meter) => meter.plan === contractPlan);
  }
  if (filters.expiresBeforeMs !== undefined) {
    filtered = filtered.filter((meter) => {
      if (!meter.expires_at) return false;
      return Number(meter.expires_at) * 1000 < filters.expiresBeforeMs!;
    });
  }

  return filtered;
}

export function paginateMeters<T>(meters: T[], page: number, pageSize: number) {
  const total = meters.length;
  const start = (page - 1) * pageSize;
  return {
    meters: meters.slice(start, start + pageSize),
    total,
    pages: Math.ceil(total / pageSize),
  };
}

/**
 * Parse `page` and `pageSize` for GET /api/meters. `limit` is accepted as an
 * alias for `pageSize` (as on /api/meters/search); `pageSize` wins if both are
 * supplied. Page size is clamped to 1..100 and defaults to 25.
 */
export function parseMeterPagination(query: { page?: unknown; pageSize?: unknown; limit?: unknown }) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? query.limit ?? 25) || 25));
  return { page, pageSize };
}
