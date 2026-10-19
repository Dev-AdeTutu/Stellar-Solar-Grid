import { env } from "@/lib/env";

const API_BASE = env.NEXT_PUBLIC_COLLAB_API_URL;

export interface CollaboratorShare {
  address: string;
  basisPoints: number;
}

/**
 * Fetches all collaborators and their shares in a single request.
 * The backend resolves this with one get_all_shares simulation — no N+1.
 */
export async function getCollaborators(): Promise<CollaboratorShare[]> {
  const res = await fetch(`${API_BASE}/collaborators`);
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error ?? "Failed to fetch collaborators");
  }
  const { collaborators } = (await res.json()) as { collaborators: CollaboratorShare[] };
  return collaborators;
}

export async function addCollaborator(address: string, basisPoints: number): Promise<void> {
  const res = await fetch(`${API_BASE}/collaborators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, basis_points: basisPoints }),
  });
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error ?? "Failed to add collaborator");
  }
}

export async function removeCollaborator(address: string): Promise<void> {
  const res = await fetch(`${API_BASE}/collaborators/${address}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error ?? "Failed to remove collaborator");
  }
}

export interface PaymentRecord {
  transactionHash: string;
  date: string;
  meterId: string;
  amount: number;
  paymentPlan: string;
  status: string;
}

export interface PaymentHistoryFilters {
  startDate?: string;
  endDate?: string;
  sortBy?: "date" | "amount" | "status";
  sortOrder?: "asc" | "desc";
}

export interface GridExport {
  id: string;
  meterId: string;
  kwh: number;
  creditAmount: number;
  rate: number;
  timestamp: string;
}

export interface MeterExportHistory {
  exports: GridExport[];
  totalImportedKwh: number;
  totalExportedKwh: number;
  totalCreditAmount: number;
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Fetches the grid export history for a meter along with import/export totals.
 */
export async function getMeterExports(
  meterId: string,
  page = 1,
  pageSize = 20,
): Promise<MeterExportHistory> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  const res = await fetch(`${API_BASE}/meters/${meterId}/exports?${params.toString()}`);
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error ?? "Failed to fetch meter exports");
  }
  return (await res.json()) as MeterExportHistory;
}

export async function getPaymentHistory(filters: PaymentHistoryFilters = {}): Promise<PaymentRecord[]> {
  const params = new URLSearchParams();
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.sortBy) params.set("sortBy", filters.sortBy);
  if (filters.sortOrder) params.set("sortOrder", filters.sortOrder);
  const queryString = params.toString();
  const res = await fetch(`${API_BASE}/payments${queryString ? `?${queryString}` : ""}`);
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error ?? "Failed to fetch payment history");
  }
  const { payments } = (await res.json()) as { payments: PaymentRecord[] };
  return payments;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const { error } = (await res.json()) as { error?: string };
    if (error) message = error;
  } catch {
    // response body was not JSON; keep the fallback message
  }
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Technician portal (work orders)
// ---------------------------------------------------------------------------

export interface WorkOrder {
  id: string;
  techId: string;
  meterId: string;
  type: string;
  status: string;
  notes?: string;
  photoUrl?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreateWorkOrderPayload {
  techId: string;
  meterId: string;
  type: string;
  notes?: string;
}

export async function getWorkOrders(techId: string): Promise<WorkOrder[]> {
  const res = await fetch(`${API_BASE}/work-orders/assigned/${encodeURIComponent(techId)}`);
  if (!res.ok) await parseError(res, "Failed to fetch work orders");
  const { workOrders } = (await res.json()) as { workOrders: WorkOrder[] };
  return workOrders;
}

export async function createWorkOrder(payload: CreateWorkOrderPayload): Promise<WorkOrder> {
  const res = await fetch(`${API_BASE}/work-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await parseError(res, "Failed to create work order");
  const { workOrder } = (await res.json()) as { workOrder: WorkOrder };
  return workOrder;
}

export async function completeWorkOrder(id: string, notes?: string): Promise<WorkOrder> {
  const res = await fetch(`${API_BASE}/work-orders/${encodeURIComponent(id)}/complete`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) await parseError(res, "Failed to complete work order");
  const { workOrder } = (await res.json()) as { workOrder: WorkOrder };
  return workOrder;
}

export async function uploadWorkOrderPhoto(id: string, file: File): Promise<WorkOrder> {
  const formData = new FormData();
  formData.append("photo", file);
  const res = await fetch(`${API_BASE}/work-orders/${encodeURIComponent(id)}/photo`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) await parseError(res, "Failed to upload work order photo");
  const { workOrder } = (await res.json()) as { workOrder: WorkOrder };
  return workOrder;
}

// ---------------------------------------------------------------------------
// Customer satisfaction surveys
// ---------------------------------------------------------------------------

export interface Survey {
  id: string;
  title: string;
  question: string;
  createdAt: string;
}

export interface CreateSurveyPayload {
  title: string;
  question: string;
  audience?: string;
}

export interface SurveyAnalytics {
  nps: number;
  averageScore: number;
  responseCount: number;
  promoters: number;
  passives: number;
  detractors: number;
}

export async function getSurveys(): Promise<Survey[]> {
  const res = await fetch(`${API_BASE}/surveys`);
  if (!res.ok) await parseError(res, "Failed to fetch surveys");
  const { surveys } = (await res.json()) as { surveys: Survey[] };
  return surveys;
}

export async function createSurvey(payload: CreateSurveyPayload): Promise<Survey> {
  const res = await fetch(`${API_BASE}/surveys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await parseError(res, "Failed to create survey");
  const { survey } = (await res.json()) as { survey: Survey };
  return survey;
}

export async function submitSurveyResponse(
  id: string,
  score: number,
  comment?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/surveys/${encodeURIComponent(id)}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score, comment }),
  });
  if (!res.ok) await parseError(res, "Failed to submit survey response");
}

export async function getSurveyAnalytics(): Promise<SurveyAnalytics> {
  const res = await fetch(`${API_BASE}/surveys/analytics`);
  if (!res.ok) await parseError(res, "Failed to fetch survey analytics");
  const { analytics } = (await res.json()) as { analytics: SurveyAnalytics };
  return analytics;
}

// ---------------------------------------------------------------------------
// Seasonal pricing
// ---------------------------------------------------------------------------

export interface SeasonalRate {
  season: string;
  startDate: string;
  endDate: string;
  multiplier: number;
}

export interface CurrentSeason {
  season: string;
  multiplier: number;
  startDate: string;
  endDate: string;
}

export interface SeasonalHistoryEntry {
  season: string;
  year: number;
  multiplier: number;
  averageRate: number;
}

export async function getSeasonalRates(): Promise<SeasonalRate[]> {
  const res = await fetch(`${API_BASE}/seasonal-rates`);
  if (!res.ok) await parseError(res, "Failed to fetch seasonal rates");
  const { rates } = (await res.json()) as { rates: SeasonalRate[] };
  return rates;
}

export async function getCurrentSeason(): Promise<CurrentSeason> {
  const res = await fetch(`${API_BASE}/seasonal-rates/current`);
  if (!res.ok) await parseError(res, "Failed to fetch current season");
  const { season } = (await res.json()) as { season: CurrentSeason };
  return season;
}

export async function getSeasonalHistory(years?: number): Promise<SeasonalHistoryEntry[]> {
  const params = new URLSearchParams();
  if (years !== undefined) params.set("years", String(years));
  const queryString = params.toString();
  const res = await fetch(
    `${API_BASE}/seasonal-rates/history${queryString ? `?${queryString}` : ""}`,
  );
  if (!res.ok) await parseError(res, "Failed to fetch seasonal history");
  const { history } = (await res.json()) as { history: SeasonalHistoryEntry[] };
  return history;
}
