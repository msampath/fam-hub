// Pre-auth screens (rendered BEFORE the AppContext provider, so this takes plain props).
// Shows a loading splash until the session is resolved, then a blocking Google sign-in.
// Dark-themed to match the app (single always-on dark theme) via the shared `C` tokens.
import { APP_NAME } from '../constants';
import { C } from './shell/theme';

interface SignInGateProps {
  authChecked: boolean;
  onLogin: () => void;
  onTryDemo?: () => void; // no-login demo (Supabase anonymous auth) — capstone judge / headless eval entry
  errorStatus: string | null;
}

export default function SignInGate({ authChecked, onLogin, onTryDemo, errorStatus }: SignInGateProps) {
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.app }}>
        <div className="flex flex-col items-center gap-3" style={{ color: C.muted }}>
          <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: C.indigo, borderTopColor: 'transparent' }}></div>
          <span className="text-xs font-semibold">Loading {APP_NAME}…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" id="signin-gate" style={{ background: C.app }}>
      <div className="rounded-3xl max-w-sm w-full p-8 text-center" style={{ background: C.card, border: `2px solid ${C.elevated}`, boxShadow: '0 10px 40px rgba(0,0,0,0.55)' }}>
        <h1 className="text-2xl font-extrabold tracking-tight flex items-center justify-center gap-2 mb-1" style={{ color: C.primary }}>
          {APP_NAME}
        </h1>
        <p className="text-sm mb-6" style={{ color: C.muted }}>Sign in with Google to access your family dashboard and sync across all your devices.</p>
        <button
          type="button"
          onClick={onLogin}
          className="mx-auto flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 transition-all hover:brightness-110 text-sm font-semibold cursor-pointer"
          style={{ background: C.elevated, border: `2px solid ${C.faint}`, color: C.primary }}
          id="google-authenticate-btn"
        >
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-5 h-5">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
          </svg>
          <span>Sign in with Google</span>
        </button>

        {/* No-login demo (Supabase anonymous auth) — a one-click, per-visitor isolated sandbox seeded
            with a sample family. Stable id so a headless evaluator can find it. */}
        {onTryDemo && (
          <>
            <div className="flex items-center gap-3 my-4">
              <span className="h-px flex-1" style={{ background: C.elevated }} />
              <span className="text-[11px] font-semibold" style={{ color: C.ink }}>or</span>
              <span className="h-px flex-1" style={{ background: C.elevated }} />
            </div>
            <button
              type="button"
              onClick={onTryDemo}
              id="evaluator-demo-login"
              className="mx-auto flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-xl px-5 py-2.5 hover:bg-indigo-700 transition-all shadow-sm text-sm font-semibold cursor-pointer w-full"
            >
              Try the demo — no sign-in
            </button>
            <p className="text-[11px] mt-2" style={{ color: C.ink }}>A private sandbox with a sample family. Nothing is shared.</p>
          </>
        )}
        {errorStatus && <p className="text-xs mt-4" style={{ color: '#fb7185' }}>{errorStatus}</p>}
      </div>
    </div>
  );
}
