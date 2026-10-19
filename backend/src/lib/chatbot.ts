import { randomUUID } from "node:crypto";
export type ChatLanguage = "en" | "es" | "fr" | "de" | "sw" | "zh" | "ar";
export type ChatReply = { conversationId: string; answer: string; language: ChatLanguage; escalated: boolean; confidence: number; sources: string[] };
const sessions = new Map<string, { language: ChatLanguage; messages: number; escalations: number }>();
const faq: Array<{ keys: string[]; answer: string; source: string }> = [
  { keys: ["balance", "meter balance", "credit"], answer: "Open My Meter and connect your Stellar wallet to see your live balance and meter status.", source: "docs/FAQ.md#balances" },
  { keys: ["usage", "consumption", "energy used"], answer: "Usage is recorded by your meter and shown in History and Energy Insights. Recent readings are reported in kWh.", source: "docs/FAQ.md#usage" },
  { keys: ["payment", "pay", "top up", "deposit"], answer: "Choose Pay, select a meter and plan, then approve the transaction in your Stellar wallet. Never share your secret key.", source: "docs/FAQ.md#payments" },
  { keys: ["troubleshoot", "offline", "not working", "error"], answer: "Check your wallet network, confirm the meter ID, refresh the page, and retry after checking the status banner. A support agent can help if it persists.", source: "docs/TROUBLESHOOTING.md" },
];
const escalation = ["human", "agent", "complaint", "refund", "security", "fraud", "lawsuit"];
export function answerChat(input: { conversationId?: string; message: string; language?: ChatLanguage }): ChatReply {
  const message = input.message.trim(); if (!message) throw new Error("message is required");
  const id = input.conversationId ?? `chat_${randomUUID()}`; const language = input.language ?? "en";
  const session = sessions.get(id) ?? { language, messages: 0, escalations: 0 }; session.messages += 1; sessions.set(id, session);
  const normalized = message.toLowerCase(); const shouldEscalate = escalation.some((word) => normalized.includes(word));
  const match = faq.find((item) => item.keys.some((key) => normalized.includes(key)));
  let answer = match?.answer ?? "I couldn't find a confident answer in the SolarGrid help centre. I can connect you with a support agent for this question.";
  if (shouldEscalate) { session.escalations += 1; answer = "This needs a support specialist. Your conversation has been flagged for human follow-up; please include your wallet address and meter ID, but never your secret key."; }
  return { conversationId: id, answer, language, escalated: shouldEscalate, confidence: shouldEscalate ? 0.35 : match ? 0.92 : 0.2, sources: match ? [match.source] : [] };
}
export function chatbotMetrics() { const values = [...sessions.values()]; const messages = values.reduce((n, s) => n + s.messages, 0); const escalations = values.reduce((n, s) => n + s.escalations, 0); return { conversations: values.length, messages, escalations, escalationRate: messages ? Number((escalations / messages).toFixed(4)) : 0, answerRate: messages ? Number(((messages - escalations) / messages).toFixed(4)) : 0 }; }
export function resetChatbotForTests() { sessions.clear(); }
