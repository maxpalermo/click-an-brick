import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { toLdr } from '../model/ldraw';
import type { Model } from '../model/types';
import { Modal, Spinner } from './Overlays';
import { IconCheck, IconCopy, IconShare, IconWhatsApp } from './Icons';
import { toast } from './toast';
import { saveCurrent } from './archive';

const SHARE_TEXT = 'Check out my Brickyard build!';

export function shareUrl(id: string): string {
  return `${location.origin}${location.pathname}#/m/${id}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; url: string };
type Archived = 'saving' | 'saved' | 'failed' | null;

export function ShareDialog({ model, onClose }: { model: Model; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [archived, setArchived] = useState<Archived>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    api
      .shareModel(model.name || 'My build', toLdr(model))
      .then(({ id }) => {
        if (!alive) return;
        setState({ kind: 'done', url: shareUrl(id) });
        // Sharing also keeps the build in My builds (with its share link), quietly.
        setArchived('saving');
        void saveCurrent({ shareId: id, quiet: true }).then((r) => alive && setArchived(r ? 'saved' : 'failed'));
      })
      .catch((e: unknown) =>
        alive && setState({ kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' }),
      );
    return () => {
      alive = false;
    };
    // Share the model as it was when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const copy = async (url: string) => {
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      inputRef.current?.select();
      toast('Press Ctrl+C to copy the link', 'info');
    }
  };

  const nativeShare = async (url: string) => {
    try {
      await navigator.share({ title: model.name || 'Brickyard build', text: SHARE_TEXT, url });
    } catch {
      /* user cancelled */
    }
  };

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <Modal title="Share your build" onClose={onClose} className="share-modal">
      {state.kind === 'loading' && (
        <div className="share-loading">
          <Spinner size={22} /> Creating your link…
        </div>
      )}
      {state.kind === 'error' && (
        <div className="share-error">
          <p>Couldn't create a share link. {state.message}</p>
          <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      )}
      {state.kind === 'done' && (
        <>
          <p className="muted">
            Anyone with this link can view <strong>{model.name || 'your build'}</strong> in 3D and remix a copy.
          </p>
          <div className="share-link">
            <input ref={inputRef} readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <button className="btn primary" onClick={() => copy(state.url)} data-autofocus>
              {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {archived && archived !== 'failed' && (
            <p className="share-archived">
              {archived === 'saving' ? <><Spinner size={12} /> Saving to My builds…</> : <><IconCheck size={14} /> Saved to My builds</>}
            </p>
          )}
          <div className="share-actions">
            {canNativeShare && (
              <button className="btn" onClick={() => nativeShare(state.url)}>
                <IconShare size={18} /> Share…
              </button>
            )}
            <a
              className="btn whatsapp"
              href={`https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${state.url}`)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <IconWhatsApp size={18} /> WhatsApp
            </a>
          </div>
        </>
      )}
    </Modal>
  );
}
