// Open/close state of the "Photo to Bricks" overlay (UI only, not part of the model or undo history).
import { create } from 'zustand';

interface PhotoFlowState {
  open: boolean;
  openFlow(): void;
  close(): void;
}

export const usePhotoFlow = create<PhotoFlowState>((set) => ({
  open: false,
  openFlow: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openPhotoFlow = () => usePhotoFlow.getState().openFlow();
