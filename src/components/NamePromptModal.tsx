import { useState } from 'react';
import { X } from 'lucide-react';
import { useApp } from '../AppContext';
import { APP_NAME } from '../constants';
import { C } from './shell/theme';

// Shared dark-input style (the app is a single dark theme). focus:ring layers on top of the inline border.
const inputStyle = { background: C.app, border: `2px solid ${C.elevated}`, color: C.primary } as const;
const cardStyle = { background: C.card, border: `2px solid ${C.elevated}`, boxShadow: '0 10px 40px rgba(0,0,0,0.55)' } as const;

// `dismissable` + `onDismiss` are set ONLY when the prompt is opened on-demand (e.g. from the
// account menu's "link my profile" action) — never for the first-run gate, which must be resolved.
export default function NamePromptModal({ dismissable, onDismiss }: { dismissable?: boolean; onDismiss?: () => void } = {}) {
  const {
    handleSubmitName, handleReclaimProfile, familyMembers,
    inviteCodeInput, setInviteCodeInput, isJoiningHousehold, handleJoinHousehold,
    onboardingName, handleSaveOnboardingPrefs, dismissOnboarding,
  } = useApp();
  const [nameInput, setNameInput] = useState('');
  const [dietary, setDietary] = useState('');
  const [interests, setInterests] = useState('');

  // Step 2 (optional, skippable): after a brand-new profile is created, capture dietary/interests so
  // the copilot can personalize food + activity suggestions from the first session.
  if (onboardingName) {
    return (
      <div className="fixed inset-0 bg-indigo-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="onboarding-prefs-modal">
        <div className="rounded-3xl max-w-sm w-full p-6" style={cardStyle}>
          <span className="text-[10px] font-extrabold uppercase tracking-widest block mb-1" style={{ color: C.indigo }}>Welcome, {onboardingName}</span>
          <h3 className="text-base font-black mb-1" style={{ color: C.primary }}>A few preferences (optional)</h3>
          <p className="text-xs mb-4" style={{ color: C.muted }}>These help the copilot tailor food and activity suggestions to your household. You can skip and add them later in Manage.</p>
          <form
            onSubmit={e => { e.preventDefault(); handleSaveOnboardingPrefs({ dietary, interests }); }}
            className="space-y-3"
          >
            <input
              id="onboarding-dietary-input"
              type="text"
              autoFocus
              placeholder="Dietary (e.g. vegetarian, nut allergy)"
              value={dietary}
              onChange={e => setDietary(e.target.value)}
              className="w-full px-3 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-500"
              style={inputStyle}
            />
            <input
              id="onboarding-interests-input"
              type="text"
              placeholder="Interests (e.g. hiking, board games)"
              value={interests}
              onChange={e => setInterests(e.target.value)}
              className="w-full px-3 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-500"
              style={inputStyle}
            />
            <div className="flex gap-2">
              <button
                type="button"
                id="onboarding-skip-btn"
                onClick={dismissOnboarding}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all hover:brightness-110 cursor-pointer"
                style={{ background: C.elevated, color: C.muted }}
              >
                Skip
              </button>
              <button
                type="submit"
                id="onboarding-save-btn"
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-bold transition-all cursor-pointer"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
  // If the household already has profiles, this is almost certainly an EXISTING user whose account
  // link drifted — let them reconnect to their profile in one tap instead of being forced to create
  // a duplicate (🐞 #6). New households (no members) just see the name input.
  const existingProfiles = familyMembers.filter(m => m.name?.trim());
  // An EMPTY household on first sign-in is the classic "2nd family member landed in their own silo"
  // case (they need to JOIN via invite code, not create a new household). Lead with Join then.
  const emptyHousehold = existingProfiles.length === 0;

  return (
    <div className="fixed inset-0 bg-indigo-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="name-prompt-modal">
      <div className="rounded-3xl max-w-sm w-full p-6 relative" style={cardStyle}>
        {dismissable && onDismiss && (
          <button
            type="button"
            id="name-prompt-close"
            onClick={onDismiss}
            className="absolute top-4 right-4 hover:brightness-125"
            style={{ color: C.muted }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        )}
        <span className="text-[10px] font-extrabold uppercase tracking-widest block mb-1" style={{ color: C.indigo }}>Welcome to {APP_NAME}</span>
        <h3 className="text-base font-black mb-1" style={{ color: C.primary }}>{emptyHousehold ? 'Joining your family, or starting fresh?' : 'What should we call you?'}</h3>
        <p className="text-xs mb-4" style={{ color: C.muted }}>
          {emptyHousehold
            ? 'If your family already uses Family-Hub, enter their invite code to join and see your shared calendar. Otherwise, pick a name to start a new household.'
            : "This name appears on your calendar events and chores. You'll be added as a Parent."}
        </p>

        {existingProfiles.length > 0 && (
          <div className="mb-4 p-3 rounded-2xl" style={{ background: `${C.indigo}14`, border: `1px solid ${C.indigo}38` }}>
            <p className="text-[11px] font-bold mb-2" style={{ color: C.indigo }}>Already set up? Tap your profile to reconnect:</p>
            <div className="flex flex-wrap gap-1.5">
              {existingProfiles.map(m => (
                <button
                  key={m.name}
                  type="button"
                  id={`reclaim-profile-${m.name}`}
                  onClick={() => handleReclaimProfile(m.name)}
                  className="px-2.5 py-1 text-xs font-bold rounded-lg transition-colors hover:brightness-110 cursor-pointer"
                  style={{ background: C.card, border: `1px solid ${C.indigo}55`, color: C.indigo }}
                >
                  I'm {m.name}
                </button>
              ))}
            </div>
            <p className="text-[10px] mt-2" style={{ color: C.ink }}>…or enter a new name below to add a new profile.</p>
          </div>
        )}

        {/* Join an existing household by invite code — the path a 2nd family member needs so they
            don't silently create their own empty household (they'd then see none of the shared data). */}
        <form onSubmit={handleJoinHousehold} className="p-3 rounded-2xl mb-3" style={emptyHousehold ? { background: `${C.emerald}14`, border: `1px solid ${C.emerald}38` } : { background: C.app, border: `1px solid ${C.elevated}` }}>
          <label className="block text-[11px] font-bold mb-1" style={{ color: C.emerald }}>Have a family invite code?</label>
          <div className="flex gap-2">
            <input
              id="name-prompt-invite-input"
              type="text"
              value={inviteCodeInput}
              onChange={e => setInviteCodeInput(e.target.value.toUpperCase())}
              placeholder="6-char code"
              maxLength={6}
              className="flex-1 px-3 py-2 text-sm font-mono tracking-widest rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-500"
              style={{ background: C.app, border: `1px solid ${C.emerald}55`, color: C.primary }}
            />
            <button
              type="submit"
              id="name-prompt-join-btn"
              disabled={isJoiningHousehold || inviteCodeInput.trim().length < 6}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              {isJoiningHousehold ? 'Joining…' : 'Join'}
            </button>
          </div>
          <p className="text-[10px] mt-1.5" style={{ color: C.ink }}>The code is shown in your family member's Calendar → Sync Sources → Google Calendar panel.</p>
        </form>

        <div className="flex items-center gap-2 my-3">
          <span className="h-px flex-1" style={{ background: C.elevated }} />
          <span className="text-[10px] font-bold uppercase" style={{ color: C.ink }}>or {emptyHousehold ? 'start a new household' : 'new profile'}</span>
          <span className="h-px flex-1" style={{ background: C.elevated }} />
        </div>

        <form onSubmit={e => { e.preventDefault(); handleSubmitName(nameInput); }} className="space-y-3">
          <input
            id="name-prompt-input"
            type="text"
            autoFocus
            placeholder="e.g. Dad, Mom, or your first name"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            className="w-full px-3 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-500"
            style={inputStyle}
            required
          />
          <button
            type="submit"
            disabled={!nameInput.trim()}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition-all cursor-pointer"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
