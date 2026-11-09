import { useEffect, useMemo, useRef, useState } from 'react';
import { t, tp } from '../i18n';
import { api } from '../api/client';
import { fromLdr } from '../model/ldraw';
import type { Model } from '../model/types';
import { tidyName } from './Catalog';
import { useColors, useEngine } from './context';
import { CAMERAS, Menu, StatusPill } from './EditorChrome';
import { navigate, partIndex, useCatalog, useIsPhone } from './hooks';
import { IconCamera, IconCheck, IconChevron, IconFit, IconGrid, Logo } from './Icons';
import { openMyBuilds, saveModelAsNew } from './archive';
import { Spinner } from './Overlays';
import { colorByCode, Swatch } from './Palette';
import { beginViewer, enterViewer, remix } from './session';
import { Thumb } from './Thumb';
import { toast } from './toast';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; notFound: boolean }
  | { kind: 'ready'; model: Model; ldr: string; createdAt?: string };

export function Viewer({ id }: { id: string }) {
  const engine = useEngine();
  const isPhone = useIsPhone();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [listOpen, setListOpen] = useState(!isPhone);
  const [kept, setKept] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    beginViewer();
    api
      .getSharedModel(id)
      .then((shared) => {
        if (!alive) return;
        const model = fromLdr(shared.ldr);
        if (shared.name) model.name = shared.name;
        enterViewer(model);
        setState({ kind: 'ready', model, ldr: shared.ldr, createdAt: shared.createdAt });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: 'error', notFound: /404|not.?found/i.test(msg) });
      });
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  // Frame the model once its parts finished loading (and once right away).
  const fitted = useRef(false);
  useEffect(() => {
    if (state.kind !== 'ready') return;
    fitted.current = false;
    const t = window.setTimeout(() => engine.zoomToFit(), 60);
    let sawPending = false;
    const off = engine.onLoading((n) => {
      if (n > 0) sawPending = true;
      else if (sawPending && !fitted.current) {
        fitted.current = true;
        engine.zoomToFit();
      }
    });
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, [state, engine]);

  if (state.kind === 'loading') {
    return (
      <div className="viewer-center panel">
        <Spinner size={24} />
        <p>{t('vw.loading')}</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="viewer-center panel">
        <Logo size={48} />
        <h2>{state.notFound ? t('vw.notfound') : t('vw.loaderr')}</h2>
        <p className="muted">
          {state.notFound ? t('vw.notfound.desc') : t('vw.loaderr.desc')}
        </p>
        <div className="row">
          {!state.notFound && <button className="btn" onClick={() => setAttempt((n) => n + 1)}>{t('vw.retry')}</button>}
          <a className="btn primary" href="#/">{t('vw.open')}</a>
        </div>
      </div>
    );
  }

  const model = state.model;
  const ldr = state.ldr;
  const doKeep = async () => {
    if (kept !== 'idle') return;
    setKept('saving');
    const saved = await saveModelAsNew(model, { ldr, shareId: id });
    setKept(saved ? 'saved' : 'idle');
    if (saved) {
      toast(t('vw.saved', { name: saved.name }), 'success', 4500, {
        label: t('vw.show'),
        run: () => {
          navigate('#/');
          openMyBuilds();
        },
      });
    }
  };
  const doRemix = () => {
    remix(model);
    navigate('#/');
    toast(t('vw.remixed'), 'success', 4500);
  };

  return (
    <>
      <header className="topbar viewer-bar panel">
        <a className="brand" href="#/" aria-label={t('vw.open')}>
          <Logo size={30} />
          {!isPhone && <span className="brand-name">Brickyard</span>}
        </a>
        <div className="viewer-title">
          <strong>{model.name || t('vw.shared')}</strong>
          <small>{tp('status.bricks', model.bricks.length)}{model.author && model.author !== 'Brickyard' ? t('vw.by', { name: model.author }) : ''}</small>
        </div>
        <div className="spacer" />
        <Menu title={t('cam.menu')} icon={<IconCamera />}>
          {(close) => CAMERAS.map((c) => (
            <button key={c.id} role="menuitem" onClick={() => { engine.setCameraPreset(c.id); close(); }}>{t(c.labelKey)}</button>
          ))}
        </Menu>
        <button className="icon-btn" onClick={() => engine.zoomToFit()} title={t('top.fit')} aria-label={t('pm.fitall')}><IconFit /></button>
        <button
          className={isPhone ? 'icon-btn' : 'btn'}
          onClick={() => void doKeep()}
          disabled={kept !== 'idle'}
          title={t('vw.keep.title')}
          aria-label={kept === 'saved' ? t('save.savedtitle') : t('vw.keep')}
        >
          {kept === 'saving' ? <Spinner size={16} /> : kept === 'saved' ? <IconCheck size={18} /> : <IconGrid size={18} />}
          {!isPhone && (kept === 'saved' ? t('vw.keep.saved') : t('vw.keep'))}
        </button>
        <button className="btn primary" onClick={doRemix}>{isPhone ? t('vw.remix') : t('vw.remix.long')}</button>
      </header>

      <aside className={`parts-panel panel ${listOpen ? 'open' : ''}`}>
        <button className="parts-toggle" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
          <span>{t('vw.partslist')}</span>
          <IconChevron size={18} className={listOpen ? 'flip' : ''} />
        </button>
        {listOpen && <PartsList model={model} />}
        {listOpen && (
          <div className="parts-foot">
            <a href="#/" className="link-btn">{t('vw.open')}</a>
          </div>
        )}
      </aside>
      <StatusPill />
    </>
  );
}

function PartsList({ model }: { model: Model }) {
  const colors = useColors();
  const { parts } = useCatalog();
  const idx = partIndex(parts);
  const groups = useMemo(() => {
    const m = new Map<string, { part: string; color: number; count: number }>();
    for (const b of model.bricks) {
      const k = `${b.part}|${b.color}`;
      const g = m.get(k);
      if (g) g.count++;
      else m.set(k, { part: b.part, color: b.color, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
  }, [model]);

  return (
    <ul className="parts-list">
      {groups.map((g) => {
        const c = colorByCode(colors, g.color);
        const name = idx.get(g.part.toLowerCase())?.name;
        return (
          <li key={`${g.part}|${g.color}`}>
            <Thumb part={g.part} color={g.color} size={96} className="small" />
            <div className="pl-text">
              <span className="pl-name">{name ? tidyName(name) : g.part.replace(/\.dat$/i, '')}</span>
              <span className="pl-color">
                {c && <Swatch color={c} size={12} />} {c?.name ?? `${t('palette.colour')} ${g.color}`} · {g.part.replace(/\.dat$/i, '')}
              </span>
            </div>
            <span className="pl-count">×{g.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

