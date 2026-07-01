import { useState } from 'react';
import { CalendarPlus, X, Check, Loader2 } from 'lucide-react';
import { useCalendar } from '../../CalendarContext';

// Manual "Push to Google" picker — opened from EventDetailPanel. Lets the owner choose which of
// their WRITABLE Google calendars one event is pushed to (owner's decision: push is manual, not
// auto). Re-pushing updates the same Google event via the shared FamilyHub-id marker. Rendered at
// the calendar subtree root; renders null until an event is selected for push.
export default function GooglePushPicker() {
  const { googlePushEvent, closeGooglePush, googleCalendarsList, pushEventToGoogleCalendars, isPushingEvent } = useCalendar();

  // Only owner/writer calendars can receive an inserted event — readers/freeBusy can't be written.
  const writable = googleCalendarsList.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
  const primaryId = (writable.find(c => c.primary) || writable[0])?.id;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  // Reset per-event selection/result when a different event is opened (derived-state-from-props):
  // default to the primary calendar pre-checked so the common case is one tap.
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const evId = googlePushEvent?.id ?? null;
  if (evId !== trackedId) {
    setTrackedId(evId);
    setSelected(new Set(evId && primaryId ? [primaryId] : []));
    setResult(null);
  }

  if (!googlePushEvent) return null;
  const ev = googlePushEvent;

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const doPush = async () => {
    setResult(null);
    const msg = await pushEventToGoogleCalendars(ev, [...selected]);
    setResult(msg);
  };

  return (
    <div
      className="fixed inset-0 bg-indigo-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-[60] animate-fade-in"
      id="google-push-modal"
      onClick={closeGooglePush}
    >
      <div className="bg-white rounded-3xl max-w-md w-full p-6 border border-slate-100 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button
          id="close-google-push-btn"
          onClick={closeGooglePush}
          disabled={isPushingEvent}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 disabled:opacity-40"
        >
          <X size={18} />
        </button>

        <h2 className="text-xs uppercase tracking-widest font-extrabold text-slate-400 mb-1 flex items-center gap-1.5">
          <CalendarPlus size={14} className="text-indigo-600" /> Push to Google Calendar
        </h2>
        <p className="text-sm font-bold text-indigo-950 mb-4 leading-tight truncate" title={ev.title}>{ev.title}</p>

        {writable.length === 0 ? (
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-2xl p-4">
            No writable Google calendars found. Connect one under <span className="font-bold">Sync Sources → Google Calendar</span>, then try again.
          </p>
        ) : (
          <>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">Choose calendars</p>
            <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1" id="google-push-calendar-list">
              {writable.map((c: any) => {
                const checked = selected.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border cursor-pointer transition-all ${
                      checked ? 'bg-indigo-50 border-indigo-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-indigo-600"
                      checked={checked}
                      disabled={isPushingEvent}
                      onChange={() => toggle(c.id)}
                    />
                    <span className="text-xs font-semibold text-slate-700 flex-grow truncate" title={c.summary}>{c.summary || c.id}</span>
                    {c.primary && <span className="text-[9px] font-bold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded">PRIMARY</span>}
                  </label>
                );
              })}
            </div>

            {result && (
              <p className="mt-3 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2" id="google-push-result">
                {result}
              </p>
            )}

            <div className="mt-5 flex items-center gap-2">
              <button
                id="confirm-google-push-btn"
                onClick={doPush}
                disabled={isPushingEvent || selected.size === 0}
                className="flex-grow py-2.5 flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-bold text-xs transition-colors cursor-pointer"
              >
                {isPushingEvent ? <><Loader2 size={14} className="animate-spin" /> Pushing…</> : <><Check size={14} /> Push to {selected.size || 'no'} calendar{selected.size === 1 ? '' : 's'}</>}
              </button>
              <button
                onClick={closeGooglePush}
                disabled={isPushingEvent}
                className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-600 rounded-xl font-bold text-xs transition-colors cursor-pointer"
              >
                {result ? 'Done' : 'Cancel'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
