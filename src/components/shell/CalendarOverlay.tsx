import { useState } from 'react';
import { X, ChevronLeft, ChevronRight, Search, Plus, Trash2, RefreshCw, CalendarPlus } from 'lucide-react';
import { useCalendar } from '../../CalendarContext';
import { useModalA11y } from '../../hooks/useModalA11y';
import { toLocalDateStr, formatTime } from '../../utils/dates';
import { CATEGORIES } from '../../constants';
import { C, memberHex, CATEGORY_EMOJI } from './theme';

interface CalendarOverlayProps {
  onClose: () => void;
}

// Full month-grid overlay opened from the Today date header (spec §4). Browse + filter/search events,
// tap a day to see its events (→ EventSheet) or add one, and bulk-delete a recurring series.
export default function CalendarOverlay({ onClose }: CalendarOverlayProps) {
  const {
    currentMonthInfo, calendarCells, DAYS_OF_WEEK, monthsData, currentMonthStep, setCurrentMonthStep,
    getEventsForDate, filterEvent, setSelectedDayToAdd, setIsAddingEvent, setSelectedEventDetail,
    searchQuery, setSearchQuery, activeCategoryFilter, setActiveCategoryFilter,
    activeMemberFilter, setActiveMemberFilter, familyMembers,
    recurringGroups, handleDeleteRecurringGroup,
    googleUser, syncGoogleCalendars, isFetchingCalendars,
    connectedCalendars, hasOwnCalendarConnection, connectOwnCalendar,
  } = useCalendar();

  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const today = toLocalDateStr(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const dayEvents = (dateStr: string) => getEventsForDate(dateStr).filter(filterEvent);
  const addOnDay = (dateStr: string) => { setSelectedDayToAdd(dateStr); setIsAddingEvent(true); onClose(); };

  const CATS = ['All', ...Object.keys(CATEGORIES)];

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center overflow-y-auto p-4" style={{ background: 'rgba(3,6,8,0.85)' }} onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Calendar" onClick={e => e.stopPropagation()} className="mt-6 w-full max-w-[860px] rounded-[22px] p-5 md:p-6 outline-none" style={{ border: `2px solid ${C.brut}`, boxShadow: `6px 6px 0 0 ${C.brut}`, background: C.card }}>

        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setCurrentMonthStep(s => Math.max(0, s - 1))} disabled={currentMonthStep <= 0} aria-label="Previous month" className="flex h-9 w-9 items-center justify-center rounded-[10px]" style={{ border: `2px solid ${C.elevated}`, color: C.muted, opacity: currentMonthStep <= 0 ? 0.4 : 1 }}>
              <ChevronLeft size={18} />
            </button>
            <div className="min-w-[160px] text-center text-lg font-extrabold" style={{ color: C.primary }}>{currentMonthInfo.name}</div>
            <button type="button" onClick={() => setCurrentMonthStep(s => Math.min(monthsData.length - 1, s + 1))} disabled={currentMonthStep >= monthsData.length - 1} aria-label="Next month" className="flex h-9 w-9 items-center justify-center rounded-[10px]" style={{ border: `2px solid ${C.elevated}`, color: C.muted, opacity: currentMonthStep >= monthsData.length - 1 ? 0.4 : 1 }}>
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync right here so a parent never has to hunt inside Manage → Google sync. A parent who
                joined an existing household and hasn't connected their own calendar yet gets the
                "Connect my calendar" auto-offer instead (so the family can see their events). */}
            {googleUser?.email && (
              hasOwnCalendarConnection ? (
                <button
                  type="button"
                  onClick={() => syncGoogleCalendars()}
                  disabled={isFetchingCalendars || connectedCalendars.length === 0}
                  aria-label="Sync Google calendars"
                  className="flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12px] font-extrabold disabled:opacity-50"
                  style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}
                >
                  <RefreshCw size={14} className={isFetchingCalendars ? 'animate-spin' : ''} />
                  {isFetchingCalendars ? 'Syncing…' : 'Sync'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={connectOwnCalendar}
                  disabled={isFetchingCalendars}
                  aria-label="Connect my Google calendar"
                  className="flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12px] font-extrabold disabled:opacity-50"
                  style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald }}
                >
                  <CalendarPlus size={14} />
                  {isFetchingCalendars ? 'Connecting…' : 'Connect my calendar'}
                </button>
              )
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[10px]" style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.primary }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Filters: search + category + member */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search events…" aria-label="Search events" className="w-full rounded-[10px] py-2 pl-8 pr-3 text-sm outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }} />
          </div>
          <select value={activeMemberFilter} onChange={e => setActiveMemberFilter(e.target.value)} aria-label="Filter by member" className="rounded-[10px] px-2.5 py-2 text-sm font-semibold outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }}>
            <option value="All" style={{ background: C.card }}>All members</option>
            {familyMembers.map(m => <option key={m.name} value={m.name} style={{ background: C.card }}>{m.name}</option>)}
          </select>
        </div>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {CATS.map(cat => {
            const on = activeCategoryFilter === cat;
            return (
              <button key={cat} type="button" onClick={() => setActiveCategoryFilter(cat)} className="rounded-full px-3 py-1 text-[11px] font-bold" style={on ? { border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo } : { border: `2px solid ${C.elevated}`, color: C.muted }}>{cat}</button>
            );
          })}
        </div>

        <div className="mb-1.5 grid grid-cols-7 gap-1.5">
          {DAYS_OF_WEEK.map(d => (
            <div key={d} className="text-center text-[10px] font-extrabold uppercase tracking-wider" style={{ color: C.muted }}>{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {calendarCells.map(cell => {
            const evts = dayEvents(cell.dateStr);
            const isToday = cell.dateStr === today;
            const isSel = cell.dateStr === selectedDay;
            return (
              <button
                key={cell.dateStr}
                type="button"
                onClick={() => setSelectedDay(cell.dateStr)}
                className="flex min-h-[58px] flex-col items-start rounded-[10px] p-1.5 text-left transition-colors"
                style={{
                  border: `2px solid ${isSel ? C.brut : isToday ? C.indigo : C.elevated}`,
                  background: isToday ? `${C.indigo}14` : cell.isCurrentMonth ? C.app : 'transparent',
                  opacity: cell.isCurrentMonth ? 1 : 0.4,
                }}
              >
                <span className="text-[13px] font-bold" style={{ color: isToday ? C.indigo : C.primary }}>{cell.dayNum}</span>
                <div className="mt-auto flex w-full flex-wrap gap-0.5">
                  {evts.slice(0, 3).map(e => <span key={e.id} className="h-1.5 w-1.5 rounded-full" style={{ background: C.sky }} />)}
                  {evts.length > 3 && <span className="text-[9px] font-bold" style={{ color: C.muted }}>+{evts.length - 3}</span>}
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected-day events → tap to open the EventSheet, or add one */}
        {selectedDay && (
          <div className="mt-4 rounded-[14px] p-3" style={{ border: `2px solid ${C.elevated}`, background: C.app }}>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-extrabold" style={{ color: C.primary }}>{new Date(selectedDay + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
              <button type="button" onClick={() => addOnDay(selectedDay)} className="flex items-center gap-1 rounded-[9px] px-3 py-1.5 text-[12px] font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>
                <Plus size={13} /> Add event
              </button>
            </div>
            {dayEvents(selectedDay).length === 0 ? (
              <div className="text-[12px] font-semibold" style={{ color: C.ink }}>Nothing scheduled. Tap “Add event”.</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {dayEvents(selectedDay).map(e => {
                  const accent = e.members?.length === 1 ? memberHex(familyMembers.find(m => m.name === e.members![0])?.color) : C.emerald;
                  return (
                    <button key={e.id} type="button" onClick={() => setSelectedEventDetail(e)} className="flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left" style={{ background: C.card, border: `2px solid ${C.elevated}` }}>
                      <span className="text-base">{CATEGORY_EMOJI[e.category] || '📌'}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-bold" style={{ color: C.primary }}>{e.title}</span>
                      <span className="text-[11px] font-semibold" style={{ color: accent }}>{e.startTime ? formatTime(e.startTime) : 'All day'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Recurring series — bulk delete (e.g. a daily import that cluttered the calendar) */}
        {recurringGroups.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.muted }}>Recurring series</div>
            <div className="flex flex-col gap-1.5">
              {recurringGroups.map(g => (
                <div key={g.groupId} className="flex items-center justify-between gap-2 rounded-[10px] px-3 py-2" style={{ border: `2px solid ${C.elevated}`, background: C.app }}>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold" style={{ color: C.primary }}>{g.title}</div>
                    <div className="text-[11px] font-semibold" style={{ color: C.muted }}>{g.member} · {g.dayCount} days · {g.instanceCount} events</div>
                  </div>
                  <button type="button" onClick={() => handleDeleteRecurringGroup(g)} className="flex flex-shrink-0 items-center gap-1 rounded-[9px] px-3 py-1.5 text-[11px] font-bold" style={{ background: `${C.red}18`, color: C.red, border: `2px solid ${C.red}33` }}>
                    <Trash2 size={13} /> Delete all
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 text-center text-[11px] font-semibold" style={{ color: C.ink }}>Tap a day to see or add events</div>
      </div>
    </div>
  );
}
