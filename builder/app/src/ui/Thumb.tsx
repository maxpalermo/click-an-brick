import { useEffect, useRef, useState } from 'react';
import type { BrickyardEngine } from '../engine/types';
import { useEngine } from './context';

// Small concurrency-limited queue so scrolling a big catalog doesn't flood the engine.
const MAX_CONCURRENT = 3;
const cache = new Map<string, string>();
const failed = new Set<string>();
type Job = { key: string; run: () => Promise<void>; cancelled: boolean };
const queue: Job[] = [];
let active = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!;
    if (job.cancelled) continue;
    active++;
    job.run().finally(() => {
      active--;
      pump();
    });
  }
}

function requestThumb(
  engine: BrickyardEngine,
  part: string,
  color: number,
  size: number,
  done: (url: string | null) => void,
): () => void {
  const key = `${part}|${color}|${size}`;
  const hit = cache.get(key);
  if (hit) {
    done(hit);
    return () => {};
  }
  if (failed.has(key)) {
    done(null);
    return () => {};
  }
  let alive = true;
  const job: Job = {
    key,
    cancelled: false,
    run: async () => {
      try {
        const url = await engine.renderThumbnail(part, color, size);
        cache.set(key, url);
        if (alive) done(url);
      } catch {
        failed.add(key);
        if (alive) done(null);
      }
    },
  };
  queue.push(job);
  pump();
  return () => {
    alive = false;
    job.cancelled = true;
  };
}

interface Props {
  part: string;
  color: number;
  size?: number;
  className?: string;
}

/** Lazily rendered part thumbnail (starts when scrolled into view). */
export function Thumb({ part, color, size = 128, className }: Props) {
  const engine = useEngine();
  const ref = useRef<HTMLDivElement>(null);
  const key = `${part}|${color}|${size}`;
  const [state, setState] = useState<{ key: string; url: string | null; done: boolean }>(() => {
    const url = cache.get(key) ?? null;
    return { key, url, done: !!url };
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (state.key === key && state.done) return;
    return requestThumb(engine, part, color, size, (url) => setState({ key, url, done: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key, engine]);

  // Keep showing the previous image while a new colour renders (avoids flicker).
  const url = state.url;
  const loading = !(state.key === key && state.done);
  return (
    <div ref={ref} className={`thumb ${loading && !url ? 'is-loading' : ''} ${className ?? ''}`}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : !loading ? (
        <span className="thumb-fallback" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40%" height="40%" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="10" width="18" height="10" rx="2" />
            <path d="M7 10V8h3v2M14 10V8h3v2" />
          </svg>
        </span>
      ) : null}
    </div>
  );
}
