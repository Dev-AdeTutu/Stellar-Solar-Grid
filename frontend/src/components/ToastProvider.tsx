"use client";

import { createContext, useContext, ReactNode, useCallback, useMemo } from "react";
import { useToastStore } from "@/store/toastStore";
import ToastContainer from "./Toast";

const MAX_TOASTS = 3;

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: "success" | "error";
  actionHref?: string;
  actionLabel?: string;
};

type ToastContextValue = {
  showToast: (options: ToastOptions) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const add = useToastStore((s) => s.add);
  const remove = useToastStore((s) => s.remove);

  const showToast = useCallback((options: ToastOptions) => {
    const current = useToastStore.getState().toasts;
    const overflow = current.length - (MAX_TOASTS - 1);
    if (overflow > 0) {
      current.slice(0, overflow).forEach((toast) => remove(toast.id));
    }

    add({
      message: options.title,
      type: options.variant ?? "success",
      description: options.description,
      actionHref: options.actionHref,
      actionLabel: options.actionLabel,
    });
  }, [add, remove]);

  const value = useMemo(
    () => ({ showToast, dismissToast: remove }),
    [showToast, remove]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer />
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