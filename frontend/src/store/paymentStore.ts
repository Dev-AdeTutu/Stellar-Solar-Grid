"use client";

import { create } from "zustand";

interface PaymentFormState {
  meterId: string;
  plan: "Daily" | "Weekly" | "Monthly" | "Usage";
  installmentPlanId: number | null;
  installmentTotal: string;
  installmentCount: number;
  installmentGraceSecs: number;
  setMeterId: (id: string) => void;
  setPlan: (plan: "Daily" | "Weekly" | "Monthly" | "Usage") => void;
  setInstallmentPlanId: (id: number | null) => void;
  setInstallmentTotal: (total: string) => void;
  setInstallmentCount: (count: number) => void;
  setInstallmentGraceSecs: (secs: number) => void;
  resetInstallment: () => void;
  reset: () => void;
}

export const usePaymentStore = create<PaymentFormState>((set) => ({
  meterId: "",
  plan: "Daily",
  installmentPlanId: null,
  installmentTotal: "",
  installmentCount: 0,
  installmentGraceSecs: 0,
  setMeterId: (id: string) => set({ meterId: id }),
  setPlan: (plan: "Daily" | "Weekly" | "Monthly" | "Usage") => set({ plan }),
  setInstallmentPlanId: (id: number | null) => set({ installmentPlanId: id }),
  setInstallmentTotal: (total: string) => set({ installmentTotal: total }),
  setInstallmentCount: (count: number) => set({ installmentCount: count }),
  setInstallmentGraceSecs: (secs: number) => set({ installmentGraceSecs: secs }),
  resetInstallment: () =>
    set({
      installmentPlanId: null,
      installmentTotal: "",
      installmentCount: 0,
      installmentGraceSecs: 0,
    }),
  reset: () =>
    set({
      meterId: "",
      plan: "Daily",
      installmentPlanId: null,
      installmentTotal: "",
      installmentCount: 0,
      installmentGraceSecs: 0,
    }),
}));

export const downloadCsv = (rows: any[][]) => {
  const csv = rows.map(r => r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "payments.csv";
  a.click();
};