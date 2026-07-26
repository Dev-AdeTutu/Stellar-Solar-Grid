"use client";

import { createContext, useContext, ReactNode } from "react";
import { useToastStore } from "@/store/toastStore";
import ToastContainer from "./Toast";

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

  const showToast = (options: ToastOptions) => {
    add({
      message: options.title,
      type: options.variant ?? "success",
      description: options.description,
      actionHref: options.actionHref,
      actionLabel: options.actionLabel,
    });
  };

  return (
    <ToastContext.Provider value={{ showToast, dismissToast: remove }}>
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
