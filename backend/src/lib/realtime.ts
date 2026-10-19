import { EventEmitter } from "node:events";

export type RealtimeEvent = {
  type: "meterBalanceChanged" | "meterStatusChanged" | "paymentConfirmed" | "usageUpdated";
  key: string;
  payload: Record<string, unknown>;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

export function publishRealtime(event: RealtimeEvent): void {
  emitter.emit(event.type, event);
}

export function subscribeRealtime(type: RealtimeEvent["type"], key: string): AsyncIterableIterator<RealtimeEvent> {
  const queue: RealtimeEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const listener = (event: RealtimeEvent) => {
    if (event.key !== key && key !== "*") return;
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  emitter.on(type, listener);
  return {
    next: async () => {
      while (!queue.length && !done) await new Promise<void>((resolve) => { wake = resolve; });
      if (done) return { done: true, value: undefined as never };
      return { done: false, value: queue.shift()! };
    },
    return: async () => { done = true; emitter.off(type, listener); wake?.(); return { done: true, value: undefined as never }; },
    throw: async (error) => { done = true; emitter.off(type, listener); throw error; },
    [Symbol.asyncIterator]() { return this; },
  };
}
