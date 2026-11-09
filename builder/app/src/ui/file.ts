import { fromLdr, toLdr } from '../model/ldraw';
import type { Model } from '../model/types';

export function exportLdr(model: Model): void {
  const blob = new Blob([toLdr(model)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(model.name || 'build').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'build'}.ldr`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker for .ldr / .mpd and resolves with the parsed model (null if cancelled). */
export function pickLdrFile(): Promise<Model | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ldr,.mpd,.dat,.txt,text/plain';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        const text = await file.text();
        const model = fromLdr(text);
        if (model.name === 'Imported model') model.name = file.name.replace(/\.(ldr|mpd|dat|txt)$/i, '');
        resolve(model);
      } catch (e) {
        reject(e);
      }
    };
    document.body.appendChild(input);
    input.click();
  });
}
