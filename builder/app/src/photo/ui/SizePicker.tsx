// "Model size" control on the Confirm screen (size.ts): presets per mode, a studs slider for Custom, the expected
// part count, a warning for very large models on phones, and (LEGO, no brick marked) "Size: estimated by AI".
import type { PhotoMode } from '../types';
import { Brick2x2Art, IconAlert } from './icons';
import { MAX_STUDS, MIN_STUDS, bricksTall, clampStuds, estimateSize, studsWide, type Measure } from './scale';
import { PHONE_WARN_STUDS, fmtParts, partRange, presetsFor, targetStuds, type PresetInfo, type SizeChoice } from './size';

interface Props {
  mode: PhotoMode;
  measure: Measure;
  size: SizeChoice;
  setSize(s: SizeChoice): void;
  /** Open the Real size screen to mark a 2×2 brick. */
  onRealSize(): void;
}

export function SizePicker({ mode, measure, size, setSize, onRealSize }: Props) {
  const est = estimateSize(measure);
  const exact = est.lifeSize;
  const presets = presetsFor(mode, exact);
  const studs = targetStuds(size, mode, measure);
  const range = studs !== null ? partRange(studs) : null;
  const big = studs !== null && studs > PHONE_WARN_STUDS;

  const sub = (p: PresetInfo): string => {
    if (p.id === 'real') return exact ? `exact · ~${targetStuds({ preset: 'real', studs: size.studs }, mode, measure)} studs` : 'estimated by AI';
    if (p.id === 'custom') return `${clampStuds(size.studs)} studs`;
    return mode === 'lego' ? `~${p.studs} studs` : `${p.studs} studs`;
  };
  const pick = (p: PresetInfo) => setSize({ preset: p.id, studs: size.studs });
  const setStuds = (n: number) => setSize({ preset: 'custom', studs: clampStuds(n) });

  return (
    <div className="pf-sizepick">
      <div className="pf-sizepick-head">
        <strong id="pf-size-title">Model size</strong>
        <small>longest side, in studs</small>
      </div>
      <div className={`pf-presets${presets.length > 4 ? ' with-real-row' : ''}`} role="radiogroup" aria-labelledby="pf-size-title">
        {presets.map((p) => (
          <button key={p.id} role="radio" aria-checked={size.preset === p.id} className={`pf-preset${size.preset === p.id ? ' active' : ''}`}
            onClick={() => pick(p)}>
            <strong>{p.label}</strong>
            <small>{sub(p)}</small>
          </button>
        ))}
      </div>

      {size.preset === 'custom' && (
        <div className="pf-size-row light">
          <button className="pf-step" onClick={() => setStuds(size.studs - 2)} aria-label="Smaller">−</button>
          <input type="range" className="pf-range" min={MIN_STUDS} max={MAX_STUDS} step={1} value={clampStuds(size.studs)}
            onChange={(e) => setStuds(Number(e.target.value))} aria-label="Longest side in studs" aria-valuetext={`${size.studs} studs`} />
          <button className="pf-step" onClick={() => setStuds(size.studs + 2)} aria-label="Bigger">+</button>
          <span className="pf-size-readout"><strong>{clampStuds(size.studs)}</strong> studs</span>
        </div>
      )}

      {size.preset === 'real' && !exact ? (
        <div className="pf-size-est" role="status">
          <Brick2x2Art size={34} />
          <span>
            <strong>Size: estimated by AI</strong>
            <small>The AI counts the studs in your photo, so a big build stays big (up to {MAX_STUDS} studs).</small>
            <button className="pf-inline-link" onClick={onRealSize}>Mark a 2×2 brick for exact size</button>
          </span>
        </div>
      ) : (
        <p className="pf-size-info" aria-live="polite">
          {size.preset === 'real' && exact && <>Life size ≈ <strong>{studsWide(est)}</strong> studs wide · {bricksTall(est)} bricks tall. </>}
          {range && <>About <strong>{fmtParts(range[0])}–{fmtParts(range[1])}</strong> parts.</>}
        </p>
      )}
      {big && range && (
        <div className="pf-warn" role="status">
          <IconAlert size={18} />
          <span>Big model: building it may be slow on a phone, up to {range[1] >= 1000 ? `${(range[1] / 1000).toFixed(1).replace(/\.0$/, '')} thousand` : range[1]} parts.</span>
        </div>
      )}
      {size.preset === 'real' && !exact && (
        <p className="pf-help">Big LEGO builds can come out with thousands of parts, which takes a while on a phone.</p>
      )}
    </div>
  );
}
