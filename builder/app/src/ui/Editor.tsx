import { useCallback, useState } from 'react';
import { t } from '../i18n';
import { useEditor } from '../model/store';
import { Catalog } from './Catalog';
import { useEngine } from './context';
import { EmptyState, Tip } from './Coach';
import { DesktopTopBar, LayerStepper, ShortcutsBody, StatusPill, useEditorCommands, useShortcuts } from './EditorChrome';
import { useEngineBridge, useInsetReporter } from './engineBridge';
import { useIsPhone } from './hooks';
import { Modal } from './Overlays';
import { MyBuildsScreen, UnsavedGuard } from './MyBuilds';
import { Palette } from './Palette';
import { armHotbar, Hotbar } from './PartPicker';
import { DesktopContextBar } from './PendingBar';
import { PhoneChrome } from './PhoneChrome';
import { closeSheet, openSheet, useUi } from './prefs';
import { ShareDialog } from './ShareDialog';
import { PhotoFlowHost } from '../photo/ui/EntryPoints';

export function Editor() {
  const engine = useEngine();
  const isPhone = useIsPhone();
  const viewMode = useEditor((s) => s.viewMode);
  const sheet = useUi((s) => s.sheet);
  const [sharing, setSharing] = useState(false);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const cmd = useEditorCommands({ onShare: () => setSharing(true) });
  useShortcuts(cmd, true, { onHelp: () => openSheet('shortcuts'), armHotbar });
  useEngineBridge(engine);
  useInsetReporter(engine, root);
  // Report insets for the whole overlay (toasts live next to the editor chrome).
  const rootRef = useCallback((el: HTMLDivElement | null) => setRoot(el?.parentElement ?? null), []);

  return (
    <div className="editor-root" ref={rootRef}>
      {isPhone ? <PhoneChrome cmd={cmd} /> : (
        <>
          <DesktopTopBar cmd={cmd} />
          <aside className="sidebar panel" data-inset="left">
            <div className="sidebar-title">{t('side.recent')} <span className="label-hint">{t('side.recent.hint')}</span></div>
            <Hotbar variant="desktop" />
            <div className="sidebar-title">{t('side.bricks')}</div>
            <Catalog />
          </aside>
          <div className="palette-dock panel">
            <Palette />
          </div>
          <DesktopContextBar />
          <StatusPill />
        </>
      )}
      {viewMode === '2d' && <LayerStepper />}
      <EmptyState onOpen={cmd.importFile} />
      <Tip />
      <PhotoFlowHost />
      {sheet === 'shortcuts' && (
        <Modal title={t('ed.shortcuts')} onClose={closeSheet} className="shortcuts-modal">
          <ShortcutsBody />
        </Modal>
      )}
      {sharing && <ShareDialog model={useEditor.getState().model} onClose={() => setSharing(false)} />}
      <MyBuildsScreen />
      <UnsavedGuard />
    </div>
  );
}
