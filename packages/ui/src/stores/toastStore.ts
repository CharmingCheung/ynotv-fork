import { create } from 'zustand';

export type ToastType = 'error' | 'success';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  /** Number of stacked error lines (error toasts only; 1 = not stacked). */
  count?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type: ToastType) => void;
  removeToast: (id: number) => void;
}

// How long a toast stays visible. Appending an error to an existing error
// toast refreshes its timer, so a merged toast lingers 6s after the last error
// that landed on it.
const TOAST_DURATION_MS = 6000;

let nextId = 1;
// Dismiss timers per toast id, so merging can extend the window and manual
// dismissal can cancel a pending auto-remove.
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set, get) => {
  const scheduleDismiss = (id: number) => {
    const prev = dismissTimers.get(id);
    if (prev) clearTimeout(prev);
    dismissTimers.set(
      id,
      setTimeout(() => {
        dismissTimers.delete(id);
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }, TOAST_DURATION_MS)
    );
  };

  const dismiss = (id: number) => {
    const prev = dismissTimers.get(id);
    if (prev) clearTimeout(prev);
    dismissTimers.delete(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  };

  return {
    toasts: [],
    addToast: (message, type) => {
      const msg = String(message);

      // Errors stack into a single scrollable toast: when another error arrives
      // while an error toast is still visible, append the new line to it (and
      // keep it visible a bit longer) instead of spawning a duplicate toast.
      if (type === 'error') {
        const toasts = get().toasts;
        for (let i = toasts.length - 1; i >= 0; i--) {
          if (toasts[i].type === 'error') {
            const id = toasts[i].id;
            set((state) => ({
              toasts: state.toasts.map((t) =>
                t.id === id
                  ? { ...t, message: `${t.message}\n${msg}`, count: (t.count ?? 1) + 1 }
                  : t
              ),
            }));
            scheduleDismiss(id);
            return;
          }
        }
      }

      const id = nextId++;
      set((state) => ({
        toasts: [...state.toasts, { id, message: msg, type, count: type === 'error' ? 1 : undefined }],
      }));
      scheduleDismiss(id);
    },
    removeToast: (id) => {
      dismiss(id);
    },
  };
});
