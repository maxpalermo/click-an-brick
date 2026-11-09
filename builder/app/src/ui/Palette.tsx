import { useMemo, useState, type CSSProperties } from 'react';
import type { BrickColor } from '../model/types';
import { useEditor } from '../model/store';
import { useColors } from './context';
import { COMMON_COLORS, COMMON_COLOR_CODES } from './data';
import { IconChevron } from './Icons';
import { actions } from './engineBridge';
import { usePrefs, useUi } from './prefs';

/** Hidden "virtual" codes in LDConfig (main colour / edge colour). */
const HIDDEN = new Set([16, 24]);

export function colorByCode(colors: BrickColor[], code: number): BrickColor | undefined {
  return colors.find((c) => c.code === code) ?? COMMON_COLORS.find((c) => c.code === code);
}

export function Swatch({
  color,
  active,
  onClick,
  size,
}: {
  color: BrickColor;
  active?: boolean;
  onClick?: () => void;
  size?: number;
}) {
  const trans = color.alpha < 255 || color.material === 'transparent';
  const style: CSSProperties = {
    ['--sw' as string]: color.hex,
    ['--sw-alpha' as string]: String(Math.max(0.35, color.alpha / 255)),
    width: size,
    height: size,
  };
  const cls = `swatch ${active ? 'active' : ''} ${trans ? 'trans' : ''} mat-${color.material ?? 'solid'}`;
  if (!onClick) return <span className={cls} style={style} title={color.name}><span /></span>;
  return (
    <button
      className={`swatch ${active ? 'active' : ''} ${trans ? 'trans' : ''} mat-${color.material ?? 'solid'}`}
      style={style}
      onClick={onClick}
      title={`${color.name} (${color.code})`}
      aria-label={color.name}
      aria-pressed={active}
    >
      <span />
    </button>
  );
}

export function Palette({ compact, onPicked }: { compact?: boolean; onPicked?: () => void }) {
  const colors = useColors();
  const activeColor = useEditor((s) => s.activeColor);
  const setActiveColor = useEditor((s) => s.setActiveColor);
  const [showAll, setShowAll] = useState(false);

  const common = useMemo(
    () => COMMON_COLOR_CODES.map((code) => colorByCode(colors, code)!).filter(Boolean),
    [colors],
  );
  const groups = useMemo(() => {
    const rest = colors.filter((c) => !HIDDEN.has(c.code) && !COMMON_COLOR_CODES.includes(c.code));
    const solid = rest.filter((c) => (c.material ?? 'solid') === 'solid' && c.alpha >= 255);
    const trans = rest.filter((c) => c.material === 'transparent' || (c.alpha < 255 && !c.material));
    const special = rest.filter((c) => !solid.includes(c) && !trans.includes(c));
    return [
      { name: 'Solid', list: solid },
      { name: 'Transparent', list: trans },
      { name: 'Metallic & special', list: special },
    ].filter((g) => g.list.length);
  }, [colors]);

  const active = colorByCode(colors, activeColor);
  void setActiveColor;
  // With a selection, picking a colour recolours it (one undo step) and sets the active colour.
  const choose = (code: number) => {
    actions.recolor(code);
    onPicked?.();
  };

  return (
    <div className={`palette ${compact ? 'compact' : ''}`}>
      <div className="palette-head">
        <span className="palette-current">
          {active && <Swatch color={active} size={18} />}
          <span>{active?.name ?? `Colour ${activeColor}`}</span>
        </span>
        {groups.length > 0 && (
          <button className="link-btn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            All colours <IconChevron size={16} className={showAll ? 'flip' : ''} />
          </button>
        )}
      </div>
      <div className="swatches">
        {common.map((c) => (
          <Swatch key={c.code} color={c} active={c.code === activeColor} onClick={() => choose(c.code)} />
        ))}
      </div>
      {showAll && (
        <div className="palette-all">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="palette-group">{g.name}</div>
              <div className="swatches">
                {g.list.map((c) => (
                  <Swatch key={c.code} color={c} active={c.code === activeColor} onClick={() => choose(c.code)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type MatTab = 'solid' | 'trans' | 'metal' | 'all';
const isTrans = (c: BrickColor) => c.material === 'transparent' || (c.alpha < 255 && !c.material);
const isSolid = (c: BrickColor) => (c.material ?? 'solid') === 'solid' && c.alpha >= 255;

/** Phone colour sheet (UX_REVIEW §3.5): current, recent, common, material tabs; 44 px swatches. */
export function ColourSheetBody({ onPicked }: { onPicked(keepOpen: boolean): void }) {
  const colors = useColors();
  const activeColor = useEditor((s) => s.activeColor);
  const selCount = useEditor((s) => s.selection.length);
  const recent = usePrefs((s) => s.recentColors);
  const pending = useUi((s) => s.pending.active);
  const [tab, setTab] = useState<MatTab>('solid');
  const active = colorByCode(colors, activeColor);
  const common = useMemo(() => COMMON_COLOR_CODES.map((c) => colorByCode(colors, c)!).filter(Boolean), [colors]);
  const recentColors = recent.map((c) => colorByCode(colors, c)).filter((c): c is BrickColor => !!c).slice(0, 6);
  const list = useMemo(() => {
    const all = colors.filter((c) => !HIDDEN.has(c.code) && !COMMON_COLOR_CODES.includes(c.code));
    if (tab === 'solid') return all.filter(isSolid);
    if (tab === 'trans') return all.filter(isTrans);
    if (tab === 'metal') return all.filter((c) => !isSolid(c) && !isTrans(c));
    return all;
  }, [colors, tab]);
  const choose = (code: number) => {
    const keep = useEditor.getState().selection.length > 0 || useUi.getState().pending.active;
    actions.recolor(code);
    onPicked(keep);
  };
  return (
    <div className="colour-sheet">
      <div className="colour-current">
        {active && <Swatch color={active} size={44} />}
        <div>
          <strong>{active?.name ?? `Colour ${activeColor}`}</strong>
          <small>LDraw {activeColor}{selCount && !pending ? ` · recolouring ${selCount} brick${selCount === 1 ? '' : 's'}` : ''}</small>
        </div>
      </div>
      {recentColors.length > 1 && (
        <>
          <div className="sheet-label">Recent</div>
          <div className="swatches big">
            {recentColors.map((c) => <Swatch key={c.code} color={c} active={c.code === activeColor} onClick={() => choose(c.code)} />)}
          </div>
        </>
      )}
      <div className="sheet-label">Common</div>
      <div className="swatches big">
        {common.map((c) => <Swatch key={c.code} color={c} active={c.code === activeColor} onClick={() => choose(c.code)} />)}
      </div>
      <div className="segmented colour-tabs" role="tablist" aria-label="Material">
        {(
          [
            ['solid', 'Solid'],
            ['trans', 'Trans'],
            ['metal', 'Metallic'],
            ['all', 'All'],
          ] as Array<[MatTab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="swatches big">
        {list.map((c) => <Swatch key={c.code} color={c} active={c.code === activeColor} onClick={() => choose(c.code)} />)}
        {!list.length && <span className="muted">No more colours here.</span>}
      </div>
    </div>
  );
}
