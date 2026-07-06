import { describe, it, expect } from 'vitest';
import { buildGoogleEventBody, googleEventMarker, findGoogleEventByMarker, summarizePushResult, selectPushTargets, pushableLocalEvents, isFamilyHubMarked, selectAutoPushEvents, shouldAutoPull } from '../utils/googleEvent';
import { APP_NAME } from '../constants';
import type { CalendarEvent } from '../types';

describe('selectPushTargets (A3 push last-mile)', () => {
  it('prefers the connected, active PUSH-rule calendars', () => {
    const connected = [
      { id: 'work@x', direction: 'push' as const, active: true },
      { id: 'sub@x', direction: 'pull' as const, active: true },
      { id: 'paused@x', direction: 'push' as const, active: false },
    ];
    expect(selectPushTargets(connected, [{ id: 'primary@x', primary: true, accessRole: 'owner' }])).toEqual(['work@x']);
  });
  it('falls back to the WRITABLE primary when there is no Push rule; [] for a reader-only primary', () => {
    expect(selectPushTargets([], [{ id: 'primary@x', primary: true, accessRole: 'owner' }])).toEqual(['primary@x']);
    expect(selectPushTargets([], [{ id: 'ro@x', primary: true, accessRole: 'reader' }])).toEqual([]); // can't write
    expect(selectPushTargets([], [])).toEqual([]);
  });
  it('scopes push targets to the CURRENT account — never another parent\'s calendar (wrong token → 403)', () => {
    const connected = [
      { id: 'mine@x', direction: 'push' as const, active: true, accountEmail: 'me@x' },
      { id: 'theirs@x', direction: 'push' as const, active: true, accountEmail: 'them@x' },
    ];
    expect(selectPushTargets(connected, [], 'me@x')).toEqual(['mine@x']);              // only my push cal
    expect(selectPushTargets(connected, [], 'them@x')).toEqual(['theirs@x']);          // only their push cal
    // No currentEmail given (legacy single-parent) → both attempted; a legacy rule with no accountEmail too.
    expect(selectPushTargets([{ id: 'legacy@x', direction: 'push' as const, active: true }], [], 'me@x')).toEqual(['legacy@x']);
  });
});

describe('pushableLocalEvents (family-calendar bulk push)', () => {
  it('keeps Family-Hub events of ANY member tag, drops pulled gcal- events', () => {
    const evs = [
      { id: 'evt-1', members: ['Ajay'] },
      { id: 'evt-2', members: ['Everyone'] },     // whole-family — now pushes too
      { id: 'evt-3', members: ['Ananya'] },        // a kid's event — parents still want it
      { id: 'gcal-abc-1', members: ['Family'] },   // pulled from Google → excluded (would echo to source)
    ];
    expect(pushableLocalEvents(evs).map(e => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });
  it('tolerates a non-array input', () => {
    expect(pushableLocalEvents(undefined as any)).toEqual([]);
  });
});

describe('isFamilyHubMarked + selectAutoPushEvents (silent auto-push)', () => {
  it('isFamilyHubMarked detects our own pushed-copy marker (pull skips these)', () => {
    expect(isFamilyHubMarked('plans\n\n[FamilyHub-id:abc]')).toBe(true);
    expect(isFamilyHubMarked('an ordinary google event')).toBe(false);
    expect(isFamilyHubMarked(undefined)).toBe(false);
  });
  it('selects only non-gcal, in-window, not-already-pushed events', () => {
    const evs = [
      { id: 'a', start: '2026-07-05' },        // in window, unpushed → push
      { id: 'b', start: '2026-07-06' },        // already pushed → skip
      { id: 'gcal-x-1', start: '2026-07-05' }, // pulled from Google → skip
      { id: 'c', start: '2030-01-01' },        // after window → skip
      { id: 'd', start: '2020-01-01' },        // before window → skip
    ];
    expect(selectAutoPushEvents(evs, ['b'], '2026-06-01', '2026-12-31').map(e => e.id)).toEqual(['a']);
  });
  it('accepts a Set or an array for pushedIds', () => {
    const evs = [{ id: 'a', start: '2026-07-05' }];
    expect(selectAutoPushEvents(evs, new Set(['a']), '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

const ev = (over: Partial<CalendarEvent> & { id: string }): CalendarEvent => ({
  title: 'X', start: '2026-06-18', category: 'Other', ...over,
});

describe('googleEventMarker', () => {
  it('embeds the app event id for find-or-update dedupe', () => {
    expect(googleEventMarker({ id: 'abc' })).toBe('[FamilyHub-id:abc]');
  });
});

describe('buildGoogleEventBody', () => {
  it('all-day event uses date start/end (end defaults to start)', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'a', title: 'Picnic', start: '2026-07-04' }));
    expect(body.start).toEqual({ date: '2026-07-04' });
    expect(body.end).toEqual({ date: '2026-07-04' });
    expect(body.summary).toBe('Picnic');
  });

  it('multi-day all-day event keeps its end date', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'a2', start: '2026-07-04', end: '2026-07-06' }));
    expect(body.start).toEqual({ date: '2026-07-04' });
    expect(body.end).toEqual({ date: '2026-07-06' });
  });

  it('timed event uses dateTime with a device tz', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'b', startTime: '16:00', endTime: '17:30' }));
    expect(body.start.dateTime).toBe('2026-06-18T16:00:00');
    expect(body.end.dateTime).toBe('2026-06-18T17:30:00');
    expect(body.start.timeZone).toBeTruthy();
  });

  it('defaults a missing end time to start + 1h', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'c', startTime: '16:00' }));
    expect(body.end.dateTime).toBe('2026-06-18T17:00:00');
  });

  it('guards a zero-/negative-duration same-day timed event (end <= start → start + 1h)', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'd', startTime: '16:00', endTime: '16:00' }));
    expect(body.end.dateTime).toBe('2026-06-18T17:00:00');
  });

  it('rolls the end DATE forward when start + 1h crosses midnight', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'e', startTime: '23:30' }));
    expect(body.end.dateTime).toBe('2026-06-19T00:30:00');
  });

  it('embeds the dedupe marker + app attribution + members in the description', () => {
    const body: any = buildGoogleEventBody(ev({ id: 'f', members: ['Leo', 'Mia'], description: 'note' }));
    expect(body.description).toContain('[FamilyHub-id:f]');
    expect(body.description).toContain(APP_NAME);
    expect(body.description).toContain('Leo, Mia');
    expect(body.description).toContain('note');
  });
});

describe('findGoogleEventByMarker (find-or-update vs insert)', () => {
  const items = [
    { id: 'g1', description: 'some other event' },
    { id: 'g2', description: 'plans\n\n[FamilyHub-id:abc]' },
    { id: 'g3' }, // no description
  ];

  it('finds the event whose description contains the marker', () => {
    expect(findGoogleEventByMarker(items, '[FamilyHub-id:abc]')?.id).toBe('g2');
  });

  it('returns undefined when no event carries the marker (→ insert path)', () => {
    expect(findGoogleEventByMarker(items, '[FamilyHub-id:zzz]')).toBeUndefined();
  });

  it('tolerates a non-array input', () => {
    expect(findGoogleEventByMarker(undefined as any, '[FamilyHub-id:abc]')).toBeUndefined();
  });
});

describe('summarizePushResult', () => {
  it('singular vs plural calendars', () => {
    expect(summarizePushResult(1, 0)).toBe('Pushed to 1 calendar.');
    expect(summarizePushResult(2, 0)).toBe('Pushed to 2 calendars.');
    expect(summarizePushResult(0, 0)).toBe('Pushed to 0 calendars.');
  });

  it('appends the failure count when any failed', () => {
    expect(summarizePushResult(1, 1)).toBe('Pushed to 1 calendar, 1 failed.');
    expect(summarizePushResult(2, 3)).toBe('Pushed to 2 calendars, 3 failed.');
  });
});

describe('shouldAutoPull (W8 sign-in auto-pull gate)', () => {
  const pullConn = { direction: 'pull' as const, active: true, accountEmail: 'mom@x.com' };
  const base = { backendMode: 'supabase', email: 'mom@x.com', alreadyRan: false, connected: [pullConn] };

  it('fires exactly when cloud + signed in + not yet run + an active pull rule for this account', () => {
    expect(shouldAutoPull(base)).toBe(true);
  });

  it('never fires on the LAN appliance (sqlite mode / pseudo-user without an email)', () => {
    expect(shouldAutoPull({ ...base, backendMode: 'sqlite' })).toBe(false);
    expect(shouldAutoPull({ ...base, backendMode: 'unknown' })).toBe(false);
    expect(shouldAutoPull({ ...base, email: undefined })).toBe(false);
  });

  it('is once-per-session: alreadyRan suppresses it', () => {
    expect(shouldAutoPull({ ...base, alreadyRan: true })).toBe(false);
  });

  it('requires an ACTIVE pull rule — push-only, deactivated, or no connections do not trigger it', () => {
    expect(shouldAutoPull({ ...base, connected: [] })).toBe(false);
    expect(shouldAutoPull({ ...base, connected: [{ direction: 'push', active: true, accountEmail: 'mom@x.com' }] })).toBe(false);
    expect(shouldAutoPull({ ...base, connected: [{ ...pullConn, active: false }] })).toBe(false);
  });

  it("skips another parent's pull rule (their session syncs it) but accepts a legacy rule with no accountEmail", () => {
    expect(shouldAutoPull({ ...base, connected: [{ ...pullConn, accountEmail: 'dad@x.com' }] })).toBe(false);
    expect(shouldAutoPull({ ...base, connected: [{ direction: 'pull', active: true }] })).toBe(true);
  });
});
