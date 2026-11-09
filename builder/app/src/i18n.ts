// Tiny i18n: 'it' (default) | 'en'. Persisted in localStorage, shared with the
// scanner app via the same key ('cab-lang').
import { useSyncExternalStore } from 'react';

export type Lang = 'it' | 'en';
const KEY = 'cab-lang';
const subs = new Set<() => void>();

export function lang(): Lang {
  return (localStorage.getItem(KEY) as Lang) || 'it';
}
export function setLang(l: Lang) {
  localStorage.setItem(KEY, l);
  subs.forEach((f) => f());
}
export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => lang(),
  );
}

const IT: Record<string, string> = {
  'welcome.title': 'Costruiamo!',
  'welcome.click': 'Clicca la griglia per posare un {colour} {label}.',
  'welcome.shift': 'Shift-click per vederne prima l’anteprima.',
  'welcome.tap': 'Tocca la griglia per posare un {colour} {label}.',
  'welcome.adjust': 'Sistemalo, poi tocca di nuovo per posarlo.',
  'welcome.photo': 'Da una foto',
  'welcome.mybuilds': 'I miei modelli',
  'welcome.openldr': 'Apri .ldr',
  'nav.builds': 'I miei modelli',
  'nav.photo': 'Foto',
  'nav.file': 'File',
  'nav.share': 'Condividi',
  'nav.undo': 'Annulla',
  'nav.redo': 'Ripeti',
  'nav.inventory': 'Inventario',
  'palette.bricks': 'Mattoncini',
  'palette.search': 'Cerca: 2x4, slope, 3001',
  'palette.recent': 'Recenti',
  'palette.allcolours': 'Tutti i colori',
  'builds.title': 'I miei modelli',
  'builds.empty': 'Nessun modello salvato.',
  'builds.open': 'Apri',
  'builds.delete': 'Elimina',
  'builds.signin': 'Accedi per salvare i modelli.',
  'share.title': 'Condividi',
  'share.copy': 'Copia link',
  'share.copied': 'Link copiato!',
  'share.done': 'Fatto',
  'tip.gotit': 'Capito',
  'lang.label': 'Lingua',
};
const EN: Record<string, string> = {
  'welcome.title': "Let's build!",
  'welcome.click': 'Click the grid to place a {colour} {label}.',
  'welcome.shift': 'Shift-click to preview it first.',
  'welcome.tap': 'Tap the grid to drop a {colour} {label}.',
  'welcome.adjust': 'Adjust it, then tap it again to place.',
  'welcome.photo': 'From a photo',
  'welcome.mybuilds': 'My builds',
  'welcome.openldr': 'Open .ldr',
  'nav.builds': 'My builds',
  'nav.photo': 'Photo',
  'nav.file': 'File',
  'nav.share': 'Share',
  'nav.undo': 'Undo',
  'nav.redo': 'Redo',
  'nav.inventory': 'Inventory',
  'palette.bricks': 'Bricks',
  'palette.search': 'Search: 2x4, slope, 3001',
  'palette.recent': 'Recent',
  'palette.allcolours': 'All colours',
  'builds.title': 'My builds',
  'builds.empty': 'No builds saved yet.',
  'builds.open': 'Open',
  'builds.delete': 'Delete',
  'builds.signin': 'Sign in to save builds.',
  'share.title': 'Share',
  'share.copy': 'Copy link',
  'share.copied': 'Link copied!',
  'share.done': 'Done',
  'tip.gotit': 'Got it',
  'lang.label': 'Language',
};
const DICTS = { it: IT, en: EN };

export function t(key: string, vars?: Record<string, string>): string {
  let s = DICTS[lang()][key] ?? DICTS.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}
export function useT() {
  useLang();
  return t;
}
