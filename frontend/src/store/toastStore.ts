import { create } from 'zustand';

export type Toast = {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  description?: string;
  actionHref?: string;
  actionLabel?: string;
};

interface ToastStore {
  toasts: Toast[];
  add: (t: Omit<Toast, 'id'>) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (t) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          ...t,
          id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        },
      ],
    })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
