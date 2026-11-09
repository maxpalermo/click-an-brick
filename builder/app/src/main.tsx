import { createRoot } from 'react-dom/client';
import { api } from './api/client';
import { createEngine } from './engine/Engine';
import type { BrickColor } from './model/types';
import { App } from './ui/App';
import { AppContext } from './ui/context';
import { COMMON_COLORS } from './ui/data';
import './styles.css';

async function loadColors(): Promise<BrickColor[]> {
  try {
    const colors = await api.getColors();
    if (Array.isArray(colors) && colors.length) {
      // Make sure the common palette colours always exist.
      const have = new Set(colors.map((c) => c.code));
      return [...colors, ...COMMON_COLORS.filter((c) => !have.has(c.code))];
    }
  } catch {
    /* fall back below */
  }
  return COMMON_COLORS;
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="fatal">
      <div className="viewer-center panel">
        <h2>Brickyard can't start</h2>
        <p className="muted">{message}</p>
        <p className="muted">Brickyard needs a browser with WebGL enabled.</p>
        <button className="btn primary" onClick={() => location.reload()}>Reload</button>
      </div>
    </div>
  );
}

async function boot() {
  const rootEl = document.getElementById('root')!;
  const root = createRoot(rootEl);
  const colors = await loadColors();
  try {
    const engine = createEngine({ apiBase: '/by-backend', colors });
    root.render(
      <AppContext.Provider value={{ engine, colors }}>
        <App />
      </AppContext.Provider>,
    );
  } catch (e) {
    root.render(<Fatal message={e instanceof Error ? e.message : String(e)} />);
  }
  document.getElementById('boot-splash')?.remove();
}

void boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support is best-effort */
    });
  });
}
