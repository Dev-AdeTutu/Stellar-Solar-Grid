import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  reqId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the request ID for the currently executing async context, or undefined. */
export function getReqId(): string | undefined {
  return requestContext.getStore()?.reqId;
}
