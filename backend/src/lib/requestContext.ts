import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  reqId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the request ID for the currently executing async context, or undefined. */
export function getReqId(): string | undefined {
  return requestContext.getStore()?.reqId;
}

/**
 * Returns the request ID for the currently executing async context, or undefined.
 * Alias of getReqId() — use this for clarity in new code.
 */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.reqId;
}
