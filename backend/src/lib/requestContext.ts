import { AsyncLocalStorage } from "node:async_hooks";

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Run `fn` with a request id bound to async-local storage for the duration of the request. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** Read the current request id, if any code up the call stack set one via `runWithRequestId`. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
