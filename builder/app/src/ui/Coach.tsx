// Empty-state card and one-time contextual tips (UX_REVIEW §3.9). Touch wording on touch
// devices, keyboard wording with a mouse.
import { useState } from 'react';
import { useEditor } from '../model/store';
import { openPhotoFlow, usePhotoFlow } from '../photo/ui/store';
import { useCatalog, partIndex, useMedia } from './hooks';
import { useColors } from './context';
import { IconGrid, IconImport } from './Icons';
import { openMyBuilds, useArchive } from './archive';
import { IconPhoto } from '../photo/ui/icons';
import { colorByCode } from './Palette';
import { partLabel } from './Catalog';
import { POPULAR_PARTS } from './data';
import { dismissTip, useUi, type TipId } from './prefs';

export const useIsTouch = () => useMedia('(pointer: coarse)');

const TIPS: Record<TipId, { touch: string; mouse: string }> = {
  pending: {
    touch: 'Drag the arrows to fine-tune · tap the brick again to place it.',
    mouse: 'Arrow keys nudge · R rotates · PageUp lifts · Enter places · Esc cancels.',
  },
  placed: {
    touch: 'Keep tapping to build · long-press a brick to edit it.',
    mouse: 'Keep clicking to build · Shift-click previews first · V selects bricks to edit.',
  },
  orbit: {
    touch: '1 finger turns · 2 fingers move and zoom · double-tap to frame.',
    mouse: 'Drag to orbit · right-drag pans · scroll zooms · F frames everything.',
  },
  '2d': {
    touch: 'One layer at a time. 1 finger pans here · drag the layer number to scrub.',
    mouse: 'One layer at a time. PageUp / PageDown change layer.',
  },
  select: {
    touch: 'Drag the arrows to move it · Add more selects several · Delete is undoable.',
    mouse: 'Arrows nudge · Ctrl+D duplicates · Delete removes · Esc deselects. Press ? for all keys.',
  },
};

export function Tip() {
  const tip = useUi((s) => s.tip);
  const sheet = useUi((s) => s.sheet);
  const touch = useIsTouch();
  if (!tip || sheet) return null;
  return (
    <div className="tip panel" role="note">
      <span className="tip-dot" aria-hidden="true" />
      <p>{touch ? TIPS[tip].touch : TIPS[tip].mouse}</p>
      <button className="btn small" onClick={dismissTip}>Got it</button>
    </div>
  );
}

/** "Let's build!" card while the build is empty (§3.9, wireframe 08). */
export function EmptyState({ onOpen }: { onOpen(): void }) {
  const [dismissed, setDismissed] = useState(false);
  const empty = useEditor((s) => s.model.bricks.length === 0 && !s.readOnly);
  const part = useEditor((s) => s.activePart);
  const code = useEditor((s) => s.activeColor);
  const pending = useUi((s) => s.pending.active);
  const sheet = useUi((s) => s.sheet);
  const photoOpen = usePhotoFlow((s) => s.open);
  const buildsOpen = useArchive((s) => s.open);
  const colors = useColors();
  const { parts } = useCatalog();
  const touch = useIsTouch();
  if (!empty || pending || photoOpen || buildsOpen || sheet || dismissed) return null;
  const name = part ? partIndex(parts).get(part.toLowerCase())?.name ?? POPULAR_PARTS.find((p) => p.id === part)?.name : undefined;
  const label = name ? partLabel(name).split(' ').slice(0, 2).join(' ').toLowerCase() : 'brick';
  const colour = colorByCode(colors, code)?.name.toLowerCase() ?? '';
  return (
    <div className="empty-state panel" role="note">
      <button
        className="empty-close"
        aria-label="Close"
        title="Close"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
      <div className="empty-target" aria-hidden="true" />
      <strong>Let's build!</strong>
      {touch ? (
        <p>
          Tap the grid to drop a {colour} {label}.<br />Adjust it, then tap it again to place.
        </p>
      ) : (
        <p>
          Click the grid to place a {colour} {label}.<br />Shift-click to preview it first.
        </p>
      )}
      <div className="empty-actions">
        <button className="btn" onClick={openPhotoFlow}><IconPhoto size={18} /> From a photo</button>
        <button className="btn" onClick={openMyBuilds}><IconGrid size={18} /> My builds</button>
        <button className="btn" onClick={onOpen}><IconImport size={18} /> Open .ldr</button>
      </div>
    </div>
  );
}
