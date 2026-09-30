/**
 * Comprehensive admin dashboard API (#880).
 *
 * All routes require admin auth.
 *
 *   GET  /api/admin/dashboard/users              — list users (paginated)
 *   POST /api/admin/dashboard/users/:id/suspend  — suspend a user
 *   POST /api/admin/dashboard/users/:id/unsuspend — unsuspend a user
 *   GET  /api/admin/dashboard/system-health      — live system metrics
 *   GET  /api/admin/dashboard/transactions       — transaction audit log (paginated)
 *   GET  /api/admin/dashboard/analytics          — platform-wide analytics summary
 *   GET  /api/admin/dashboard/roles              — list defined roles
 *   POST /api/admin/dashboard/roles              — create a role
 *   PUT  /api/admin/dashboard/roles/:role/users/:userId — assign role to user
 */
import { Router, Request, Response } from "express";
import os from "node:os";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";

export const adminDashboardRouter = Router();
adminDashboardRouter.use(requireAdminKey);

// ── In-memory user registry ──────────────────────────────────────────────────

type UserStatus = "active" | "suspended";
type UserRecord = {
  id: string;
  walletAddress: string;
  status: UserStatus;
  role: string;
  registeredAt: string;
  lastSeenAt: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
};

type TransactionRecord = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  timestamp: string;
  meterId: string | null;
};

type RoleDefinition = {
  name: string;
  permissions: string[];
  createdAt: string;
};

const users = new Map<string, UserRecord>();
const transactions: TransactionRecord[] = [];
const roles = new Map<string, RoleDefinition>();

// Seed default roles
for (const [name, permissions] of [
  ["admin", ["*"]],
  ["operator", ["meters:read", "meters:write", "users:read", "analytics:read"]],
  ["viewer", ["meters:read", "analytics:read"]],
] as [string, string[]][]) {
  roles.set(name, { name, permissions, createdAt: new Date().toISOString() });
}

let userIdSeq = 1;
let txIdSeq = 1;

export function registerUserForDashboard(walletAddress: string): UserRecord {
  const existing = [...users.values()].find((u) => u.walletAddress === walletAddress);
  if (existing) return existing;
  const id = `user-${userIdSeq++}`;
  const record: UserRecord = {
    id,
    walletAddress,
    status: "active",
    role: "viewer",
    registeredAt: new Date().toISOString(),
    lastSeenAt: null,
    suspendedAt: null,
    suspendReason: null,
  };
  users.set(id, record);
  return record;
}

export function recordTransaction(tx: Omit<TransactionRecord, "id">): TransactionRecord {
  const id = `tx-${txIdSeq++}`;
  const record = { id, ...tx };
  transactions.push(record);
  return record;
}

// ── Routes ──────────────────────────────────────────────────────────────────

adminDashboardRouter.get(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page ?? 20)));
    const status = req.query.status as UserStatus | undefined;
    const role = req.query.role as string | undefined;

    let list = [...users.values()];
    if (status) list = list.filter((u) => u.status === status);
    if (role) list = list.filter((u) => u.role === role);

    const total = list.length;
    const items = list.slice((page - 1) * perPage, page * perPage);
    res.json({ total, page, perPage, users: items });
  }),
);

adminDashboardRouter.post(
  "/users/:id/suspend",
  asyncHandler(async (req: Request, res: Response) => {
    const user = users.get(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.status === "suspended") return res.status(409).json({ error: "User is already suspended" });

    const { reason } = req.body as { reason?: string };
    user.status = "suspended";
    user.suspendedAt = new Date().toISOString();
    user.suspendReason = reason ?? null;
    res.json(user);
  }),
);

adminDashboardRouter.post(
  "/users/:id/unsuspend",
  asyncHandler(async (req: Request, res: Response) => {
    const user = users.get(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.status === "active") return res.status(409).json({ error: "User is not suspended" });

    user.status = "active";
    user.suspendedAt = null;
    user.suspendReason = null;
    res.json(user);
  }),
);

adminDashboardRouter.get(
  "/system-health",
  asyncHandler(async (_req: Request, res: Response) => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    res.json({
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      cpu: {
        model: cpus[0]?.model ?? "unknown",
        cores: cpus.length,
        loadAvg1m: Number(loadAvg[0].toFixed(2)),
        loadAvg5m: Number(loadAvg[1].toFixed(2)),
        loadAvg15m: Number(loadAvg[2].toFixed(2)),
      },
      memory: {
        totalMb: Math.round(totalMem / 1024 / 1024),
        freeMb: Math.round(freeMem / 1024 / 1024),
        usedPercent: Number(((1 - freeMem / totalMem) * 100).toFixed(1)),
      },
      process: {
        pid: process.pid,
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

adminDashboardRouter.get(
  "/transactions",
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page ?? 20)));
    const userId = req.query.user_id as string | undefined;
    const type = req.query.type as string | undefined;

    let list = [...transactions];
    if (userId) list = list.filter((t) => t.userId === userId);
    if (type) list = list.filter((t) => t.type === type);

    list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const total = list.length;
    const items = list.slice((page - 1) * perPage, page * perPage);
    res.json({ total, page, perPage, transactions: items });
  }),
);

adminDashboardRouter.get(
  "/analytics",
  asyncHandler(async (_req: Request, res: Response) => {
    const userList = [...users.values()];
    const txList = [...transactions];
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const activeUsers = userList.filter((u) => u.status === "active").length;
    const suspendedUsers = userList.filter((u) => u.status === "suspended").length;
    const recentTx = txList.filter((t) => t.timestamp >= dayAgo);
    const totalVolume = txList.reduce((sum, t) => sum + t.amount, 0);
    const recentVolume = recentTx.reduce((sum, t) => sum + t.amount, 0);

    const roleBreakdown = [...roles.keys()].map((role) => ({
      role,
      count: userList.filter((u) => u.role === role).length,
    }));

    res.json({
      users: { total: userList.length, active: activeUsers, suspended: suspendedUsers },
      transactions: {
        total: txList.length,
        last24h: recentTx.length,
        totalVolumeXlm: Number(totalVolume.toFixed(4)),
        last24hVolumeXlm: Number(recentVolume.toFixed(4)),
      },
      roles: roleBreakdown,
      generatedAt: now.toISOString(),
    });
  }),
);

adminDashboardRouter.get(
  "/roles",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ roles: [...roles.values()] });
  }),
);

adminDashboardRouter.post(
  "/roles",
  asyncHandler(async (req: Request, res: Response) => {
    const { name, permissions } = req.body as { name?: string; permissions?: string[] };
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (!Array.isArray(permissions)) return res.status(400).json({ error: "permissions must be an array" });
    if (roles.has(name)) return res.status(409).json({ error: "Role already exists" });

    const role: RoleDefinition = { name, permissions, createdAt: new Date().toISOString() };
    roles.set(name, role);
    res.status(201).json(role);
  }),
);

adminDashboardRouter.put(
  "/roles/:role/users/:userId",
  asyncHandler(async (req: Request, res: Response) => {
    const { role, userId } = req.params;
    if (!roles.has(role)) return res.status(404).json({ error: "Role not found" });
    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.role = role;
    res.json(user);
  }),
);
