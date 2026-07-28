"use client";

import { useEffect } from "react";
import { Toast, useToastStore } from "@/store/toastStore";

function ToastItem({ toast }: { toast: Toast }) {
  const remove = useToastStore((s) => s.remove);

  useEffect(() => {
    const timer = setTimeout(() => {
      remove(toast.id);
    }, 5000);
    return () => clearTimeout(timer);
  }, [toast.id, remove]);

  const chrome =
    toast.type === "success"
      ? "border-green-500/40 bg-green-950/90 text-green-100"
      : "border-red-500/40 bg-red-950/90 text-red-100";
  const accent =
    toast.type === "success" ? "bg-green-400" : "bg-red-400";

  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      onClick={() => remove(toast.id)}
      className={`w-full cursor-pointer rounded-xl border px-4 py-3 shadow-2xl backdrop-blur transition hover:opacity-90 ${chrome}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${accent}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{toast.message}</p>
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
              onClick={(e) => e.stopPropagation()}
              className="mt-2 inline-block text-xs font-semibold underline underline-offset-2 hover:opacity-80"
            >
              {toast.actionLabel} ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            remove(toast.id);
          }}
          aria-label="Dismiss notification"
          className="rounded-md p-1 text-current/70 transition hover:bg-white/10 hover:text-current"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const errorToasts = toasts.filter((t) => t.type === "error");
  const politeToasts = toasts.filter((t) => t.type !== "error");

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-3 sm:left-auto sm:right-4 sm:w-full sm:max-w-sm">
      <div aria-atomic="false" aria-live="polite" className="contents">
        {politeToasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <div aria-atomic="false" aria-live="assertive" className="contents">
        {errorToasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}
