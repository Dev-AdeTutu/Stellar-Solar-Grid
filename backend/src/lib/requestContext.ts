import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  reqId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Run a function with a request id bound to the current async context. */
export function runWithRequestId<T>(reqId: string, fn: () => T): T {
  return requestContext.run({ reqId }, fn);
}

/** Returns the request ID for the currently executing async context, or undefined. */
export function getReqId(): string | undefined {
  return requestContext.getStore()?.reqId;
}

/** Alias retained for callers that use the expanded name. */
export function getRequestId(): string | undefined {
  return getReqId();
}
