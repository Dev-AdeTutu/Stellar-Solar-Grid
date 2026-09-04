"use client";

import { useEffect, useRef, useState } from "react";

export function useGraphQLSubscription<T>(
  query: string,
  variables: Record<string, unknown>,
  fallback: () => Promise<T> | T,
  intervalMs = 15_000,
): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const retry = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    const poll = window.setInterval(async () => {
      if (!connected) setData(await fallback());
    }, intervalMs);

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/graphql`, "graphql-transport-ws");
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        socket?.send(JSON.stringify({ type: "connection_init" }));
        socket?.send(JSON.stringify({ id: "solar-grid", type: "subscribe", payload: { query, variables } }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type?: string; payload?: { data?: Record<string, T> } };
        const value = message.payload?.data && Object.values(message.payload.data)[0];
        if (value !== undefined) setData(value);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) { const delay = Math.min(30_000, 1000 * 2 ** attempts++); retry.current = window.setTimeout(connect, delay); }
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retry.current) window.clearTimeout(retry.current);
      window.clearInterval(poll);
      socket?.close();
    };
  }, [query, JSON.stringify(variables), fallback, intervalMs]);

  return { data, connected };
}
