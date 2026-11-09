// Entry points into the Photo to Bricks flow, used by app/src/ui/Editor.tsx and EditorChrome.tsx.
import { useEditor } from '../../model/store';
import { IconPhoto } from './icons';
import { openPhotoFlow, usePhotoFlow } from './store';
import './photo.css';

export { PhotoFlowHost } from './PhotoFlow';
export { openPhotoFlow } from './store';

/** Prominent desktop top-bar button. */
export function PhotoTopBarButton() {
  return (
    <button className="btn photo-cta" onClick={openPhotoFlow} title="Build from a photo">
      <IconPhoto size={18} /> <span className="photo-cta-label">Photo</span>
    </button>
  );
}

/** Big button for the phone "More" sheet. */
export function PhotoSheetButton({ onBefore }: { onBefore?: () => void }) {
  return (
    <button className="btn photo-sheet-btn" onClick={() => { onBefore?.(); openPhotoFlow(); }}>
      <span className="photo-sheet-icon"><IconPhoto size={22} /></span>
      <span className="photo-sheet-text">
        <strong>Build from a photo</strong>
        <small>Snap an object, get a brick model</small>
      </span>
    </button>
  );
}

/** Empty-state hint over the canvas when the build has no bricks. */
export function PhotoHint() {
  const empty = useEditor((s) => s.model.bricks.length === 0 && !s.readOnly);
  const open = usePhotoFlow((s) => s.open);
  if (!empty || open) return null;
  return (
    <div className="photo-hint panel">
      <span className="photo-hint-icon"><IconPhoto size={22} /></span>
      <span className="photo-hint-text">
        <strong>Empty yard?</strong>
        <small>Start by placing bricks, or…</small>
      </span>
      <button className="btn primary small photo-hint-btn" onClick={openPhotoFlow}>Build from a photo</button>
    </div>
  );
}
