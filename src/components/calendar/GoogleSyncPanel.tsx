import { useState } from 'react';
import { RefreshCw, Trash2, Plus, EyeOff, RotateCcw, ChevronRight, ChevronDown } from 'lucide-react';
import type { FamilyMember } from '../../types';
import { useCalendar } from '../../CalendarContext';

interface SelectorRowProps {
  key?: any; // required: this project's TS setup type-checks `key` as a prop on the call site
  cal: any;
  familyMembers: FamilyMember[];
  onAddConnection: (cal: any, direction: 'pull' | 'push', assignedTo: string) => void;
}

function GoogleCalendarSelectorRow({ cal, familyMembers, onAddConnection }: SelectorRowProps) {
  const [direction, setDirection] = useState<'pull' | 'push'>('pull');
  const [assignedTo, setAssignedTo] = useState<string>('Family');

  return (
    <div className="border border-slate-700 rounded-2xl p-3 bg-[#131827] hover:border-slate-600 transition-all shadow-sm space-y-2.5">
      <div className="flex items-start justify-between gap-1 overflow-hidden">
        <div className="overflow-hidden">
          <span className="block text-xs font-bold text-slate-100 truncate" title={cal.summary}>{cal.summary}</span>
          {cal.primary && (
            <span className="text-[10px] bg-red-500/20 text-red-300 font-extrabold px-1 rounded uppercase tracking-wider">Primary Account</span>
          )}
        </div>
        <div className="flex-shrink-0 text-right">
          <span className="block text-[10px] text-slate-400 truncate">{cal.timeZone}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="block text-[10px] font-bold text-slate-400 uppercase">Sync Mode</label>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as any)}
            className="w-full text-[10px] bg-[#0e1117] text-slate-200 border border-slate-700 rounded-lg p-1 font-medium focus:outline-none cursor-pointer"
          >
            <option value="pull">📥 Pull Events</option>
            <option value="push">📤 Push Events</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-[10px] font-bold text-slate-400 uppercase">Family Member Tag</label>
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full text-[10px] bg-[#0e1117] text-slate-200 border border-slate-700 rounded-lg p-1 font-medium focus:outline-none cursor-pointer font-bold"
          >
            <option value="Family">🟢 Family (Whole Family)</option>
            {familyMembers.map((m) => (
              <option key={m.name} value={m.name}>👤 {m.name} ({m.role})</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onAddConnection(cal, direction, assignedTo)}
        className="w-full py-1 bg-[#0e1117] border border-slate-700 hover:border-indigo-500/40 hover:bg-slate-800/50 rounded-lg text-[10px] font-bold text-slate-200 flex items-center justify-center gap-1 transition-all cursor-pointer"
      >
        <Plus size={12} className="text-indigo-300" />
        <span>Create Connection Rule</span>
      </button>
    </div>
  );
}

export default function GoogleSyncPanel() {
  const {
    googleUser,
    handleGoogleLogoutClick,
    cloudInviteCode,
    handleJoinHousehold,
    inviteCodeInput, setInviteCodeInput,
    isJoiningHousehold,
    syncGoogleCalendars,
    isFetchingCalendars,
    hasOwnCalendarConnection, connectOwnCalendar,
    connectedCalendars,
    toggleGoogleCalendarActive,
    removeGoogleCalendarConnection,
    googleCalendarsList,
    familyMembers,
    addGoogleCalendarConnection,
    calendarSyncLogs, setCalendarSyncLogs,
    hiddenEvents, restoreHiddenEvent, restoreAllHiddenEvents,
  } = useCalendar();

  // The hidden-events restore list can get long; collapse it behind its count by default.
  const [hiddenOpen, setHiddenOpen] = useState(false);

  // Which connected calendars already have a PUSH rule — so a PULL-only rule can offer a one-tap "Enable push"
  // (the "Available Google Calendars" selector is empty after a reload, when there's no live Google token, so
  // it's the only place to turn a calendar into a push target — which is what the agent's Google-push approvals
  // need). Covers every parent's connected calendar (connectedCalendars is the shared household collection).
  const pushIds = new Set(connectedCalendars.filter(c => c.direction === 'push').map(c => c.id));

  return (
                <div className="space-y-4" id="google-calendars-sync-control">
                  {/* Active account + sync controls (user is always signed in here) */}
                  <div className="space-y-4">
                      {/* Active Account Header */}
                      <div className="bg-[#0e1117] border border-slate-700 rounded-2xl p-3 flex items-center justify-between gap-2 font-sans">
                        <div className="flex items-center gap-2 overflow-hidden">
                          {googleUser!.user_metadata?.avatar_url ? (
                            <img src={googleUser!.user_metadata.avatar_url} alt={googleUser!.user_metadata?.full_name || 'Google'} referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-slate-700" />
                          ) : (
                            <div className="w-8 h-8 bg-indigo-500/20 text-indigo-300 rounded-full flex items-center justify-center font-bold text-xs">
                              {googleUser!.user_metadata?.full_name ? googleUser!.user_metadata.full_name[0] : 'G'}
                            </div>
                          )}
                          <div className="overflow-hidden">
                            <span className="block text-xs font-bold text-slate-100 truncate">{googleUser!.user_metadata?.full_name || 'Authorized Account'}</span>
                            <span className="block text-[10px] text-slate-400 truncate">{googleUser!.email}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleGoogleLogoutClick}
                          className="px-2 py-1 text-[10px] font-bold text-rose-400 hover:bg-rose-500/15 rounded-lg border border-transparent hover:border-rose-500/30 transition-all cursor-pointer font-semibold"
                        >
                          Log out
                        </button>
                      </div>

                      {/* Household sharing */}
                      <div className="border border-emerald-500/30 rounded-2xl p-3 bg-emerald-500/10 font-sans space-y-2">
                        <h4 className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-300">Family Household</h4>
                        {cloudInviteCode && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-400">Invite code:</span>
                            <span className="font-mono text-sm font-bold text-emerald-300 tracking-widest bg-emerald-500/20 px-2 py-0.5 rounded-lg select-all">{cloudInviteCode}</span>
                            <span className="text-[10px] text-slate-400">Share with family</span>
                          </div>
                        )}
                        <form onSubmit={handleJoinHousehold} className="flex gap-2 items-center">
                          <input
                            type="text"
                            value={inviteCodeInput}
                            onChange={e => setInviteCodeInput(e.target.value.toUpperCase())}
                            placeholder="Enter code to join"
                            maxLength={6}
                            className="flex-1 px-2 py-1 text-xs bg-[#0e1117] text-slate-100 border border-slate-700 rounded-lg font-mono tracking-widest uppercase focus:outline-none focus:ring-1 focus:ring-emerald-400 placeholder:text-slate-500"
                          />
                          <button
                            type="submit"
                            disabled={isJoiningHousehold || !inviteCodeInput.trim()}
                            className="px-3 py-1 text-[10px] font-bold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-all cursor-pointer"
                          >
                            {isJoiningHousehold ? 'Joining…' : 'Join'}
                          </button>
                        </form>
                      </div>

                      {/* Auto-offer: a parent who joined an existing household has no connection of their own
                          yet (connectedCalendars is shared, so they see the other parent's rules). One tap
                          connects their primary calendar so the family can see their events — no hunting the
                          Available list. */}
                      {googleUser?.email && !hasOwnCalendarConnection && (
                        <div className="border border-emerald-500/40 rounded-2xl p-3 bg-emerald-500/10 font-sans space-y-2">
                          <p className="text-[11px] text-emerald-200 leading-snug">
                            <span className="font-extrabold">Your calendar isn't connected yet.</span> Connect it so the rest of your family can see your events here.
                          </p>
                          <button
                            type="button"
                            onClick={connectOwnCalendar}
                            disabled={isFetchingCalendars}
                            className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm cursor-pointer"
                          >
                            {isFetchingCalendars ? (
                              <>
                                <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                <span>Connecting…</span>
                              </>
                            ) : (
                              <>
                                <Plus size={12} />
                                <span>Connect my calendar ({googleUser.email})</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}

                      {/* Sync Controls Dashboard */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => syncGoogleCalendars()}
                          disabled={isFetchingCalendars || connectedCalendars.length === 0}
                          className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm cursor-pointer"
                        >
                          {isFetchingCalendars ? (
                            <>
                              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                              <span>Syncing Calendars...</span>
                            </>
                          ) : (
                            <>
                              <RefreshCw size={12} className="animate-pulse" />
                              <span>Execute Complete Sync</span>
                            </>
                          )}
                        </button>
                      </div>

                      {/* Hidden Events — synced events the user deleted are blocklisted from re-import; restore them here */}
                      {hiddenEvents.length > 0 && (
                        <div className="border border-amber-500/30 rounded-2xl p-3 bg-amber-500/10 font-sans space-y-2" id="hidden-events-card">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => setHiddenOpen(o => !o)}
                              aria-expanded={hiddenOpen}
                              className="text-[10px] font-extrabold uppercase tracking-widest text-amber-200 flex items-center gap-1 hover:text-amber-100 cursor-pointer"
                              id="hidden-events-toggle"
                            >
                              {hiddenOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              <EyeOff size={12} /> Hidden from sync ({hiddenEvents.length})
                            </button>
                            {hiddenOpen && (
                              <button
                                type="button"
                                onClick={restoreAllHiddenEvents}
                                disabled={isFetchingCalendars}
                                className="text-[11px] font-bold text-amber-300 hover:text-amber-200 border border-amber-500/40 hover:bg-amber-500/15 disabled:opacity-50 px-1.5 py-0.5 rounded-lg flex items-center gap-1 transition-all cursor-pointer"
                                id="hidden-events-restore-all"
                              >
                                <RotateCcw size={10} /> Restore all
                              </button>
                            )}
                          </div>
                          {hiddenOpen && (
                          <>
                          <p className="text-[11px] text-amber-300/80 leading-snug">
                            These synced events were deleted, so they won't return on the next sync. Restore re-pulls them from Google.
                          </p>
                          <div className="space-y-1 max-h-[120px] overflow-y-auto pr-1">
                            {hiddenEvents.map((h) => (
                              <div key={h.id} className="bg-[#131827] border border-amber-500/30 rounded-lg p-1.5 flex items-center justify-between gap-2">
                                <div className="overflow-hidden">
                                  <p className="text-[10px] font-bold text-slate-200 truncate" title={h.title}>{h.title}</p>
                                  {h.start && <p className="text-[10px] text-slate-400">{h.start}</p>}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => restoreHiddenEvent(h.id)}
                                  disabled={isFetchingCalendars}
                                  className="flex-shrink-0 text-[10px] font-bold text-amber-300 hover:text-white hover:bg-amber-600 border border-amber-500/40 disabled:opacity-50 px-1.5 py-0.5 rounded-md flex items-center gap-1 transition-all cursor-pointer"
                                  title="Restore this event"
                                >
                                  <RotateCcw size={9} /> Restore
                                </button>
                              </div>
                            ))}
                          </div>
                          </>
                          )}
                        </div>
                      )}

                      {/* Rule Connection Section */}
                      <div className="border border-indigo-500/30 rounded-2xl p-3 bg-indigo-500/10 font-sans">
                        <h4 className="text-[10px] font-extrabold uppercase tracking-widest text-indigo-300 mb-2">Connected Sync Rules ({connectedCalendars.length})</h4>

                        {connectedCalendars.length === 0 ? (
                          <div className="text-center py-4 bg-[#131827] border border-dashed border-indigo-500/30 rounded-xl">
                            <p className="text-[10px] text-slate-400">No active sync connectors yet.</p>
                            <p className="text-[11px] text-indigo-300 font-medium mt-0.5">Setup a calendar feed below to start!</p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {connectedCalendars.map((conn) => (
                              <div key={`${conn.id}-${conn.direction}`} className="bg-[#131827] border border-slate-700 rounded-xl p-2.5 flex items-center justify-between gap-2 shadow-sm">
                                <div className="overflow-hidden flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`text-[10px] font-extrabold px-1 py-0.5 rounded uppercase ${
                                      conn.direction === 'pull' ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30' : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                    }`}>
                                      {conn.direction === 'pull' ? 'PULL 📥' : 'PUSH 📤'}
                                    </span>
                                    <span className="text-[10px] text-slate-100 font-bold truncate max-w-[120px]">{conn.summary}</span>
                                  </div>
                                  <p className="text-[11px] text-slate-400 mt-1">
                                    {conn.direction === 'pull'
                                      ? `Pull to schedule ➡️ Assigned: ${conn.assignedTo}`
                                      : `Push events tags "${conn.assignedTo}" ➡️ export to Google`
                                    }
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  {/* Enable push: a PULL-only calendar can also become a PUSH target in one tap,
                                      so the agent's "push trip events to Google" approvals have somewhere to go
                                      (the Available list below is empty without a fresh Google token). Only for a
                                      calendar the CURRENT account owns — pushing to another parent's calendar
                                      would use a token that can't write to it. */}
                                  {conn.direction === 'pull' && !pushIds.has(conn.id) && (!conn.accountEmail || conn.accountEmail === googleUser?.email) && (
                                    <button
                                      type="button"
                                      onClick={() => addGoogleCalendarConnection({ id: conn.id, summary: conn.summary }, 'push', conn.assignedTo)}
                                      className="px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/15 rounded-lg transition-all cursor-pointer"
                                      title="Also push Family-Hub events to this calendar (enables the agent's Google-push approvals)"
                                    >
                                      📤 Enable push
                                    </button>
                                  )}
                                  {/* Toggle Active Switch */}
                                  <button
                                    type="button"
                                    className={`w-7 h-4 rounded-full p-0.5 transition-all focus:outline-none cursor-pointer ${
                                      conn.active ? 'bg-emerald-500' : 'bg-slate-600'
                                    }`}
                                    onClick={() => toggleGoogleCalendarActive(conn.id, conn.direction)}
                                    title={conn.active ? "Pause synchronization" : "Resume synchronization"}
                                  >
                                    <div className={`w-3 h-3 bg-white rounded-full shadow transition-all transform ${
                                      conn.active ? 'translate-x-3' : 'translate-x-0'
                                    }`} />
                                  </button>
                                  {/* Disconnect Trash Button */}
                                  <button
                                    type="button"
                                    onClick={() => removeGoogleCalendarConnection(conn.id, conn.direction)}
                                    className="p-1 hover:bg-slate-800 text-slate-400 hover:text-rose-400 rounded-lg transition-all cursor-pointer"
                                    title="Disconnect rule"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* New Calendar Connectors Setup List */}
                      <div className="font-sans">
                        <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Available Google Calendars ({googleCalendarsList.length})</span>
                        {isFetchingCalendars && googleCalendarsList.length === 0 ? (
                          <div className="text-center py-4 bg-[#0e1117] rounded-xl">
                            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto pb-1"></div>
                            <p className="text-[11px] text-slate-400 mt-1">Contacting Google services...</p>
                          </div>
                        ) : googleCalendarsList.length === 0 ? (
                          <div className="text-center py-3 px-3 bg-[#0e1117] border border-dashed border-slate-700 rounded-xl">
                            <p className="text-[11px] text-slate-400 leading-snug">
                              Tap <span className="font-bold text-indigo-300">Execute Complete Sync</span> to (re)load your Google calendars and add new feeds. To <span className="font-bold text-emerald-300">push</span> Family-Hub events to a calendar you've already connected, use <span className="font-bold text-emerald-300">📤 Enable push</span> on its rule above.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                            {googleCalendarsList.map((cal) => (
                              <GoogleCalendarSelectorRow
                                key={cal.id}
                                cal={cal}
                                familyMembers={familyMembers}
                                onAddConnection={addGoogleCalendarConnection}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Sync Event Output Console log (already dark) */}
                      {calendarSyncLogs.length > 0 && (
                        <div className="border border-slate-700 rounded-2xl p-2.5 bg-slate-900 text-slate-300 font-mono text-[11px] space-y-1">
                          <div className="flex justify-between items-center pb-1 border-b border-slate-800 mb-1.5">
                            <span className="font-bold text-slate-400">Interactive Sync Log Console</span>
                            <button type="button" onClick={() => setCalendarSyncLogs([])} className="text-[10px] border border-slate-700 text-slate-400 hover:text-white px-1.5 py-0.5 rounded cursor-pointer">Clear Logs</button>
                          </div>
                          <div className="max-h-[100px] overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-slate-700">
                            {calendarSyncLogs.map((log, idx) => (
                              <p key={idx} className="leading-snug text-slate-200">{log}</p>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                </div>
  );
}
