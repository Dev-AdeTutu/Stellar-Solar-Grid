"use client";

import { create } from "zustand";

interface PaymentFormState {
  meterId: string;
  plan: "Daily" | "Weekly" | "Monthly" | "Usage";
  setMeterId: (id: string) => void;
  setPlan: (plan: "Daily" | "Weekly" | "Monthly" | "Usage") => void;
  reset: () => void;
}

export const usePaymentStore = create<PaymentFormState>((set) => ({
  meterId: "",
  plan: "Daily",
  setMeterId: (id: string) => set({ meterId: id }),
  setPlan: (plan: "Daily" | "Weekly" | "Monthly" | "Usage") => set({ plan }),
  reset: () => set({ meterId: "", plan: "Daily" }),
}));

export const downloadCsv = (rows: any[][]) => {
  const csv = rows.map(r => r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "payments.csv";
  a.click();
};