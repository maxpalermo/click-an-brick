import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';
export interface ToastAction {
  label: string;
  run(): void;
}
export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

interface ToastState {
  items: ToastItem[];
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));

/** Show a toast notification (optionally with one action button, e.g. Undo). */
export function toast(text: string, kind: ToastKind = 'info', ms = 3200, action?: ToastAction): void {
  const id = nextId++;
  // The same message twice in a row just refreshes (e.g. repeated "Overlaps a brick").
  const items = useToasts.getState().items.filter((t) => t.text !== text);
  useToasts.setState({ items: [...items.slice(-2), { id, kind, text, action }] });
  window.setTimeout(() => useToasts.getState().dismiss(id), ms);
}
