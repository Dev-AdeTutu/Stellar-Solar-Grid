import { Router } from "express";
import { z } from "zod";
import { answerChat, chatbotMetrics } from "../lib/chatbot.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
export const chatbotRouter = Router();
const schema = z.object({ conversationId: z.string().optional(), message: z.string().min(1).max(4000), language: z.enum(["en", "es", "fr", "de", "sw", "zh", "ar"]).optional() });
chatbotRouter.post("/messages", (req, res) => { const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() }); try { return res.json(answerChat(parsed.data)); } catch (e) { return res.status(400).json({ error: e instanceof Error ? e.message : "invalid message" }); } });
chatbotRouter.get("/metrics", requireAdminKey, (_req, res) => res.json(chatbotMetrics()));
