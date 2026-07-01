// Pre-auth screen for the LAN appliance (SQLite/local mode) — the Supabase-free counterpart to SignInGate.
// First run: set a household passphrase. After that: enter it to unlock the box. On success the parent
// is in (one shared household credential gates the box; the LAN is the perimeter). Dark-themed via `C`.
import { useState } from 'react';
import { APP_NAME } from '../constants';
import { C } from './shell/theme';
import { localSetup, localLogin } from '../supabase';

interface Props {
  configured: boolean;     // false → first-run setup; true → login
  onAuthed: () => void;    // called once a box session is minted
}

export default function LocalAuthGate({ configured, onAuthed }: Props) {
  const setup = !configured;
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (setup) {
      if (pass.length < 6) { setErr('Use at least 6 characters.'); return; }
      if (pass !== confirm) { setErr('Passphrases don’t match.'); return; }
    }
    setBusy(true);
    const res = setup ? await localSetup(pass) : await localLogin(pass);
    setBusy(false);
    if (!res.ok) { setErr(res.error || 'Something went wrong.'); return; }
    onAuthed();
  };

  const inputStyle = { background: C.app, border: `2px solid ${C.elevated}`, color: C.primary } as const;

  return (
    <div className="min-h-screen flex items-center justify-center p-4" id="local-auth-gate" style={{ background: C.app }}>
      <form onSubmit={submit} className="rounded-3xl max-w-sm w-full p-8 text-center" style={{ background: C.card, border: `2px solid ${C.elevated}`, boxShadow: '0 10px 40px rgba(0,0,0,0.55)' }}>
        <h1 className="text-2xl font-extrabold tracking-tight mb-1" style={{ color: C.primary }}>{APP_NAME}</h1>
        <p className="text-sm mb-6" style={{ color: C.muted }}>
          {setup
            ? 'Set a household passphrase to secure this box. Everyone in the home uses it to unlock the dashboard on your network.'
            : 'Enter your household passphrase to unlock the dashboard.'}
        </p>
        <input
          type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)}
          placeholder="Household passphrase" autoComplete={setup ? 'new-password' : 'current-password'}
          className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold mb-3 outline-none" style={inputStyle}
        />
        {setup && (
          <input
            type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            placeholder="Confirm passphrase" autoComplete="new-password"
            className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold mb-3 outline-none" style={inputStyle}
          />
        )}
        <button
          type="submit" disabled={busy || !pass}
          className="w-full mt-1 flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-xl px-5 py-2.5 hover:bg-indigo-700 transition-all text-sm font-semibold cursor-pointer disabled:opacity-60"
          id="local-auth-submit"
        >
          {busy ? 'Working…' : setup ? 'Create household' : 'Unlock'}
        </button>
        {err && <p className="text-xs mt-4" style={{ color: '#fb7185' }}>{err}</p>}
        <p className="text-[11px] mt-5" style={{ color: C.ink }}>Runs entirely on your network — no account, no cloud.</p>
      </form>
    </div>
  );
}
