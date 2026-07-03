import { useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import type { DigestPrefs } from '../../types';
import { X, LogOut, Trash2, UserPlus, Pencil, RefreshCw } from 'lucide-react';
import { useApp } from '../../AppContext';
import { useCalendar } from '../../CalendarContext';
import { useModalA11y } from '../../hooks/useModalA11y';
import {
  IDLE_TIMEOUT_OPTIONS, IDLE_SIGNOUT_OPTIONS, REMINDER_TIME_OPTIONS, REMINDER_LEAD_OPTIONS, MEMBER_COLORS_LIST,
} from '../../constants';
import GoogleSyncPanel from '../calendar/GoogleSyncPanel';
import { getBackendMode, localChangePassphrase } from '../../supabase';
import { C, memberHex } from './theme';

// The account/idle/reminder settings that live in App() (not in context) — passed straight through.
export interface AccountSettings {
  user: User | null;
  nickname?: string;
  onSignOut: () => void | Promise<void>;
  onLinkProfile?: () => void;
  idleTimeoutMs: number;
  onChangeIdleTimeout: (ms: number) => void;
  signOutMs: number;
  onChangeSignOut: (ms: number) => void;
  remindersEnabled: boolean;
  onToggleReminders: (enabled: boolean) => void;
  reminderTime: number;
  onChangeReminderTime: (minutes: number) => void;
  reminderLead: number;
  onChangeReminderLead: (minutes: number) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  autoScanEnabled: boolean;
  onToggleAutoScan: (enabled: boolean) => void;
}

interface ManageProps {
  account: AccountSettings;
  onClose: () => void;
}

const field = { background: C.card, border: `2px solid ${C.elevated}`, color: C.primary } as const;

// Hoisted to MODULE scope (NOT defined inside Manage): a component declared in the render body gets a new
// identity every render, so React would remount the whole subtree on each keystroke — stealing focus from
// the input being typed in and scrolling to top (the PIN-field bug). Module-scope keeps their identity stable.
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded-[18px] p-5" style={{ border: `2px solid ${C.elevated}`, background: C.app }}>
    <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.muted }}>{title}</div>
    {children}
  </div>
);

const Select = ({ value, onChange, options }: { value: number; onChange: (v: number) => void; options: { label: string; ms?: number; minutes?: number }[] }) => (
  <select
    value={value}
    onChange={e => onChange(Number(e.target.value))}
    className="rounded-[10px] px-3 py-2 text-sm font-semibold outline-none"
    style={field}
  >
    {options.map(o => {
      const v = (o.ms ?? o.minutes) as number;
      return <option key={o.label} value={v} style={{ background: C.card }}>{o.label}</option>;
    })}
  </select>
);

// "Manage" overlay (the home for everything that doesn't fit the copilot-first 4-page flow):
// account, family members + invites, dietary/interests, calendar sync + import.
export default function Manage({ account, onClose }: ManageProps) {
  const {
    familyMembers, setFamilyMembers,
    handleDeleteMember, handleRenameMember, handleAddMember, newMemberName, setNewMemberName,
    newMemberRole, setNewMemberRole, newMemberColor, setNewMemberColor,
    newMemberDietary, setNewMemberDietary, newMemberInterests, setNewMemberInterests,
    newMemberAge, setNewMemberAge,
    inviteCodeInput, setInviteCodeInput, isJoiningHousehold, handleJoinHousehold,
    hasStepUpPin, setStepUpPin, verifyStepUpPin, digestPrefs, setDigestPrefs,
    kidMode, setKidMode,
  } = useApp();
  // Daily-briefing email prefs (single-element blob); merge-patch the one entry.
  const digest: DigestPrefs = digestPrefs[0] || { enabled: false, email: account.user?.email || '', sendHour: 7 };
  const setDigest = (patch: Partial<typeof digest>) => setDigestPrefs([{ ...digest, ...patch }]);
  // Recipients — a LIST so each parent can add their own email (the digest is one shared household pref). The
  // legacy single `email` is merged in (de-duped + valid); add/remove migrate to `emails` and clear `email`.
  const isEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
  const recipients: string[] = Array.from(new Set(
    [...(digest.emails || []), ...(digest.email ? [digest.email] : [])].map(e => String(e || '').trim()).filter(Boolean),
  ));
  const setRecipients = (list: string[]) =>
    setDigest({ emails: Array.from(new Set(list.map(e => e.trim()).filter(Boolean))), email: '' });
  const [newRecipient, setNewRecipient] = useState(account.user?.email || '');
  const canAddRecipient = isEmail(newRecipient) && !recipients.includes(newRecipient.trim());
  const addRecipient = () => { if (canAddRecipient) { setRecipients([...recipients, newRecipient.trim()]); setNewRecipient(''); } };
  const { homeLabel, saveHomeLocation, cloudInviteCode } = useCalendar();
  // Escape-to-close + focus trap/restore. No backdrop-click-close here — settings has live inputs (PIN,
  // home location) a stray click shouldn't discard; the X (and Escape) are the deliberate close.
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const [homeInput, setHomeInput] = useState('');
  const [homeMsg, setHomeMsg] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [currentPinInput, setCurrentPinInput] = useState(''); // required to CHANGE an existing PIN
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [copied, setCopied] = useState(false);
  const copyInvite = (code: string) => {
    const p = navigator.clipboard?.writeText(code);
    if (p) p.then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  const updateMember = (name: string, patch: { dietary?: string; interests?: string; color?: string; age?: number }) =>
    setFamilyMembers(prev => prev.map(m => (m.name === name ? { ...m, ...patch } : m)));
  const parseAge = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n < 120 ? n : undefined;
  };
  const submitRename = (oldName: string) => {
    const next = editName.trim();
    if (next && next !== oldName) handleRenameMember(oldName, next);
    setEditingMember(null);
  };

  const saveHome = async () => {
    if (!homeInput.trim()) return;
    setHomeMsg('Saving…');
    const r = await saveHomeLocation(homeInput.trim());
    setHomeMsg(r.ok ? `Saved: ${r.label}` : (r.error || 'Could not find that location.'));
    if (r.ok) setHomeInput('');
  };

  const savePin = async () => {
    // First-time set goes straight through; CHANGING an existing PIN requires the current PIN (verified
    // server-side via verifyStepUpPin) so someone at an unlocked screen can't silently overwrite it.
    if (hasStepUpPin) {
      if (!currentPinInput.trim()) { setPinMsg('Enter your current PIN to change it.'); return; }
      setPinMsg('Verifying…');
      const ok = await verifyStepUpPin(currentPinInput);
      if (!ok) { setPinMsg('Current PIN is incorrect.'); return; }
    }
    setPinMsg('Saving…');
    const r = await setStepUpPin(pinInput);
    setPinMsg(r.ok ? 'PIN saved.' : (r.error || 'Invalid PIN (4–8 digits).'));
    if (r.ok) { setPinInput(''); setCurrentPinInput(''); }
  };

  // Household passphrase change (LOCAL appliance) — verifies the current phrase server-side, sets the new one,
  // and rotates the box's session secret so every OTHER device's token is revoked.
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const changePass = async () => {
    if (!pwOld.trim() || pwNew.length < 6) { setPwMsg('Enter your current passphrase and a new one (6+ characters).'); return; }
    setPwMsg('Changing…');
    const r = await localChangePassphrase(pwOld, pwNew);
    setPwMsg(r.ok ? 'Passphrase changed — other devices must sign in again.' : (r.error || 'Could not change the passphrase.'));
    if (r.ok) { setPwOld(''); setPwNew(''); }
  };

  return (
    <div className="fixed inset-0 z-[150] overflow-y-auto" style={{ background: 'rgba(3,6,8,0.85)' }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Manage" className="mx-auto flex min-h-full max-w-[760px] flex-col gap-4 px-4 py-8 outline-none">

        <div className="flex items-center justify-between">
          <div className="text-2xl font-extrabold" style={{ color: C.primary }}>Manage</div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-[12px]" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.primary }}>
            <X size={18} />
          </button>
        </div>

        {/* Account */}
        <Section title="Account">
          <div className="mb-3 text-sm font-semibold" style={{ color: C.primary }}>
            {account.nickname || account.user?.email || 'Signed in'}
            {account.user?.email && account.nickname && <span style={{ color: C.muted }}> · {account.user.email}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {account.onLinkProfile && (
              <button type="button" onClick={account.onLinkProfile} className="rounded-[10px] px-3.5 py-2 text-sm font-bold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>
                Link / rename profile
              </button>
            )}
            <button type="button" onClick={account.onRefresh} disabled={account.isRefreshing} className="flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted, opacity: account.isRefreshing ? 0.6 : 1 }}>
              <RefreshCw size={15} /> {account.isRefreshing ? 'Refreshing…' : 'Refresh data'}
            </button>
            <button type="button" onClick={() => account.onSignOut()} className="flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.red }}>
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </Section>

        {/* Home location */}
        <Section title="Home location (weather + nearby suggestions)">
          {homeLabel && <div className="mb-2 text-sm font-semibold" style={{ color: C.primary }}>Current: {homeLabel}</div>}
          <div className="flex flex-wrap gap-2">
            <input value={homeInput} onChange={e => setHomeInput(e.target.value)} placeholder="City, ZIP, or address" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
            <button type="button" onClick={saveHome} className="rounded-[10px] px-4 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>Save</button>
          </div>
          {homeMsg && <div className="mt-2 text-xs font-semibold" style={{ color: C.muted }}>{homeMsg}</div>}
        </Section>

        {/* Display & reminders */}
        <Section title="Display & reminders">
          <div className="flex flex-col gap-3">
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Screensaver after</span>
              <Select value={account.idleTimeoutMs} onChange={account.onChangeIdleTimeout} options={IDLE_TIMEOUT_OPTIONS} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Auto sign-out</span>
              <Select value={account.signOutMs} onChange={account.onChangeSignOut} options={IDLE_SIGNOUT_OPTIONS} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Daily reminder</span>
              <button type="button" onClick={() => account.onToggleReminders(!account.remindersEnabled)} className="rounded-[10px] px-3 py-1.5 text-xs font-extrabold" style={{ border: `2px solid ${account.remindersEnabled ? C.emerald : C.elevated}`, color: account.remindersEnabled ? C.emerald : C.muted, background: account.remindersEnabled ? `${C.emerald}14` : 'transparent' }}>
                {account.remindersEnabled ? 'On' : 'Off'}
              </button>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Auto-scan email <span className="text-xs font-normal" style={{ color: C.muted }}>(every 30 min, needs Gmail)</span></span>
              <button type="button" onClick={() => account.onToggleAutoScan(!account.autoScanEnabled)} className="rounded-[10px] px-3 py-1.5 text-xs font-extrabold" style={{ border: `2px solid ${account.autoScanEnabled ? C.emerald : C.elevated}`, color: account.autoScanEnabled ? C.emerald : C.muted, background: account.autoScanEnabled ? `${C.emerald}14` : 'transparent' }}>
                {account.autoScanEnabled ? 'On' : 'Off'}
              </button>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Kid mode <span className="text-xs font-normal" style={{ color: C.muted }}>(locks this device to the kid-safe view; hold 🔒 3s to exit{hasStepUpPin ? ' + PIN' : ''})</span></span>
              {/* Turning it ON also closes Manage — the device drops straight into the locked kid surface. */}
              <button type="button" onClick={() => { const on = !kidMode; setKidMode(on); if (on) onClose(); }} className="rounded-[10px] px-3 py-1.5 text-xs font-extrabold" style={{ border: `2px solid ${kidMode ? C.emerald : C.elevated}`, color: kidMode ? C.emerald : C.muted, background: kidMode ? `${C.emerald}14` : 'transparent' }}>
                {kidMode ? 'On' : 'Off'}
              </button>
            </label>
            {account.remindersEnabled && (
              <>
                <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
                  <span>Reminder time</span>
                  <Select value={account.reminderTime} onChange={account.onChangeReminderTime} options={REMINDER_TIME_OPTIONS} />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
                  <span>Event lead time</span>
                  <Select value={account.reminderLead} onChange={account.onChangeReminderLead} options={REMINDER_LEAD_OPTIONS} />
                </label>
              </>
            )}
          </div>
        </Section>

        {/* Family members + dietary/interests */}
        <Section title="Family">
          <div className="flex flex-col gap-2.5">
            {familyMembers.map(m => {
              const accent = memberHex(m.color);
              return (
                <div key={m.name} className="rounded-[12px] p-3" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ background: accent }} />
                    {editingMember === m.name ? (
                      <form onSubmit={e => { e.preventDefault(); submitRename(m.name); }} className="flex items-center gap-1.5">
                        <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus aria-label={`Rename ${m.name}`} className="rounded-[7px] px-2 py-1 text-sm font-bold outline-none" style={field} />
                        <button type="submit" className="text-[11px] font-extrabold" style={{ color: C.indigo }}>Save</button>
                        <button type="button" onClick={() => setEditingMember(null)} className="text-[11px] font-bold" style={{ color: C.ink }}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <span className="text-sm font-bold" style={{ color: C.primary }}>{m.name}</span>
                        <span className="text-xs font-semibold" style={{ color: C.muted }}>· {m.role}</span>
                        <button type="button" onClick={() => { setEditingMember(m.name); setEditName(m.name); }} aria-label={`Rename ${m.name}`} className="ml-1" style={{ color: C.ink }}><Pencil size={13} /></button>
                      </>
                    )}
                    <button type="button" onClick={() => handleDeleteMember(m.name)} aria-label={`Remove ${m.name}`} className="ml-auto" style={{ color: C.ink }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {/* Color */}
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {MEMBER_COLORS_LIST.map(c => {
                      const hex = memberHex(c.id);
                      const sel = m.color === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => updateMember(m.name, { color: c.id })}
                          aria-label={`Set ${m.name} color ${c.name}`}
                          className="h-5 w-5 rounded-full"
                          style={{ background: hex, border: sel ? `2px solid ${C.primary}` : '2px solid transparent' }}
                        />
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input defaultValue={m.age ?? ''} onBlur={e => updateMember(m.name, { age: parseAge(e.target.value) })} inputMode="numeric" placeholder="Age" aria-label={`${m.name} age`} className="rounded-[8px] px-2.5 py-1.5 text-[13px] outline-none" style={field} />
                    <input defaultValue={m.dietary || ''} onBlur={e => updateMember(m.name, { dietary: e.target.value })} placeholder="Dietary (e.g. vegetarian, nut allergy)" className="rounded-[8px] px-2.5 py-1.5 text-[13px] outline-none" style={field} />
                    <input defaultValue={m.interests || ''} onBlur={e => updateMember(m.name, { interests: e.target.value })} placeholder="Interests (e.g. soccer, painting)" className="rounded-[8px] px-2.5 py-1.5 text-[13px] outline-none" style={field} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add member — captures optional dietary/interests at creation so suggestions are tailored from the start */}
          <form onSubmit={handleAddMember} className="mt-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input value={newMemberName} onChange={e => setNewMemberName(e.target.value)} placeholder="Add member name" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
              <select value={newMemberRole} onChange={e => setNewMemberRole(e.target.value as 'Parent' | 'Kid')} className="rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field}>
                <option value="Parent" style={{ background: C.card }}>Parent</option>
                <option value="Kid" style={{ background: C.card }}>Kid</option>
              </select>
              <select value={newMemberColor} onChange={e => setNewMemberColor(e.target.value)} className="rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field}>
                {MEMBER_COLORS_LIST.map(c => <option key={c.id} value={c.id} style={{ background: C.card }}>{c.name}</option>)}
              </select>
              <button type="submit" className="flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>
                <UserPlus size={15} /> Add
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input value={newMemberAge} onChange={e => setNewMemberAge(e.target.value)} inputMode="numeric" placeholder="Age (optional)" aria-label="Age" className="rounded-[10px] px-3 py-2 text-[13px] outline-none" style={field} />
              <input value={newMemberDietary} onChange={e => setNewMemberDietary(e.target.value)} placeholder="Dietary (optional, e.g. vegetarian)" className="rounded-[10px] px-3 py-2 text-[13px] outline-none" style={field} />
              <input value={newMemberInterests} onChange={e => setNewMemberInterests(e.target.value)} placeholder="Interests (optional, e.g. soccer, painting)" className="rounded-[10px] px-3 py-2 text-[13px] outline-none" style={field} />
            </div>
          </form>

          {/* Your household invite code — share so another parent can join */}
          {cloudInviteCode && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] p-2.5" style={{ border: `2px solid ${C.elevated}` }}>
              <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>Your invite code</span>
              <span className="rounded-[8px] px-2.5 py-1 text-sm font-extrabold tracking-widest" style={{ background: C.app, color: C.indigo }}>{cloudInviteCode}</span>
              <button type="button" onClick={() => copyInvite(cloudInviteCode)} className="text-[11px] font-bold" style={{ color: copied ? C.emerald : C.indigo }}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
          )}

          {/* Invite / join */}
          <form onSubmit={handleJoinHousehold} className="mt-2 flex flex-wrap items-center gap-2">
            <input value={inviteCodeInput} onChange={e => setInviteCodeInput(e.target.value)} placeholder="Join a household by invite code" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
            <button type="submit" disabled={isJoiningHousehold} className="rounded-[10px] px-3.5 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}>
              {isJoiningHousehold ? 'Joining…' : 'Join'}
            </button>
          </form>
        </Section>

        {/* Step-up PIN */}
        <Section title="Security PIN (gates high-risk actions)">
          <div className="mb-2 text-sm font-semibold" style={{ color: C.primary }}>{hasStepUpPin ? 'A PIN is set.' : 'No PIN set.'}</div>
          {/* Changing an existing PIN requires the current one first. */}
          {hasStepUpPin && (
            <input value={currentPinInput} onChange={e => setCurrentPinInput(e.target.value)} inputMode="numeric" placeholder="Current PIN" aria-label="Current PIN" className="mb-2 w-full rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={{ ...field, textTransform: 'uppercase' }} />
          )}
          <div className="flex flex-wrap gap-2">
            <input value={pinInput} onChange={e => setPinInput(e.target.value)} inputMode="numeric" placeholder={hasStepUpPin ? 'New 4–8 digit PIN' : '4–8 digit PIN'} aria-label={hasStepUpPin ? 'New PIN' : 'PIN'} className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={{ ...field, textTransform: 'uppercase' }} />
            <button type="button" onClick={savePin} className="rounded-[10px] px-4 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>{hasStepUpPin ? 'Change PIN' : 'Set PIN'}</button>
          </div>
          {pinMsg && <div className="mt-2 text-xs font-semibold" style={{ color: C.muted }}>{pinMsg}</div>}
        </Section>

        {/* Household passphrase — LOCAL appliance only (cloud uses Supabase auth). Changing it rotates the box's
            session secret, so every OTHER signed-in device is logged out (the revocation path). */}
        {getBackendMode() === 'sqlite' && (
          <Section title="Household passphrase">
            <div className="mb-2 text-xs font-semibold" style={{ color: C.muted }}>Changing it signs out every other device.</div>
            <div className="flex flex-col gap-2">
              <input type="password" value={pwOld} onChange={e => setPwOld(e.target.value)} placeholder="Current passphrase" aria-label="Current passphrase" className="w-full rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
              <div className="flex flex-wrap gap-2">
                <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} placeholder="New passphrase (6+ chars)" aria-label="New passphrase" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
                <button type="button" onClick={changePass} className="rounded-[10px] px-4 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>Change</button>
              </div>
            </div>
            {pwMsg && <div className="mt-2 text-xs font-semibold" style={{ color: C.muted }}>{pwMsg}</div>}
          </Section>
        )}

        {/* Daily briefing email (W5) — opt-in; the server scheduler emails the morning briefing at the chosen
            hour (needs the owner's Resend + service-role keys to actually send). */}
        <Section title="Daily briefing email">
          <label className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
            <span>Email me a morning briefing</span>
            <button type="button" onClick={() => setDigest({ enabled: !digest.enabled })} className="rounded-[10px] px-3 py-1.5 text-xs font-extrabold" style={{ border: `2px solid ${digest.enabled ? C.emerald : C.elevated}`, color: digest.enabled ? C.emerald : C.muted, background: digest.enabled ? `${C.emerald}14` : 'transparent' }}>
              {digest.enabled ? 'On' : 'Off'}
            </button>
          </label>
          {digest.enabled && (
            <>
              {/* Recipient list — each parent can add their own email so the whole household gets the briefing. */}
              {recipients.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {recipients.map(r => (
                    <span key={r} className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold" style={{ border: `2px solid ${C.elevated}`, color: C.primary }}>
                      {r}
                      <button type="button" onClick={() => setRecipients(recipients.filter(x => x !== r))} aria-label={`Remove ${r}`} className="cursor-pointer" style={{ color: C.ink }}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input value={newRecipient} onChange={e => setNewRecipient(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }} type="email" inputMode="email" autoComplete="email" placeholder="add a parent's email…" aria-label="Add briefing recipient" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field} />
                <button type="button" onClick={addRecipient} disabled={!canAddRecipient} className="rounded-[10px] px-3 py-2 text-sm font-extrabold cursor-pointer" style={{ border: `2px solid ${C.indigo}`, color: C.indigo, background: `${C.indigo}14`, opacity: canAddRecipient ? 1 : 0.5 }}>Add</button>
                <select value={digest.sendHour} onChange={e => setDigest({ sendHour: Number(e.target.value) })} aria-label="Send hour" className="rounded-[10px] px-3 py-2 text-sm font-semibold outline-none" style={field}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h} style={{ background: C.card }}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </div>
              {/* Honest note: sending depends on the household owner enabling server-side email delivery, so a
                  normal user isn't left wondering why no email arrives. */}
              <div className="mt-2 text-xs font-semibold" style={{ color: C.muted }}>
                {recipients.length
                  ? `Saved — a briefing goes to ${recipients.length === 1 ? recipients[0] : `${recipients.length} recipients`} around ${String(digest.sendHour).padStart(2, '0')}:00, once your household owner has enabled email delivery on the server.`
                  : 'Add the email address(es) to send your daily briefing to — each parent can add their own.'}
              </div>
            </>
          )}
        </Section>

        {/* Google Calendar sync — cloud (Supabase) mode only. On the local SQLite appliance there is no Google
            account, so the panel's handlers are inert; hide it rather than render dead UI. */}
        {getBackendMode() === 'supabase' && (
          <Section title="Google Calendar sync">
            <div className="rounded-[12px] p-3" style={{ background: C.app }}>
              <GoogleSyncPanel />
            </div>
          </Section>
        )}

        {/* AGPL §13: a network service must let its users reach the Corresponding Source. Persistent, both modes. */}
        <div className="mt-4 pt-3 text-center text-[10px]" style={{ color: C.muted, borderTop: `1px solid ${C.elevated}` }}>
          fam-hub · <a href="https://github.com/msampath/fam-hub" target="_blank" rel="noreferrer" style={{ color: C.muted, textDecoration: 'underline' }}>Source code (AGPL-3.0)</a>
        </div>
      </div>
    </div>
  );
}
