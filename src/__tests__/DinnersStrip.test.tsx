// @vitest-environment jsdom
// This week's dinners strip (the meal planner's Today surface): newest week's day chips, today
// highlighted, ✨ on agent-proposed days, read-only with the copilot hint. Kid-safe as-is.
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DinnersStrip from '../components/shell/DinnersStrip';
import { renderWithApp } from './helpers/mockContexts';
import { toLocalDateStr, addOneDayUTC } from '../utils/dates';
import type { MealPlan } from '../types';

const today = toLocalDateStr(new Date());
const tomorrow = addOneDayUTC(today);
const PLAN: MealPlan = {
  id: 'meal-1', weekStart: '2026-01-05', status: 'active',
  days: [
    { date: today, dish: 'Paneer butter masala', source: 'given' },
    { date: tomorrow, dish: 'Tacos', source: 'generated', note: 'quick — soccer night' },
  ],
};

describe('DinnersStrip', () => {
  it('renders the week: today highlighted, ✨ only on generated days, notes shown', () => {
    renderWithApp(<DinnersStrip />, { mealPlans: [PLAN] });
    const todayChip = screen.getByLabelText(/dinner: Paneer butter masala/);
    expect(todayChip).toHaveAttribute('aria-current', 'date');
    expect(todayChip.textContent).toContain('today');
    expect(todayChip.textContent).not.toContain('✨'); // dictated, not proposed
    const tomorrowChip = screen.getByLabelText(/dinner: Tacos/);
    expect(tomorrowChip).not.toHaveAttribute('aria-current');
    expect(tomorrowChip.textContent).toContain('✨ Tacos');
    expect(tomorrowChip.textContent).toContain('quick — soccer night');
    // Read-only + the copilot hint (changes go through the bar, not taps).
    expect(screen.getByText(/say "swap Thursday to …"/)).toBeInTheDocument();
  });

  it('newest week wins when several plans exist', () => {
    const older: MealPlan = { id: 'meal-0', weekStart: '2020-01-06', status: 'active', days: [{ date: '2020-01-06', dish: 'Ancient stew' }] };
    renderWithApp(<DinnersStrip />, { mealPlans: [older, PLAN] });
    expect(screen.getByText(/Paneer butter masala/)).toBeInTheDocument();
    expect(screen.queryByText(/Ancient stew/)).toBeNull();
  });

  it('a lunch plan coexists with the same week\'s dinners, chips meal-tagged (the lunches bug)', () => {
    const lunch: MealPlan = { id: 'meal-2', weekStart: PLAN.weekStart, meal: 'lunch', status: 'active', days: [{ date: today, dish: 'Puliodharai', note: 'we have everything we need' }] };
    renderWithApp(<DinnersStrip />, { mealPlans: [PLAN, lunch] });
    const lunchChip = screen.getByLabelText(/lunch: Puliodharai/);
    expect(lunchChip.textContent).toMatch(/lunch · /i); // the meal tag on a non-dinner chip
    expect(screen.getByLabelText(/dinner: Paneer butter masala/)).toBeInTheDocument(); // dinners still there
  });

  it('a per-meal Clear deletes that meal for that week (manual CRUD); kid mode hides it', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<DinnersStrip />, { mealPlans: [PLAN] });
    await user.click(screen.getByLabelText('Clear the dinner plan'));
    expect(ctx.deleteMealPlan).toHaveBeenCalledWith({ meal: 'dinner', weekStart: PLAN.weekStart });
    // Kid mode → no Clear (bulk/destructive).
    const k = renderWithApp(<DinnersStrip />, { mealPlans: [PLAN], kidMode: true });
    expect(within(k.container).queryByLabelText('Clear the dinner plan')).not.toBeInTheDocument();
  });

  it('empty state invites a plan through the copilot', () => {
    renderWithApp(<DinnersStrip />, { mealPlans: [] });
    expect(screen.getByText(/No meal plan yet/)).toBeInTheDocument();
  });
});
