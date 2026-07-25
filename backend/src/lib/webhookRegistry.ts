import { logger } from "./logger.js";

const webhookUrls = new Set<string>();

interface WebhookQueueItem {
  url: string;
  payload: string;
  attempt: number;
  nextRetryAt: number;
}

const MAX_RETRIES = 5;
const retryQueue: WebhookQueueItem[] = [];
let retryTimerHandle: NodeJS.Timeout | null = null;
let isShuttingDown = false;

export function registerWebhook(url: string): void {
  webhookUrls.add(url);
}

export function getWebhookUrls(): ReadonlySet<string> {
  return webhookUrls;
}

/**
 * Fire a webhook with automatic retry on failure.
 * Implements exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries)
 */
export async function fireWebhook(url: string, payload: string): Promise<void> {
  return fireWebhookInternal(url, payload, 0);
}

async function fireWebhookInternal(
  url: string,
  payload: string,
  attempt: number,
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(10_000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Success - log if this was a retry
    if (attempt > 0) {
      logger.info("Webhook delivery succeeded after retry", { url, attempt });
    }
  } catch (err: any) {
    // Log the failure
    logger.warn("Webhook delivery failed", {
      url,
      attempt: attempt + 1,
      maxRetries: MAX_RETRIES,
      error: err.message,
    });

    // Retry if we haven't exceeded max attempts
    if (attempt < MAX_RETRIES) {
      const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
      const nextRetryAt = Date.now() + backoffMs;

      retryQueue.push({
        url,
        payload,
        attempt: attempt + 1,
        nextRetryAt,
      });

      scheduleRetryProcessor();
    } else {
      logger.error("Webhook delivery failed permanently after max retries", {
        url,
        attempts: MAX_RETRIES + 1,
      });
    }
  }
}

/**
 * Process retry queue - fires webhooks that are ready to retry
 */
function processRetryQueue(): void {
  if (retryQueue.length === 0) {
    retryTimerHandle = null;
    return;
  }

  const now = Date.now();
  const readyItems: WebhookQueueItem[] = [];
  const remainingItems: WebhookQueueItem[] = [];

  // Partition queue into ready and not-ready items
  for (const item of retryQueue) {
    if (item.nextRetryAt <= now) {
      readyItems.push(item);
    } else {
      remainingItems.push(item);
    }
  }

  // Update queue
  retryQueue.length = 0;
  retryQueue.push(...remainingItems);

  // Fire ready webhooks
  for (const item of readyItems) {
    fireWebhookInternal(item.url, item.payload, item.attempt).catch(() => {
      // Errors are handled inside fireWebhookInternal
    });
  }

  // Schedule next processing run
  scheduleRetryProcessor();
}

/**
 * Schedule the next retry processor run
 */
function scheduleRetryProcessor(): void {
  if (retryTimerHandle) return; // Already scheduled
  if (retryQueue.length === 0) return; // Nothing to process

  // Find the earliest retry time
  const nextRetry = Math.min(...retryQueue.map((item) => item.nextRetryAt));
  const delay = Math.max(0, nextRetry - Date.now());

  retryTimerHandle = setTimeout(() => {
    retryTimerHandle = null;
    processRetryQueue();
  }, delay);
}

/**
 * Drain the retry queue on shutdown.
 * Attempts to deliver all pending webhooks immediately.
 */
export async function drainWebhookQueue(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (retryTimerHandle) {
    clearTimeout(retryTimerHandle);
    retryTimerHandle = null;
  }

  if (retryQueue.length === 0) {
    logger.info("Webhook queue empty, nothing to drain");
    return;
  }

  logger.info("Draining webhook retry queue", { pending: retryQueue.length });

  // Fire all pending webhooks immediately (don't retry on failure during shutdown)
  const promises = retryQueue.map((item) =>
    fetch(item.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: item.payload,
      signal: AbortSignal.timeout(5_000), // Shorter timeout during shutdown
    }).catch((err) => {
      logger.warn("Failed to deliver webhook during shutdown drain", {
        url: item.url,
        attempt: item.attempt,
        error: err.message,
      });
    }),
  );

  await Promise.allSettled(promises);
  retryQueue.length = 0;
  logger.info("Webhook queue drained");
}

// Register SIGTERM handler to drain queue on shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, draining webhook queue");
  await drainWebhookQueue();
});
