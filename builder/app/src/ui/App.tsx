import { Component, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useEngine } from './context';
import { Editor } from './Editor';
import { useRoute } from './hooks';
import { Toasts } from './Overlays';
import { leaveViewer } from './session';
import { bindArchiveEngine } from './archive';
import { Viewer } from './Viewer';

export function App() {
  const engine = useEngine();
  const route = useRoute();
  const hostRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // Mount the engine canvas once; it persists across editor/viewer.
  useLayoutEffect(() => {
    if (hostRef.current && !mounted.current) {
      mounted.current = true;
      engine.mount(hostRef.current);
      bindArchiveEngine(engine);
    }
  }, [engine]);

  // Leaving the viewer restores the user's own build.
  useEffect(() => {
    if (route.name === 'editor') leaveViewer();
  }, [route]);

  return (
    <div className={`app ${route.name}`}>
      <div className="canvas-host" ref={hostRef} />
      <div className="overlay">
        <ErrorBoundary>
          {route.name === 'viewer' ? <Viewer key={route.id} id={route.id} /> : <Editor />}
        </ErrorBoundary>
        <Toasts />
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="viewer-center panel">
          <h2>Oops — something broke</h2>
          <p className="muted">{this.state.error.message}</p>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
