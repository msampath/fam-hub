import { Component, type ErrorInfo, type ReactNode } from 'react';
import { C } from './shell/theme';

// Top-level safety net: a render-time throw anywhere below shows a recoverable card instead of a blank white
// screen (the app is a kiosk/always-on display, so a silent crash is the worst failure mode). Class component
// because only the class lifecycle (getDerivedStateFromError / componentDidCatch) catches render errors.
interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log for diagnostics; the UI stays generic.
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.app, padding: 24 }}>
        <div style={{ maxWidth: 420, width: '100%', background: C.card, border: `2px solid ${C.elevated}`, borderRadius: 18, padding: 24, color: C.primary }}>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 14, color: C.ink, marginBottom: 18 }}>
            The app hit an unexpected error and stopped this view. Reloading usually fixes it — your data is safe.
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo, fontWeight: 800, borderRadius: 12, padding: '10px 18px', cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
