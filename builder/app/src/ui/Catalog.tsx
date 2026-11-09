import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CatalogPart } from '../model/types';
import { useEditor } from '../model/store';
import { POPULAR_PARTS } from './data';
import { partIndex, useCatalog } from './hooks';
import { IconClose, IconSearch } from './Icons';
import { usePrefs } from './prefs';
import { Thumb } from './Thumb';

export const POPULAR = 'Popular';
export const ALL = 'All';
/** Categories shown first (in this order) when present in the catalog. */
const PREFERRED = ['Brick', 'Plate', 'Tile', 'Slope', 'Round', 'Technic', 'Wedge', 'Window', 'Door', 'Panel', 'Arch', 'Hinge', 'Minifig'];
/** Hidden unless "Show Duplo & Modulex" is on, or searched by part number. */
const NICHE_CATS = /^(Duplo|Modulex|Quatro|Primo|Znap|Constraction|Fabuland|Belville|Scala|Clikits)/i;
const NICHE_RE = /^(duplo|modulex|quatro|primo|znap|fabuland|clikits)\b/i;

/** "Brick  2 x  4" → "Brick 2 x 4" */
export const tidyName = (n: string) => n.replace(/\s+/g, ' ').trim();

const SIZE_RE = /(\d+(?:\.\d+)?) x (\d+(?:\.\d+)?)(?: x (\d+(?:\.\d+)?))?/;

/** Size-first label: "Slope Brick 45 2 x 2 Double" → "2x2 Slope 45° Double". */
export function partLabel(name: string): string {
  let n = tidyName(name)
    .replace(/^Slope Brick (\d+(?:\.\d+)?)/, 'Slope $1°')
    .replace(/^Slope Brick Curved/, 'Curved Slope')
    .replace(/^Slope Plate (\d+(?:\.\d+)?)/, 'Slope Plate $1°');
  const m = SIZE_RE.exec(n);
  if (!m || m.index > 24) return n;
  const size = m[3] ? `${m[1]}x${m[2]}x${m[3]}` : `${m[1]}x${m[2]}`;
  n = (n.slice(0, m.index) + n.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return `${size} ${n}`;
}

/** "Brick 2 x 4" → "2x4" (footprint only), or '' when the name has no size. */
export function partSize(name: string): string {
  const m = SIZE_RE.exec(tidyName(name));
  return m ? `${m[1]}x${m[2]}` : '';
}

export const isNiche = (p: CatalogPart) => NICHE_CATS.test(p.category ?? '') || NICHE_RE.test(p.name);

const SYNONYMS: Record<string, string> = { roof: 'slope', flat: 'tile', smooth: 'tile', block: 'brick', flats: 'tile' };

interface Indexed {
  part: CatalogPart;
  hay: string;
  niche: boolean;
}

/** Catalog data + search, shared by the desktop sidebar and the phone part picker. */
export function usePartSearch() {
  const { status, parts, retry } = useCatalog();
  const showAll = usePrefs((s) => s.showAllParts);

  // Skip obviously non-buildable entries (moved/aliased/sub-parts usually start with ~ or _).
  const usable = useMemo(
    () => parts.filter((p) => p && p.id && !p.name.startsWith('~') && !p.name.startsWith('_')),
    [parts],
  );

  const indexed = useMemo<Indexed[]>(
    () =>
      usable.map((p) => {
        const name = tidyName(p.name);
        const compact = name.replace(/(\d) x (\d)/g, '$1x$2').replace(/(\d)x(\d+) x (\d)/g, '$1x$2x$3');
        return {
          part: p,
          niche: isNiche(p),
          hay: `${p.id.replace(/\.dat$/i, '')} ${name} ${compact} ${p.category} ${(p.keywords ?? []).join(' ')}`.toLowerCase(),
        };
      }),
    [usable],
  );

  const visible = useMemo(() => (showAll ? indexed : indexed.filter((i) => !i.niche)), [indexed, showAll]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { part: p } of visible) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    const pref = PREFERRED.filter((c) => counts.has(c));
    const rest = [...counts.keys()].filter((c) => !PREFERRED.includes(c)).sort((a, b) => a.localeCompare(b));
    return [POPULAR, ...pref, ...rest, ...(visible.length ? [ALL] : [])];
  }, [visible]);

  const popular = useMemo(() => {
    const idx = partIndex(parts);
    return POPULAR_PARTS.map((p) => idx.get(p.id.toLowerCase()) ?? p);
  }, [parts]);

  const search = useCallback((query: string, category: string): CatalogPart[] => {
    const words = query
      .toLowerCase()
      .replace(/(\d)\s*x\s*(\d)/g, '$1x$2')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => SYNONYMS[w] ?? w);
    if (words.length) {
      const q = words.join(' ');
      // An exact part number also finds niche parts.
      const src: Indexed[] = indexed.length
        ? indexed
        : popular.map((p) => ({ part: p, niche: false, hay: `${p.id} ${p.name} ${p.category}`.toLowerCase() }));
      const scored: Array<{ p: CatalogPart; s: number }> = [];
      for (const it of src) {
        if (!words.every((w) => it.hay.includes(w))) continue;
        const id = it.part.id.toLowerCase().replace(/\.dat$/, '');
        const exactId = id === q;
        if (it.niche && !showAll && !exactId) continue;
        const name = tidyName(it.part.name).toLowerCase();
        let s = name.length;
        if (exactId) s -= 10000;
        // Exact size match ("2x4" → "Brick 2 x 4", not "Brick 2 x 4 x 3").
        const size = words.find((w) => /^\d+x\d+$/.test(w));
        if (size && partSize(it.part.name) === size && !/\d x \d+ x \d/.test(name)) s -= 500;
        if (words.some((w) => it.part.category.toLowerCase() === w)) s -= 200;
        if (/pattern|sticker/.test(name)) s += 300;
        scored.push({ p: it.part, s });
      }
      return scored.sort((a, b) => a.s - b.s).map((x) => x.p);
    }
    if (category === POPULAR) return popular;
    if (category === ALL) return visible.map((i) => i.part);
    return visible.filter((i) => i.part.category === category).map((i) => i.part);
  }, [indexed, popular, visible, showAll]);

  return { status, parts, usable, visible, categories, popular, search, retry };
}

/** Desktop sidebar catalog (search + category chips + virtual grid). */
export function Catalog({ onPicked }: { onPicked?: () => void }) {
  const { status, parts, categories, search, retry } = usePartSearch();
  const [category, setCategory] = useState(POPULAR);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => search(deferredQuery, category), [deferredQuery, category, search]);

  return (
    <div className="catalog">
      <SearchBox value={query} onChange={setQuery} />
      {!query && (
        <div className="chips" role="tablist">
          {categories.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === category}
              className={`chip ${c === category ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {status === 'error' && (
        <div className="catalog-note error">
          Couldn't load the full catalog. Showing popular bricks.
          <button className="btn small" onClick={retry}>Retry</button>
        </div>
      )}
      {status === 'loading' && !parts.length && <div className="catalog-note">Loading catalog…</div>}
      {query && <div className="catalog-count">{results.length.toLocaleString()} result{results.length === 1 ? '' : 's'}</div>}
      <PartGrid items={results} resetKey={`${category}|${deferredQuery}`} onPicked={onPicked} />
      {query && !results.length && <div className="catalog-empty">No parts match “{query}”.</div>}
    </div>
  );
}

export function SearchBox({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  return (
    <div className="catalog-search">
      <IconSearch size={18} />
      <input
        type="search"
        placeholder="Search: 2x4, slope, 3001"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search parts"
        autoFocus={autoFocus}
        enterKeyHint="search"
      />
      {value && (
        <button className="icon-btn ghost small" onClick={() => onChange('')} aria-label="Clear search">
          <IconClose size={16} />
        </button>
      )}
    </div>
  );
}

/** Virtualized grid of part tiles; tapping one arms it. */
export function PartGrid({ items, resetKey, onPicked }: { items: CatalogPart[]; resetKey: string; onPicked?: () => void }) {
  const activePart = useEditor((s) => s.activePart);
  const activeColor = useEditor((s) => s.activeColor);
  const setActivePart = useEditor((s) => s.setActivePart);
  const pick = (id: string) => {
    setActivePart(id);
    onPicked?.();
  };
  return (
    <VirtualGrid
      items={items}
      resetKey={resetKey}
      render={(p) => (
        <button
          key={p.id}
          className={`part-tile ${p.id === activePart ? 'active' : ''}`}
          onClick={() => pick(p.id)}
          title={`${tidyName(p.name)} (${p.id.replace(/\.dat$/i, '')})`}
        >
          <Thumb part={p.id} color={activeColor} />
          <span className="part-name">{partLabel(p.name)}</span>
        </button>
      )}
    />
  );
}

/** Windowed grid: only rows within the viewport (+ overscan) are rendered. */
function VirtualGrid<T>({ items, render, resetKey }: { items: T[]; render: (t: T) => JSX.Element; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const gap = 8;
  const minTile = 92;
  const cols = Math.max(2, Math.floor((size.w + gap) / (minTile + gap)));
  const tileW = size.w ? (size.w - gap * (cols - 1)) / cols : minTile;
  const rowH = tileW + 40 + gap;
  const rows = Math.ceil(items.length / cols);
  const overscan = 2;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const last = Math.min(rows - 1, Math.ceil((scrollTop + (size.h || 600)) / rowH) + overscan);

  const cells: JSX.Element[] = [];
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= items.length) break;
      cells.push(
        <div
          key={i}
          className="vg-cell"
          style={{ transform: `translate(${c * (tileW + gap)}px, ${r * rowH}px)`, width: tileW, height: rowH - gap }}
        >
          {render(items[i])}
        </div>,
      );
    }
  }

  return (
    <div className="vgrid" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: Math.max(0, rows * rowH - gap), position: 'relative' }}>{cells}</div>
    </div>
  );
}
