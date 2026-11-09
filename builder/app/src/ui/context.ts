import { createContext, useContext } from 'react';
import type { BrickyardEngine } from '../engine/types';
import type { BrickColor } from '../model/types';

export interface AppContextValue {
  engine: BrickyardEngine;
  colors: BrickColor[];
}

export const AppContext = createContext<AppContextValue | null>(null);

function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext missing');
  return v;
}

export const useEngine = () => useApp().engine;
export const useColors = () => useApp().colors;
