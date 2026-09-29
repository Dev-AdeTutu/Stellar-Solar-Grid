/**
 * Bridge to the native home-screen widgets (#901). Native implementations
 * live in frontend/native-widgets/{ios,android}.
 *
 * Talks to the native side through the `window.Capacitor` global injected by
 * the Capacitor native bridge rather than importing @capacitor/*, which is
 * only installed for mobile builds (package.capacitor.json). On the web the
 * global is absent and every call is a no-op.
 */

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
  nativeCallback?: (
    plugin: string,
    method: string,
    options: Record<string, unknown>,
    callback: (data: unknown, error?: unknown) => void,
  ) => string;
};

function cap(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return c?.isNativePlatform?.() ? c : undefined;
}

export function isNativeApp(): boolean {
  return !!cap();
}

async function call(method: string, options?: Record<string, unknown>): Promise<void> {
  const c = cap();
  if (!c?.nativePromise) return;
  try {
    await c.nativePromise("WidgetBridge", method, options);
  } catch {
    // Widget support is optional (e.g. plugin not registered) — never break the app over it.
  }
}

/** Point the widget at a meter. The native side ignores calls that change nothing. */
export function configureWidget(meterId: string, apiUrl: string): Promise<void> {
  if (!meterId) return Promise.resolve();
  return call("configure", { meterId, apiUrl: apiUrl.replace(/\/$/, "") });
}

export const refreshWidget = () => call("refresh");
export const clearWidget = () => call("clear");

/**
 * Listen for app deep links (widget taps). Also delivers the launch URL when
 * the app was cold-started from a widget. Returns an unsubscribe function.
 */
export function onAppUrlOpen(listener: (url: string) => void): () => void {
  const c = cap();
  if (!c?.nativeCallback || !c.nativePromise) return () => {};
  c.nativePromise("App", "getLaunchUrl")
    .then((r) => {
      const url = (r as { url?: string } | undefined)?.url;
      if (url) listener(url);
    })
    .catch(() => {});
  const callbackId = c.nativeCallback("App", "addListener", { eventName: "appUrlOpen" }, (data) => {
    const url = (data as { url?: string } | undefined)?.url;
    if (url) listener(url);
  });
  return () => {
    c.nativePromise?.("App", "removeListener", { callbackId, eventName: "appUrlOpen" }).catch(() => {});
  };
}

/**
 * Map a widget deep link to an in-app route:
 *   solargrid://meter/<id>        → /dashboard/user?meter=<id>
 *   solargrid://pay?meter=<id>    → /pay?meter=<id>
 *   solargrid://dashboard         → /dashboard/user
 */
export function routeForWidgetUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "solargrid:") return null;
  // Depending on the URL implementation, the segment after "//" is either the host or the first path segment.
  const segments = `${parsed.host}${parsed.pathname}`.split("/").filter(Boolean);
  const [target, ...rest] = segments;
  const meter = parsed.searchParams.get("meter");
  switch (target) {
    case "meter": {
      const id = rest.length ? decodeURIComponent(rest.join("/")) : "";
      return id ? `/dashboard/user?meter=${encodeURIComponent(id)}` : "/dashboard/user";
    }
    case "pay":
      return meter ? `/pay?meter=${encodeURIComponent(meter)}` : "/pay";
    case "dashboard":
      return "/dashboard/user";
    default:
      return null;
  }
}
