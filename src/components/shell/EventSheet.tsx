import { X, Trash2, MapPin, Check, CalendarPlus } from 'lucide-react';
import { useApp } from '../../AppContext';
import { useCalendar } from '../../CalendarContext';
import { useModalA11y } from '../../hooks/useModalA11y';
import { formatTime, toLocalDateStr } from '../../utils/dates';
import { C, CATEGORY_EMOJI, memberHex } from './theme';

// Dark event detail sheet (ported from the light EventDetailPanel). Opens when an event is tapped
// (selectedEventDetail set). Field edits go through the copilot (update_event); this sheet handles
// the direct actions: delete, free/busy override, "we went" (HISTORY FACTS), push-to-Google.
export default function EventSheet() {
  const {
    selectedEventDetail, setSelectedEventDetail,
    familyMembers, handleDeleteEvent, conflicts, visitLog, handleMarkVisited,
    handleSetEventFreeBusy, googleUser, googleCalendarsList, openGooglePush,
  } = useCalendar();
  const { kidMode } = useApp();

  const close = () => setSelectedEventDetail(null);
  // active = sheet open (this component is always mounted + returns null when closed → focus must move on OPEN).
  const dialogRef = useModalA11y<HTMLDivElement>(close, !!selectedEventDetail);
  if (!selectedEventDetail) return null;
  const ev = selectedEventDetail;

  const accent = (() => {
    const m = ev.members || [];
    if (m.length === 1) {
      const fm = familyMembers.find(x => x.name.toLowerCase() === m[0].toLowerCase());
      if (fm) return memberHex(fm.color);
    }
    return C.emerald;
  })();

  const todayStr = toLocalDateStr(new Date());
  const isPastOrToday = String(ev.start).slice(0, 10) <= todayStr;
  const visitLabel = (ev.location || ev.title || '').trim().toLowerCase();
  const alreadyLogged = visitLog.some(
    v => v.label.trim().toLowerCase() === visitLabel && v.lastVisited >= String(ev.start).slice(0, 10),
  );

  const isPulledFromGoogle = ev.id.startsWith('gcal-');
  const canPushToGoogle = !!googleUser && googleCalendarsList.length > 0 && !isPulledFromGoogle;

  const myConflicts = conflicts
    .filter(cf => cf.overlappingEvents.some(e => e.id === ev.id))
    .sort((a, b) => a.date.localeCompare(b.date));
  const conflict = myConflicts[0] || null;
  const extraDays = myConflicts.length - 1;
  const others = conflict ? conflict.overlappingEvents.filter(e => e.id !== ev.id).map(e => e.title).join(', ') : '';

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center p-4" style={{ background: 'rgba(3,6,8,0.85)' }} onClick={close}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Event details" className="w-full max-w-md rounded-[22px] p-6 outline-none" style={{ border: `2px solid ${accent}`, boxShadow: `6px 6px 0 0 ${accent}`, background: C.card }} onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-[14px] text-2xl" style={{ background: `${accent}24` }}>{CATEGORY_EMOJI[ev.category] || '📌'}</div>
            <div>
              <div className="text-lg font-extrabold leading-tight" style={{ color: C.primary }}>{ev.title}</div>
              <div className="text-xs font-bold uppercase tracking-wide" style={{ color: accent }}>{ev.category}</div>
            </div>
          </div>
          <button type="button" onClick={close} aria-label="Close" style={{ color: C.muted }}><X size={18} /></button>
        </div>

        <div className="flex flex-col gap-2 text-[13px] font-semibold" style={{ color: C.muted }}>
          {ev.location && <div>📍 {ev.location}</div>}
          <div>📅 {ev.start}{ev.end ? ` → ${ev.end}` : ''}</div>
          {ev.startTime && <div>🕒 {formatTime(ev.startTime)}{ev.endTime ? ` – ${formatTime(ev.endTime)}` : ''}</div>}
          {ev.members && ev.members.length > 0 && <div>👤 {ev.members.join(', ')}</div>}
          {ev.description && <div className="rounded-[12px] p-3 text-[13px] font-medium" style={{ background: C.app, color: C.soft }}>{ev.description}</div>}
        </div>

        {conflict && (
          <div className="mt-3 rounded-[12px] p-3" style={{ background: `${C.orange}1f`, border: `2px solid ${C.orange}4d` }}>
            <div className="text-[11px] font-extrabold uppercase tracking-wide" style={{ color: C.orange }}>⚠️ Double-booked</div>
            <div className="mt-1 text-[12px] font-bold" style={{ color: C.primary }}>Overlaps on {conflict.date}{extraDays > 0 ? ` (+${extraDays} more)` : ''}</div>
            <div className="text-[11px] font-semibold" style={{ color: C.muted }}>{conflict.member} also has: {others || '—'}</div>
          </div>
        )}

        {/* Availability override — feeds the copilot's AVAILABILITY grounding. */}
        <div className="mt-4">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>Counts as — tells the copilot when you're free</div>
          <div className="flex gap-1.5">
            {([{ val: '', label: 'Auto' }, { val: 'busy', label: 'Busy' }, { val: 'free', label: 'Free' }] as const).map(opt => {
              const on = (ev.freeBusy || '') === opt.val;
              return (
                <button key={opt.val || 'auto'} type="button" onClick={() => handleSetEventFreeBusy(ev.id, opt.val)} className="rounded-[9px] px-3 py-1.5 text-[11px] font-bold" style={on ? { background: C.indigo, color: '#fff', border: `2px solid ${C.indigo}` } : { background: 'transparent', color: C.muted, border: `2px solid ${C.elevated}` }}>{opt.label}</button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {isPastOrToday && (
            <button type="button" onClick={() => handleMarkVisited(ev)} disabled={alreadyLogged} className="flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={{ background: `${C.emerald}18`, color: C.emerald, border: `2px solid ${C.emerald}33`, opacity: alreadyLogged ? 0.6 : 1 }}>
              {alreadyLogged ? <Check size={13} /> : <MapPin size={13} />}{alreadyLogged ? 'Logged' : 'We went'}
            </button>
          )}
          {canPushToGoogle && (
            <button type="button" onClick={() => openGooglePush(ev)} className="flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={{ background: `${C.indigo}18`, color: C.indigo, border: `2px solid ${C.indigo}33` }}>
              <CalendarPlus size={13} /> Push to Google
            </button>
          )}
          {/* Kid mode: viewing an event is fine; deleting one isn't. */}
          {!kidMode && <button type="button" onClick={() => { handleDeleteEvent(ev.id); close(); }} className="ml-auto flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12px] font-extrabold" style={{ background: `${C.red}18`, color: C.red, border: `2px solid ${C.red}33` }}>
            <Trash2 size={13} /> Delete
          </button>}
        </div>

        <div className="mt-3 text-[11px] font-semibold" style={{ color: C.ink }}>To change the time or title, ask the copilot (e.g. “move {ev.title} to 3pm”).</div>
      </div>
    </div>
  );
}
