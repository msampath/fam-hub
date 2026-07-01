import { describe, it, expect } from 'vitest';
import { buildTodayTomorrowAgenda } from '../utils/agenda';
import type { CalendarEvent, Chore } from '../types';

const evt = (over: Partial<CalendarEvent> & { id: string; start: string }): CalendarEvent => ({
  title: 'E', category: 'Other', ...over,
});
const chore = (over: Partial<Chore> & { id: string }): Chore => ({
  title: 'C', assignedTo: 'Leo', points: 10, completed: false,
  completedCount: 0, timesPerDay: 1, repeatType: 'daily', ...over,
});

const TODAY = '2026-06-16';
const TOMORROW = '2026-06-17';

describe('buildTodayTomorrowAgenda', () => {
  it('splits events into today vs tomorrow by date', () => {
    const events = [
      evt({ id: 'a', start: TODAY }),
      evt({ id: 'b', start: TOMORROW }),
      evt({ id: 'c', start: '2026-06-20' }), // neither
    ];
    const r = buildTodayTomorrowAgenda(events, [], TODAY, TOMORROW);
    expect(r.todayEvents.map(e => e.id)).toEqual(['a']);
    expect(r.tomorrowEvents.map(e => e.id)).toEqual(['b']);
  });

  it('treats a multi-day span as falling on both days it covers', () => {
    const events = [evt({ id: 'span', start: '2026-06-15', end: '2026-06-18' })];
    const r = buildTodayTomorrowAgenda(events, [], TODAY, TOMORROW);
    expect(r.todayEvents).toHaveLength(1);
    expect(r.tomorrowEvents).toHaveLength(1);
  });

  it('lists only chores still pending today (completedCount < timesPerDay)', () => {
    const chores = [
      chore({ id: 'pending', completedCount: 0, timesPerDay: 1 }),
      chore({ id: 'partial', completedCount: 1, timesPerDay: 2 }),
      chore({ id: 'done', completedCount: 2, timesPerDay: 2 }),
    ];
    const r = buildTodayTomorrowAgenda([], chores, TODAY, TOMORROW);
    expect(r.todayChores.map(c => c.id).sort()).toEqual(['partial', 'pending']);
  });

  it('orders today/tomorrow events by start time (all-day first, then ascending)', () => {
    const events = [
      evt({ id: 'pm', start: TODAY, startTime: '18:00' }),
      evt({ id: 'allday', start: TODAY }),
      evt({ id: 'am', start: TODAY, startTime: '09:00' }),
    ];
    const r = buildTodayTomorrowAgenda(events, [], TODAY, TOMORROW);
    expect(r.todayEvents.map(e => e.id)).toEqual(['allday', 'am', 'pm']);
  });

  it('handles events with no start gracefully', () => {
    const r = buildTodayTomorrowAgenda([evt({ id: 'x', start: '' })], [], TODAY, TOMORROW);
    expect(r.todayEvents).toHaveLength(0);
    expect(r.tomorrowEvents).toHaveLength(0);
  });

  it('returns empty arrays for no input', () => {
    const r = buildTodayTomorrowAgenda([], [], TODAY, TOMORROW);
    expect(r).toEqual({ todayEvents: [], tomorrowEvents: [], todayChores: [] });
  });
});
