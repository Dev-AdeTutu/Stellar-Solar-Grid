import { Router } from "express";
import { dataLake } from "../lake/dataLake.js";

export const lakeRouter = Router();

const q = (req: any) => ({
  from: req.query.from as string | undefined,
  to: req.query.to as string | undefined,
  meterId: req.query.meterId as string | undefined,
});

const TELEMETRY_PAGE_SIZE = 10_000;

const parseOffset = (value: unknown): number => {
  if (value === undefined || value === null || value === "") return 0;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

lakeRouter.get("/partitions", (_req, res) => res.json(dataLake.listPartitions()));
lakeRouter.get("/telemetry", (req, res) => {
  const all = dataLake.query(q(req));
  const offset = parseOffset(req.query.cursor ?? req.query.offset);
  const page = all.slice(offset, offset + TELEMETRY_PAGE_SIZE);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < all.length;

  if (truncated) {
    res.setHeader("X-Truncated", "true");
    res.setHeader("X-Total-Count", String(all.length));
    res.setHeader("X-Page-Size", String(TELEMETRY_PAGE_SIZE));
    res.setHeader("X-Next-Cursor", String(nextOffset));
  } else {
    res.setHeader("X-Truncated", "false");
    res.setHeader("X-Total-Count", String(all.length));
  }

  res.json({
    rows: page,
    truncated,
    cursor: truncated ? String(nextOffset) : null,
    nextCursor: truncated ? String(nextOffset) : null,
    offset,
    total: all.length,
    pageSize: TELEMETRY_PAGE_SIZE,
  });
});
lakeRouter.get("/summary", (req, res) => res.json(dataLake.summarize(q(req))));