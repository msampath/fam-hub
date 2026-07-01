import { useState, type CSSProperties } from 'react';
import { useCalendar } from '../../../CalendarContext';
import { useApp } from '../../../AppContext';
import { buildTodayTomorrowAgenda } from '../../../utils/agenda';
import { toLocalDateStr, formatTime } from '../../../utils/dates';
import { earnedXp } from '../../../utils/chores';
import type { CalendarEvent } from '../../../types';
import { C, brutShadow, memberHex, CATEGORY_EMOJI } from '../theme';
import { useWeather } from '../useWeather';
import { aqiColor, aqiLabel, uvColor, uvLabel } from '../../../utils/weatherClient';
import BriefingCard from '../BriefingCard';
import GoalsStrip from '../GoalsStrip';

interface TodayPageProps {
  onNavigate: (index: number) => void;
  onOpenCalendar: () => void;
}

const WHOLE_FAMILY = new Set(['family', 'everyone', 'all']);
function isWholeFamily(members?: string[]): boolean {
  return !members || members.length === 0 || members.some(m => WHOLE_FAMILY.has(m.toLowerCase()));
}

export default function TodayPage({ onNavigate, onOpenCalendar }: TodayPageProps) {
  const { events, familyMembers, homeLat, homeLng, homeLabel, setSelectedEventDetail, conflicts, openWeekendsLeft } = useCalendar();
  const { choresList } = useApp();
  const weather = useWeather(homeLat, homeLng);

  const [pill, setPill] = useState('All');

  const now = new Date();
  const todayStr = toLocalDateStr(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = toLocalDateStr(tomorrow);

  const { todayEvents, tomorrowEvents } = buildTodayTomorrowAgenda(events, choresList, todayStr, tomorrowStr);

  const colorIdOf = (name: string) => familyMembers.find(m => m.name === name)?.color;
  const accentOf = (evt: CalendarEvent): string => {
    if (isWholeFamily(evt.members)) return C.emerald;
    return memberHex(colorIdOf(evt.members![0]));
  };
  const matchesPill = (evt: CalendarEvent) =>
    pill === 'All' || isWholeFamily(evt.members) || (evt.members?.includes(pill) ?? false);

  const upcoming = [
    ...todayEvents.filter(matchesPill).map(e => ({ e, day: '' })),
    ...tomorrowEvents.filter(matchesPill).map(e => ({ e, day: 'Tomorrow' })),
  ];

  // Chores teaser
  const kids = familyMembers.filter(m => m.role === 'Kid');
  const choresLeft = choresList.filter(c => (c.completedCount ?? 0) < (c.timesPerDay || 1)).length;
  const totalEarned = kids.reduce((sum, k) => sum + earnedXp(choresList, k.name), 0);
  const kidBar = (name: string) => {
    const kc = choresList.filter(c => c.assignedTo === name);
    const total = kc.reduce((a, c) => a + (c.points || 0), 0);
    const earned = earnedXp(choresList, name);
    return total > 0 ? Math.round((earned / total) * 100) : 0;
  };

  // Highlights — next 7 days (today..+6), distinct by title, long-weekend/holiday flagged amber.
  const in7 = new Date(now); in7.setDate(now.getDate() + 6);
  const in7Str = toLocalDateStr(in7);
  const highlights = events
    .filter(e => e.start && e.start.split('T')[0] >= todayStr && e.start.split('T')[0] <= in7Str)
    .sort((a, b) => (a.start! < b.start! ? -1 : 1))
    .slice(0, 6)
    .map(e => ({
      label: `${new Date(e.start! + 'T00:00').toLocaleDateString([], { weekday: 'short' })} · ${e.title}`,
      special: e.category === 'Holiday',
    }));

  const sectionLabel = (text: string, color: string = C.muted) => (
    <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color }}>{text}</div>
  );

  const heroCard: CSSProperties = {
    border: `2px solid ${C.brut}`, boxShadow: brutShadow(C.brut, 5), background: C.card,
  };

  const weatherTile = (label: string, value: string, sub: string, color: string) => (
    <div className="min-w-[60px] flex-1 rounded-[10px] px-2.5 py-2" style={{ border: `1.5px solid ${color}33`, background: `${color}10` }}>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: C.muted }}>{label}</div>
      <div className="text-lg font-extrabold leading-none" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-[10px] font-bold" style={{ color }}>{sub}</div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-16 md:py-7">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-5">

        {/* Member filter pills */}
        <div className="flex flex-wrap justify-center gap-2.5">
          {['All', ...familyMembers.map(m => m.name)].map(name => {
            const on = pill === name;
            const accent = name === 'All' ? C.indigo : memberHex(colorIdOf(name));
            return (
              <button
                key={name}
                type="button"
                onClick={() => setPill(name)}
                className="rounded-full px-5 py-2 text-xs font-extrabold uppercase tracking-wide"
                style={on
                  ? { border: `2px solid ${accent}`, boxShadow: brutShadow(name === 'All' ? C.indigoShadow : accent, 4), background: `${accent}1a`, color: accent }
                  : { border: `2px solid ${C.elevated}`, background: 'transparent', color: C.ink }}
              >
                {name}
              </button>
            );
          })}
        </div>

        {/* On-demand Morning-Briefing preview (capstone §7a) */}
        <BriefingCard />

        {/* Goals the concierge is tracking (A6) */}
        <GoalsStrip />

        {/* Conflicts / double-booking heads-up (reuses CalendarCtx.conflicts) */}
        {conflicts.length > 0 && (
          <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.orange}`, boxShadow: brutShadow('#7a3d00', 4), background: `${C.orange}12` }}>
            <div className="mb-2 text-[12px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.orange }}>
              ⚠️ {conflicts.length} double-booking{conflicts.length === 1 ? '' : 's'}
            </div>
            <div className="flex flex-col gap-1.5">
              {conflicts.slice(0, 3).map((cf, i) => (
                <button
                  key={`${cf.date}-${cf.member}-${i}`}
                  type="button"
                  onClick={() => cf.overlappingEvents[0] && setSelectedEventDetail(cf.overlappingEvents[0])}
                  className="rounded-[10px] px-3 py-2 text-left text-[13px] font-semibold"
                  style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
                >
                  <span style={{ color: C.orange }}>{cf.member}</span> · {cf.date} — {cf.overlappingEvents.map(e => e.title).join(' vs ')}
                </button>
              ))}
            </div>
            {conflicts.length > 3 && (
              <div className="mt-1.5 text-[11px] font-bold" style={{ color: C.orange }}>+{conflicts.length - 3} more</div>
            )}
            <div className="mt-2 text-[11px] font-semibold" style={{ color: C.ink }}>Tap to review, or ask the copilot to resolve.</div>
          </div>
        )}

        {/* Body: stacked (mobile) / 2-col (desktop) */}
        <div className="flex flex-col gap-4 md:flex-row md:gap-5">

          {/* Events card (hero) */}
          <div className="flex flex-1 flex-col rounded-[22px] p-5 md:p-6" style={heroCard}>
            <button
              type="button"
              onClick={onOpenCalendar}
              className="self-start text-[12px] font-bold uppercase tracking-[0.12em] underline-offset-4 hover:underline"
              style={{ color: C.muted }}
              title="Open calendar"
            >
              {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} 📅
            </button>
            <div className="mb-4 text-2xl font-extrabold md:text-[26px]" style={{ color: C.primary }}>
              {now.getHours() < 12 ? 'Good morning 👋' : now.getHours() < 18 ? 'Good afternoon 👋' : 'Good evening 👋'}
            </div>
            {sectionLabel('Coming up')}
            <div className="mt-3 flex flex-col gap-2.5">
              {upcoming.length === 0 ? (
                <div className="py-6 text-center text-sm font-semibold" style={{ color: C.ink }}>
                  You're all clear today and tomorrow 🎉
                </div>
              ) : upcoming.map(({ e, day }) => {
                const accent = accentOf(e);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSelectedEventDetail(e)}
                    className="flex w-full items-center gap-3.5 rounded-2xl px-3.5 py-3 text-left"
                    style={{ background: `${accent}12`, border: `2px solid ${accent}33` }}
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-xl" style={{ background: `${accent}24` }}>
                      {CATEGORY_EMOJI[e.category] || '📌'}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-bold" style={{ color: C.primary }}>{e.title}</div>
                      <div className="mt-0.5 text-xs font-semibold" style={{ color: accent }}>
                        {day && `${day} · `}{e.startTime ? formatTime(e.startTime) : 'All day'}{e.members?.length ? ` · ${e.members.join(', ')}` : ' · Family'}
                      </div>
                    </div>
                    <span className="ml-auto text-xl" style={{ color: C.muted }}>›</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right column: weather + chores teaser */}
          <div className="flex flex-1 flex-col gap-4">

            {/* Weather */}
            <div className="rounded-[22px] p-5 md:p-6" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
              {sectionLabel('Weather')}
              {weather && weather.tempF != null ? (
                <>
                  <div className="mt-2 text-5xl font-extrabold leading-none" style={{ color: C.primary }}>{weather.tempF}°</div>
                  <div className="mb-4 mt-1.5 text-[13px] font-semibold" style={{ color: C.muted }}>
                    {weather.condition}{homeLabel ? ` · ${homeLabel}` : ''}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {weather.aqi != null && weatherTile('AQI', String(weather.aqi), aqiLabel(weather.aqi), aqiColor(weather.aqi))}
                    {weather.uv != null && weatherTile('UV Index', String(weather.uv), uvLabel(weather.uv), uvColor(weather.uv))}
                    {weather.precipPct != null && weatherTile('Rain', `${weather.precipPct}%`, weather.precipType || 'none', C.indigo)}
                  </div>
                </>
              ) : (
                <div className="py-4 text-[13px] font-semibold" style={{ color: C.ink }}>
                  {homeLat == null ? 'Set your home location to see weather.' : 'Weather unavailable.'}
                </div>
              )}
            </div>

            {/* Chores teaser → Chores page */}
            <button
              type="button"
              onClick={() => onNavigate(1)}
              className="flex-1 rounded-[22px] p-5 text-left md:p-6"
              style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 5), background: `${C.indigo}0a` }}
            >
              {sectionLabel("Today's Chores", C.indigo)}
              <div className="mb-4 mt-1.5 flex items-start justify-between">
                <div className="text-2xl font-extrabold md:text-[28px]" style={{ color: C.primary }}>{choresLeft} left to do</div>
                <div className="text-right">
                  <div className="mb-0.5 text-[11px] font-semibold" style={{ color: C.muted }}>XP Earned</div>
                  <div className="text-2xl font-extrabold md:text-3xl" style={{ color: C.amber }}>+{totalEarned}</div>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {kids.map(k => {
                  const accent = memberHex(k.color);
                  return (
                    <div key={k.name} className="flex items-center gap-2.5">
                      <span className="w-16 flex-shrink-0 text-xs font-bold" style={{ color: accent }}>{k.name}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: C.elevated }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${kidBar(k.name)}%`, background: accent }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 text-right text-[11px] font-bold" style={{ color: C.indigo }}>Open Chores page →</div>
            </button>
          </div>
        </div>

        {/* Highlights strip */}
        {(highlights.length > 0 || openWeekendsLeft > 0) && (
          <div className="flex flex-wrap items-center gap-3 rounded-[18px] px-5 py-3.5" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
            <span className="text-[13px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.primary }}>Highlights · next 7 days</span>
            <div className="flex flex-wrap gap-2">
              {openWeekendsLeft > 0 && (
                <span className="rounded-full px-3.5 py-1.5 text-xs font-bold" style={{ background: `${C.emerald}1f`, border: `1.5px solid ${C.emerald}4d`, color: C.emerald }}>
                  {openWeekendsLeft} open weekend{openWeekendsLeft === 1 ? '' : 's'}
                </span>
              )}
              {highlights.map((h, i) => (
                <span
                  key={i}
                  className="rounded-full px-3.5 py-1.5 text-xs font-bold"
                  style={h.special
                    ? { background: `${C.amber}1f`, border: `1.5px solid ${C.amber}4d`, color: C.amber }
                    : { background: C.elevated, color: C.soft }}
                >
                  {h.label}{h.special ? ' 🎉' : ''}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
