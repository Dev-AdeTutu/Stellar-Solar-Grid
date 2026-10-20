import { Router } from "express";
import { dataLake } from "../lake/dataLake.js";

export const lakeRouter = Router();

const q = (req: any) => ({
  from: req.query.from as string | undefined,
  to: req.query.to as string | undefined,
  meterId: req.query.meterId as string | undefined,
});

lakeRouter.get("/partitions", (_req, res) => res.json(dataLake.listPartitions()));
lakeRouter.get("/telemetry", (req, res) => res.json(dataLake.query(q(req)).slice(0, 10_000)));
lakeRouter.get("/summary", (req, res) => res.json(dataLake.summarize(q(req))));
