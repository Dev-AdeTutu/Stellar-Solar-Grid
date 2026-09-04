import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  reqId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a request id bound to async-local storage for the duration of the request. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ reqId: requestId }, fn);
}

/** Returns the request ID for the currently executing async context, or undefined. */
export function getReqId(): string | undefined {
  return requestContext.getStore()?.reqId;
}

/** Alias retained for callers that use the expanded name. */
export function getRequestId(): string | undefined {
  return getReqId();
}
