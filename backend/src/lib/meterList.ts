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
 * Apply filters before calculating pagination metadata. Keeping this as one
 * operation prevents X-Total-Count from accidentally using the raw contract
 * result while the response body uses a filtered page.
 */
export function buildMeterListPage<T extends Record<string, any>>(
  meters: T[],
  filters: MeterListFilters,
  page: number,
  pageSize: number,
) {
  return paginateMeters(filterMeters(meters, filters), page, pageSize);
}
