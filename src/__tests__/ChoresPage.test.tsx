// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChoresPage from '../components/shell/pages/ChoresPage';
import { renderWithApp } from './helpers/mockContexts';
import type { Chore, FamilyMember } from '../types';

const kid = (name: string): FamilyMember => ({ name, role: 'Kid', color: 'sky' });
const chore = (over: Partial<Chore> & { id: string; assignedTo: string }): Chore => ({
  title: 'Make bed', points: 10, completed: false, completedCount: 0, timesPerDay: 1,
  repeatType: 'daily', scheduleTimeOfDay: 'Morning', ...over,
});

const members = [{ name: 'Mom', role: 'Parent', color: 'indigo' } as FamilyMember, kid('Ava'), kid('Max')];

describe('ChoresPage', () => {
  it('shows a member pill per kid and breaks chores into time-of-day sections', () => {
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [
        chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth', scheduleTimeOfDay: 'Morning' }),
        chore({ id: 'a2', assignedTo: 'Ava', title: 'Read book', scheduleTimeOfDay: 'Evening' }),
      ],
    });
    expect(screen.getByText('Ava')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
    // Default kid (Ava) broken out into sections:
    expect(screen.getByText('Morning')).toBeInTheDocument();
    expect(screen.getByText('Evening')).toBeInTheDocument();
    expect(screen.getByText('Brush teeth')).toBeInTheDocument();
    expect(screen.getByText('Read book')).toBeInTheDocument();
  });

  it('toggling a slot updates the chore via setChoresList', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth', timesPerDay: 1 })],
    });
    await user.click(screen.getByText('Mark'));
    expect(ctx.setChoresList).toHaveBeenCalled();
    // the updater bumps completedCount to 1 (>= timesPerDay → completed)
    const updater = (ctx.setChoresList as any).mock.calls[0][0] as (p: Chore[]) => Chore[];
    const next = updater([chore({ id: 'a1', assignedTo: 'Ava', timesPerDay: 1 })]);
    expect(next[0].completedCount).toBe(1);
    expect(next[0].completed).toBe(true);
  });

  it('exposes each chore slot as a checkbox reflecting its completion (a11y)', () => {
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [
        chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth', timesPerDay: 1, completedCount: 0 }),
        chore({ id: 'a2', assignedTo: 'Ava', title: 'Tidy room', timesPerDay: 1, completedCount: 1, completed: true }),
      ],
    });
    expect(screen.getByRole('checkbox', { name: 'Brush teeth' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: 'Tidy room' })).toHaveAttribute('aria-checked', 'true');
  });

  it('switching kids changes the visible board', async () => {
    const user = userEvent.setup();
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [
        chore({ id: 'a1', assignedTo: 'Ava', title: 'Ava task' }),
        chore({ id: 'm1', assignedTo: 'Max', title: 'Max task' }),
      ],
    });
    expect(screen.getByText('Ava task')).toBeInTheDocument();
    expect(screen.queryByText('Max task')).not.toBeInTheDocument();
    await user.click(screen.getByText('Max'));
    expect(screen.getByText('Max task')).toBeInTheDocument();
    expect(screen.queryByText('Ava task')).not.toBeInTheDocument();
  });

  it('prompts to add a kid when there are none', () => {
    renderWithApp(<ChoresPage />, { familyMembers: [{ name: 'Mom', role: 'Parent', color: 'indigo' }] });
    expect(screen.getByText(/Add a family member with the/i)).toBeInTheDocument();
  });

  it('adds a chore via the inline add-chore form', async () => {
    const user = userEvent.setup();
    // title + assignee are context-controlled; seed them so the add guard passes.
    const { ctx } = renderWithApp(<ChoresPage />, {
      familyMembers: members, newChoreTitle: 'Sweep', newChoreAssigned: 'Ava',
    });
    await user.click(screen.getByText(/Add chore for/i));   // open the form
    await user.click(screen.getByText('Add chore'));        // submit
    expect(ctx.setChoresList).toHaveBeenCalled();
  });
});
