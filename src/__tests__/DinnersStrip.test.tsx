// @vitest-environment jsdom
// This week's dinners strip (the meal planner's Today surface): newest week's day chips, today
// highlighted, ✨ on agent-proposed days, read-only with the copilot hint. Kid-safe as-is.
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
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

  it('empty state invites a plan through the copilot', () => {
    renderWithApp(<DinnersStrip />, { mealPlans: [] });
    expect(screen.getByText(/No dinner plan yet/)).toBeInTheDocument();
  });
});
