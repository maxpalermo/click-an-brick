// Phone part picker (half sheet, UX_REVIEW §3.4) and the recent/pinned parts hotbar (§3.2).
import { useDeferredValue, useMemo, useState } from 'react';
import type { CatalogPart } from '../model/types';
import { useEditor } from '../model/store';
import { ALL, PartGrid, SearchBox, partLabel, partSize, tidyName, usePartSearch } from './Catalog';
import { POPULAR_PARTS } from './data';
import { useLongPress } from './gestures';
import { partIndex, useCatalog } from './hooks';
import { IconBack, IconGrid, IconStar } from './Icons';
import { hotbarParts, openSheet, usePrefs } from './prefs';
import { Thumb } from './Thumb';
import { toast } from './toast';
import { haptic } from './engineBridge';

const TYPES = ['Brick', 'Plate', 'Tile', 'Slope'] as const;
type PartType = (typeof TYPES)[number];
const SIZES = ['1x1', '1x2', '1x3', '1x4', '1x6', '1x8', '2x2', '2x3', '2x4', '2x6', '2x8'];
const POP_RANK = new Map(POPULAR_PARTS.map((p, i) => [p.id.toLowerCase(), i]));

/** Best "plain" part for each type × footprint (e.g. Plate 2x4 → 3020). */
function useSizeTable(visible: Array<{ part: CatalogPart }>) {
  return useMemo(() => {
    const table = new Map<PartType, Map<string, { part: CatalogPart; score: number }>>();
    for (const t of TYPES) table.set(t, new Map());
    const src = visible.length ? visible.map((v) => v.part) : POPULAR_PARTS;
    for (const p of src) {
      const t = p.category as PartType;
      const m = table.get(t);
      if (!m) continue;
      const name = tidyName(p.name);
      if (t === 'Slope' && !/^Slope Brick 45 /.test(name)) continue;
      if (/pattern|sticker|\d x \d+ x \d/i.test(name)) continue;
      const sz = partSize(name);
      if (!sz) continue;
      const [a, b] = sz.split('x').map(Number);
      const key = `${Math.min(a, b)}x${Math.max(a, b)}`;
      const rest = name.replace(/^\S+( Brick 45)?/, '').replace(/\d+ x \d+/, '').trim();
      const score = (POP_RANK.get(p.id.toLowerCase()) ?? 500) * 100 + rest.length;
      const cur = m.get(key);
      if (!cur || score < cur.score) m.set(key, { part: p, score });
    }
    return table;
  }, [visible]);
}

export function PartPicker({ onPicked }: { onPicked: () => void }) {
  const { status, parts, visible, categories, search, retry } = usePartSearch();
  const activePart = useEditor((s) => s.activePart);
  const activeColor = useEditor((s) => s.activeColor);
  const setActivePart = useEditor((s) => s.setActivePart);
  const [query, setQuery] = useState('');
  const dq = useDeferredValue(query);
  const [type, setType] = useState<PartType>(() => {
    const cat = activePart ? partIndex(parts).get(activePart.toLowerCase())?.category : undefined;
    return TYPES.includes(cat as PartType) ? (cat as PartType) : 'Brick';
  });
  const [category, setCategory] = useState<string | null>(null);
  const sizes = useSizeTable(visible);
  const results = useMemo(() => (dq || category ? search(dq, category ?? ALL) : []), [dq, category, search]);

  const arm = (id: string) => {
    setActivePart(id);
    onPicked();
  };

  if (dq || category) {
    return (
      <div className="picker">
        <SearchBox value={query} onChange={setQuery} />
        <div className="picker-gridhead">
          {category && !dq && (
            <button className="btn small" onClick={() => setCategory(null)}>
              <IconBack size={16} /> {category}
            </button>
          )}
          <span className="catalog-count">{results.length.toLocaleString()} part{results.length === 1 ? '' : 's'}</span>
        </div>
        <PartGrid items={results} resetKey={`${category}|${dq}`} onPicked={onPicked} />
        {dq && !results.length && <div className="catalog-empty">No parts match “{dq}”.</div>}
      </div>
    );
  }

  const row = sizes.get(type)!;
  const more = categories.filter((c) => !TYPES.includes(c as PartType) && c !== 'Popular');
  return (
    <div className="picker">
      <SearchBox value={query} onChange={setQuery} />
      {status === 'error' && (
        <div className="catalog-note error">
          Couldn't load the full catalog. <button className="btn small" onClick={retry}>Retry</button>
        </div>
      )}
      <div className="picker-scroll">
        <div className="segmented picker-types" role="radiogroup" aria-label="Part type">
          {TYPES.map((t) => (
            <button key={t} role="radio" aria-checked={t === type} className={t === type ? 'active' : ''} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="sheet-label">Size · one tap arms the part</div>
        <div className="size-chips">
          {SIZES.filter((s) => row.has(s)).map((s) => {
            const p = row.get(s)!.part;
            return (
              <button
                key={s}
                className={`size-chip ${p.id === activePart ? 'active' : ''}`}
                onClick={() => arm(p.id)}
                title={`${partLabel(p.name)} (${p.id.replace(/\.dat$/i, '')})`}
              >
                {s}
              </button>
            );
          })}
          <button className="size-chip more" onClick={() => setCategory(type)}>more</button>
        </div>
        <PinnedRecent onArm={arm} color={activeColor} activePart={activePart} />
        <div className="sheet-label">More categories</div>
        <div className="chips wrap">
          {more.map((c) => (
            <button key={c} className="chip" onClick={() => setCategory(c)}>
              {c === ALL ? 'All parts…' : c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PinnedRecent({ onArm, color, activePart }: { onArm(id: string): void; color: number; activePart: string | null }) {
  const pinned = usePrefs((s) => s.pinnedParts);
  const recent = usePrefs((s) => s.recentParts);
  const { parts } = useCatalog();
  const idx = partIndex(parts);
  const list = [...pinned, ...recent.filter((r) => !pinned.includes(r))].slice(0, 12);
  if (!list.length) return null;
  return (
    <>
      <div className="sheet-label">Pinned ★ · Recent <span className="label-hint">long-press = pin</span></div>
      <div className="recent-row">
        {list.map((id) => (
          <RecentTile key={id} id={id} name={idx.get(id.toLowerCase())?.name} color={color} pinned={pinned.includes(id)} active={id === activePart} onArm={onArm} />
        ))}
      </div>
    </>
  );
}

function RecentTile({ id, name, color, pinned, active, onArm }: { id: string; name?: string; color: number; pinned: boolean; active: boolean; onArm(id: string): void }) {
  const togglePin = usePrefs((s) => s.togglePin);
  const lp = useLongPress(
    () => onArm(id),
    () => {
      togglePin(id);
      haptic('longpress');
      toast(pinned ? 'Unpinned' : 'Pinned to the hotbar', 'info', 1500);
    },
  );
  const label = name ? partLabel(name) : id.replace(/\.dat$/i, '');
  return (
    <button className={`recent-tile ${active ? 'active' : ''}`} {...lp} title={label}>
      <Thumb part={id} color={color} size={96} />
      <span className="part-name">{pinned && <IconStar size={11} filled />} {label}</span>
    </button>
  );
}

/** 6 recent / pinned parts above the bottom bar (phone) or in the sidebar (desktop, keys 1–6). */
export function Hotbar({ variant }: { variant: 'phone' | 'desktop' }) {
  const recent = usePrefs((s) => s.recentParts);
  const pinned = usePrefs((s) => s.pinnedParts);
  const togglePin = usePrefs((s) => s.togglePin);
  const activePart = useEditor((s) => s.activePart);
  const activeColor = useEditor((s) => s.activeColor);
  const tool = useEditor((s) => s.tool);
  const { parts } = useCatalog();
  const idx = partIndex(parts);
  const list = hotbarParts({ recentParts: recent, pinnedParts: pinned });
  return (
    <div className={`hotbar ${variant} ${variant === 'phone' ? 'panel' : ''}`} role="toolbar" aria-label="Recent parts">
      {list.map((id, i) => (
        <HotbarSlot
          key={id}
          id={id}
          n={i + 1}
          name={idx.get(id.toLowerCase())?.name ?? POPULAR_PARTS.find((p) => p.id === id)?.name}
          color={activeColor}
          active={id === activePart && tool === 'place'}
          pinned={pinned.includes(id)}
          showKey={variant === 'desktop'}
          onPin={() => {
            togglePin(id);
            haptic('longpress');
            toast(pinned.includes(id) ? 'Unpinned' : 'Pinned', 'info', 1400);
          }}
        />
      ))}
      {variant === 'phone' && (
        <button className="hotbar-all" onClick={() => openSheet('parts')} aria-label="All parts">
          <IconGrid size={20} />
          <span>All</span>
        </button>
      )}
    </div>
  );
}

function HotbarSlot({ id, n, name, color, active, pinned, showKey, onPin }: {
  id: string; n: number; name?: string; color: number; active: boolean; pinned: boolean; showKey: boolean; onPin(): void;
}) {
  const lp = useLongPress(() => {
    const s = useEditor.getState();
    s.select([]);
    s.setActivePart(id);
    s.setTool('place');
  }, onPin);
  const label = name ? partLabel(name) : id.replace(/\.dat$/i, '');
  const [size, ...rest] = label.split(' ');
  const hasSize = /^\d/.test(size);
  return (
    <button className={`hotbar-slot ${active ? 'active' : ''}`} {...lp} title={`${label}${showKey ? ` (${n})` : ''}`} aria-label={label} aria-pressed={active}>
      <Thumb part={id} color={color} size={96} />
      <span className="hotbar-label">{hasSize ? size : label}{hasSize && <small>{rest[0] ?? ''}</small>}</span>
      {pinned && <span className="hotbar-pin"><IconStar size={10} filled /></span>}
      {showKey && <kbd className="hotbar-key">{n}</kbd>}
    </button>
  );
}

/** Arm hotbar slot n (1-based) — keyboard 1–6. */
export function armHotbar(n: number): void {
  const p = usePrefs.getState();
  const id = hotbarParts(p)[n - 1];
  if (!id) return;
  const s = useEditor.getState();
  s.select([]);
  s.setActivePart(id);
  s.setTool('place');
}
