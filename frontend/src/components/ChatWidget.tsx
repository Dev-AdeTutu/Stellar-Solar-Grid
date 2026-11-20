"use client";
import { useEffect, useRef, useState } from "react";
import { env } from "@/lib/env";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

function chatSocketUrl(): string {
  const base =
    env.NEXT_PUBLIC_BACKEND_URL ||
    (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");
  const url = new URL("/api/chatbot/live", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectAttempts = useRef(0);

  useEffect(() => {
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      try {
        const socket = new WebSocket(chatSocketUrl());
        socketRef.current = socket;

        socket.onopen = () => {
          reconnectAttempts.current = 0;
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const content =
              typeof data === "string"
                ? data
                : data?.answer ?? data?.content ?? data?.message;
            if (typeof content === "string" && content.trim()) {
              const id = data?.id ?? `${Date.now()}-${Math.random()}`;
              setMessages((prev) => {
                if (prev.some((m) => m.id === id)) return prev;
                return [
                  ...prev,
                  {
                    id,
                    role: "assistant",
                    content,
                    timestamp: new Date().toISOString(),
                  },
                ];
              });
            }
          } catch {
            // Ignore non-JSON frames.
          }
        };

        socket.onerror = () => socket.close();

        socket.onclose = () => {
          if (stopped) return;
          const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts.current++);
          reconnectTimer.current = window.setTimeout(connect, delay);
        };
      } catch {
        if (!stopped) {
          const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts.current++);
          reconnectTimer.current = window.setTimeout(connect, delay);
        }
      }
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current !== undefined) {
        window.clearTimeout(reconnectTimer.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  async function send() {
    if (!message.trim() || busy) return;
    const text = message.trim();
    setBusy(true);

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setMessage("");

    try {
      const res = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/chatbot/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationId,
          language: document.documentElement.lang || "en",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to reach support");

      setConversationId(data.conversationId);
      const answer = data.answer ?? "Unable to reach support";
      setMessages((prev) => {
        if (prev.some((m) => m.id === data.id)) return prev;
        return [
          ...prev,
          {
            id: data.id ?? `assistant-${Date.now()}`,
            role: "assistant",
            content: answer,
            timestamp: new Date().toISOString(),
          },
        ];
      });
    } catch (error) {
      const content = error instanceof Error ? error.message : "Unable to reach support";
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50">
      <button
        aria-label="Open customer support chat"
        onClick={() => setOpen(!open)}
        className="rounded-full bg-solar-yellow px-4 py-3 font-semibold text-solar-accent shadow-lg"
      >
        {open ? "Close" : "Support"}
      </button>
      {open && (
        <section
          aria-label="Customer support chat"
          className="mb-3 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-white/10 bg-solar-accent p-4 shadow-2xl"
        >
          <h2 className="font-semibold">SolarGrid support</h2>
          <div
            className="my-3 max-h-64 min-h-16 space-y-2 overflow-y-auto text-sm text-gray-300"
            aria-live="polite"
          >
            {messages.length === 0 ? (
              <p className="text-gray-400">
                Ask about balances, usage, payments, or troubleshooting.
              </p>
            ) : (
              messages.map((m) => (
                <p
                  key={m.id}
                  className={m.role === "user" ? "text-right text-solar-yellow" : "text-left"}
                >
                  {m.content}
                </p>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              aria-label="Support question"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="How can we help?"
              className="min-w-0 flex-1 rounded border border-white/20 bg-transparent px-2 py-2 text-sm"
            />
            <button
              disabled={busy}
              onClick={send}
              className="rounded bg-solar-yellow px-3 text-sm font-semibold text-solar-accent disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
