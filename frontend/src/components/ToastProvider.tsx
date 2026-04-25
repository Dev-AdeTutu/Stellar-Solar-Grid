"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastVariant = "success" | "error";

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  actionHref?: string;
  actionLabel?: string;
};

type ToastRecord = ToastOptions & {
  id: string;
  variant: ToastVariant;
};

type ToastContextValue = {
  showToast: (options: ToastOptions) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function buildToastId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timeoutsRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timeoutId = timeoutsRef.current.get(id);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      timeoutsRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    const id = buildToastId();
    const toast: ToastRecord = {
      id,
      variant: options.variant ?? "success",
      ...options,
    };

    setToasts((current) => [...current.slice(-2), toast]);

    const timeoutId = window.setTimeout(() => {
      dismissToast(id);
    }, 5_000);

    timeoutsRef.current.set(id, timeoutId);
  }, [dismissToast]);

  useEffect(() => {
    const timeouts = timeoutsRef.current;

    return () => {
      for (const timeoutId of timeouts.values()) {
        window.clearTimeout(timeoutId);
      }
      timeouts.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div
        aria-atomic="true"
        aria-live="assertive"
        className="pointer-events-none fixed inset-x-4 top-4 z-[60] flex flex-col items-end gap-3 sm:left-auto sm:right-4 sm:w-full sm:max-w-sm"
      >
        {toasts.map((toast) => {
          const chrome =
            toast.variant === "success"
              ? "border-green-500/40 bg-green-950/90 text-green-100"
              : "border-red-500/40 bg-red-950/90 text-red-100";
          const accent =
            toast.variant === "success" ? "bg-green-400" : "bg-red-400";

          return (
            <div
              key={toast.id}
              role="alert"
              className={`pointer-events-auto w-full rounded-xl border px-4 py-3 shadow-2xl backdrop-blur ${chrome}`}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${accent}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{toast.title}</p>
                  {toast.description && (
                    <p className="mt-1 text-sm text-current/80">
                      {toast.description}
                    </p>
                  )}
                  {toast.actionHref && toast.actionLabel && (
                    <a
                      href={toast.actionHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block text-xs font-semibold underline underline-offset-2 hover:opacity-80"
                    >
                      {toast.actionLabel} ↗
                    </a>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss notification"
                  className="rounded-md p-1 text-current/70 transition hover:bg-white/10 hover:text-current"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }

  return context;
}
