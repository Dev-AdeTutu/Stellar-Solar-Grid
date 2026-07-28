"use client";

import { create } from "zustand";

interface PaymentFormState {
  meterId: string;
  plan: "Daily" | "Weekly" | "Usage";
  setMeterId: (id: string) => void;
  setPlan: (plan: "Daily" | "Weekly" | "Usage") => void;
  reset: () => void;
}

export const usePaymentStore = create<PaymentFormState>((set) => ({
  meterId: "",
  plan: "Daily",
  setMeterId: (id: string) => set({ meterId: id }),
  setPlan: (plan: "Daily" | "Weekly" | "Usage") => set({ plan }),
  reset: () => set({ meterId: "", plan: "Daily" }),
}));
