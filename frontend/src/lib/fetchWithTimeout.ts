import { env } from "@/lib/env";

/**
 * Fetch wrapper that adds AbortController timeout to prevent indefinite hangs
 * Configurable via NEXT_PUBLIC_REQUEST_TIMEOUT_MS env var (default: 10000ms)
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const timeout = timeoutMs ?? env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw err;
  }
}
