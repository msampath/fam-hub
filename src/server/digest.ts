import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { buildBriefing, type Briefing } from '../utils/briefing';
import { buildProactiveLedger, buildGoalNudges } from '../utils/proactiveBriefing';
import { MORNING_PLANNER_SYSTEM, buildMorningPlannerSchema, MORNING_GENCONFIG, buildMorningFacts, validateMorningProposals, toLedgerEntries } from '../utils/morningAgent';
import { sanitizeStoreList } from '../constants';
import { LEDGER_CAP } from '../utils/historyLog';
import { shouldRunDigestNow } from '../utils/digest';
import { sendDigestEmail } from '../utils/mailer';
import { familyDataRow, FAMILY_DATA_CONFLICT } from '../utils/familyData';
import { buildBriefingWeather } from '../utils/weatherFacts';
import { buildMemberSections, buildRichNudges } from '../utils/personalDigest';
import { buildRoutineDrafts } from '../utils/routineMiner';
import { callGeminiJSON } from './gemini';
import { fetchWeatherDaily, fetchAirQualityDaily } from './grounding';
import type { CalendarEvent, Chore, FamilyMember, LedgerEntry, Goal, ShoppingItem } from '../types';

const AGENT_BASE_URL = (process.env.AGENT_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

export function briefingToText(b: Briefing, weatherLine?: string): string {
  const out = [b.title, '', ...b.lines];
  if (weatherLine) out.push('', weatherLine);
  if (b.nudges.length) { out.push('', 'A few nudges:'); for (const n of b.nudges) out.push(`- ${n.text}`); }
  return out.join('\n');
}

const asTypedArray = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : []);

export async function composeBriefingViaAgent(factsText: string, today: string): Promise<string | null> {
  const prompt =
    `Write today's family morning-briefing email (${today}). Use ONLY the verified facts below — do not ` +
    `invent events, chores, or places, and do not call any tools. Keep it warm, brief, and skimmable: a ` +
    `one-line greeting, then the agenda, then any nudges as short bullets. Plain text, no markdown headers.\n\n` +
    `VERIFIED FACTS:\n${factsText}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(`${AGENT_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
      signal: ctrl.signal,
    });
    if (!r.ok) { console.warn(`[digest] agent compose HTTP ${r.status} — using deterministic briefing`); return null; }
    const j: any = await r.json();
    const reply = typeof j?.reply === 'string' ? j.reply.trim() : '';
    return reply || null;
  } catch (e: any) {
    console.warn('[digest] agent compose failed — using deterministic briefing:', e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDailyDigest(): Promise<void> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !process.env.RESEND_API_KEY) {
    console.log('[digest] tick — not configured (needs SUPABASE_SERVICE_ROLE_KEY + RESEND_API_KEY); skipping.');
    return;
  }
  const admin = createClient(process.env.VITE_SUPABASE_URL || '', serviceKey, { auth: { persistSession: false } });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const { data: prefsRows } = await admin.from('family_data').select('household_id,data').eq('data_key', 'digestprefs');
  for (const row of prefsRows || []) {
    const prefs = Array.isArray(row.data) ? row.data[0] : null;
    const recipients = Array.from(new Set([
      ...(Array.isArray(prefs?.emails) ? prefs.emails : []),
      ...(prefs?.email ? [prefs.email] : []),
    ].map((e: any) => String(e || '').trim()).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))));
    if (!prefs?.enabled || !recipients.length) continue;
    if (!shouldRunDigestNow(now, Number(prefs.sendHour ?? 7), prefs.lastRunDate || null, today)) continue;
    await admin.from('family_data').upsert(familyDataRow(row.household_id, 'digestprefs', [{ ...prefs, lastRunDate: today }]), { onConflict: FAMILY_DATA_CONFLICT });
    const DIGEST_KEYS = ['events', 'chores', 'settings', 'actionledger', 'goals', 'shopping', 'members', 'mealplan'] as const;
    const { data: batchRows } = await admin.from('family_data').select('data_key,data').eq('household_id', row.household_id).in('data_key', [...DIGEST_KEYS]);
    const byKey: Record<string, unknown> = {};
    for (const r of batchRows || []) byKey[r.data_key] = r.data;
    const events = asTypedArray<CalendarEvent>(byKey.events);
    const choresArr = asTypedArray<Chore>(byKey.chores);
    const briefing = buildBriefing(events, choresArr, today, 14, (byKey.mealplan as any[]) || []);

    const home = (byKey.settings as any[])?.[0] || {};
    const lat = Number(home.homeLat), lng = Number(home.homeLng);
    const hasHome = Number.isFinite(lat) && Number.isFinite(lng);
    const weather = hasHome ? await fetchWeatherDaily(lat, lng) : null;
    const aqiByDate = hasHome ? await fetchAirQualityDaily(lat, lng) : {};
    const weatherLine = buildBriefingWeather(weather, aqiByDate, today);

    const goals = asTypedArray<Goal>(byKey.goals);
    let stagedCount = 0;
    try {
      const ledger = asTypedArray<LedgerEntry>(byKey.actionledger);
      if (!ledger.some(e => e?.proactiveDate === today)) {
        const stamp = { createdAt: new Date(now).toISOString(), createdByUserId: 'concierge', createdByEmail: 'concierge@familyhub' };
        const staged = buildProactiveLedger(briefing, weather, events, today, () => 'ledg-' + randomUUID(), stamp, ledger);
        let planned: LedgerEntry[] = [];
        try {
          const shopping = asTypedArray<ShoppingItem>(byKey.shopping);
          const chores = asTypedArray<Chore>(byKey.chores);
          const plannerStores = sanitizeStoreList(home.storeList);
          const facts = buildMorningFacts({ today, agendaText: briefingToText(briefing, weatherLine), weatherLine, chores, shopping, goals, pendingLedger: [...ledger, ...staged] });
          const raw = await callGeminiJSON(facts, MORNING_PLANNER_SYSTEM, buildMorningPlannerSchema(plannerStores), '{"proposals":[]}', undefined, MORNING_GENCONFIG);
          const proposals = validateMorningProposals(raw?.proposals, { today, shopping, pendingLedger: [...ledger, ...staged], goals, factsText: facts, stores: plannerStores });
          planned = toLedgerEntries(proposals, today, () => 'ledg-' + randomUUID(), stamp);
        } catch (e: any) {
          console.warn('[digest] morning planner skipped (deterministic nudges still staged):', e?.message || e);
        }
        const routineDrafts = buildRoutineDrafts(
          home.routines, today, [...ledger, ...staged, ...planned],
          asTypedArray<ShoppingItem>(byKey.shopping).filter((s: any) => !s.completed).map((s: any) => s.text),
          () => 'ledg-' + randomUUID(), stamp,
        );
        const allStaged = [...staged, ...planned, ...routineDrafts];
        if (allStaged.length) {
          const merged = [...ledger, ...allStaged].slice(-LEDGER_CAP);
          await admin.from('family_data').upsert(familyDataRow(row.household_id, 'actionledger', merged), { onConflict: FAMILY_DATA_CONFLICT });
          stagedCount = allStaged.length;
        }
      }
    } catch (e: any) {
      console.warn('[digest] proactive staging failed (email still sent):', e?.message || e);
    }

    const goalNudges = buildGoalNudges(goals);
    const parts = [briefingToText(briefing, weatherLine)];
    if (stagedCount) parts.push(`🛎️ ${stagedCount} draft${stagedCount === 1 ? '' : 's'} waiting in Approvals — review when you open the app.`);
    if (goalNudges.length) parts.push(`Goals in progress:\n${goalNudges.join('\n')}`);
    const memberSections = buildMemberSections(asTypedArray<FamilyMember>(byKey.members), events, choresArr, today);
    if (memberSections.length) parts.push(memberSections.join('\n\n'));
    const richNudges = buildRichNudges(events, today, asTypedArray<ShoppingItem>(byKey.shopping).filter((s: any) => !s.completed).length);
    if (richNudges.length) parts.push(`Worth planning ahead:\n${richNudges.map(n => `- ${n}`).join('\n')}`);
    const factsText = parts.join('\n\n');
    const body = (await composeBriefingViaAgent(factsText, today)) || factsText;
    for (const to of recipients) {
      const sent = await sendDigestEmail(to, `Your Family-Hub briefing — ${today}`, body);
      if (!sent.ok && !sent.skipped) console.warn(`[digest] send to ${to} FAILED: ${sent.error} — if this is 'resend 403', verify a domain in Resend and set DIGEST_FROM_EMAIL to it (the shared onboarding@resend.dev sender only delivers to the Resend account owner).`);
    }
  }
}

let _digestRunning = false;
export function startDigestScheduler(): void {
  if (process.env.DIGEST_TRIGGER_SECRET) {
    console.log('[digest] Cloud Scheduler mode — in-process interval disabled; trigger via POST /internal/run-digest.');
    return;
  }
  if (process.env.DIGEST_SCHEDULER_ENABLED !== 'true') return;
  console.log('[digest] in-process scheduler enabled (every 5 min). For multi-instance, set DIGEST_TRIGGER_SECRET + Cloud Scheduler.');
  const timer = setInterval(() => {
    if (_digestRunning) return;
    _digestRunning = true;
    void runDailyDigest()
      .catch(e => console.error('[digest] run failed:', e?.message || e))
      .finally(() => { _digestRunning = false; });
  }, 5 * 60 * 1000);
  timer.unref();
}
