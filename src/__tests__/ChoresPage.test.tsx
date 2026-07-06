// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
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

  it('renders a picture emoji before each chore title (pre-reader navigation)', () => {
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Make your bed' })],
    });
    expect(screen.getByText('🛏️')).toBeInTheDocument();
  });

  it('asks for confirmation before deleting a chore (and keeps it on cancel)', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { ctx } = renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth' })],
    });
    confirmSpy.mockReturnValueOnce(false); // cancel → no delete
    await user.click(screen.getByRole('button', { name: 'Delete Brush teeth' }));
    expect(ctx.setChoresList).not.toHaveBeenCalled();
    confirmSpy.mockReturnValueOnce(true);  // confirm → delete goes through
    await user.click(screen.getByRole('button', { name: 'Delete Brush teeth' }));
    expect(ctx.setChoresList).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('kid mode hides the delete button and the add-chore form', () => {
    renderWithApp(<ChoresPage />, {
      kidMode: true,
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth' })],
    });
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Add chore for/i)).not.toBeInTheDocument();
    // The check-off slots stay — the board remains fully usable for the kid.
    expect(screen.getByRole('checkbox', { name: 'Brush teeth' })).toBeInTheDocument();
  });

  it('fires the confetti celebration when the LAST slot of a chore is checked', async () => {
    const user = userEvent.setup();
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth', timesPerDay: 1, completedCount: 0 })],
    });
    expect(screen.queryByTestId('confetti-burst')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Brush teeth' }));
    expect(screen.getByTestId('confetti-burst')).toBeInTheDocument();
  });

  it('does NOT fire confetti when a mid slot of a multi-rep chore is checked', async () => {
    const user = userEvent.setup();
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'a1', assignedTo: 'Ava', title: 'Brush teeth', timesPerDay: 2, completedCount: 0 })],
    });
    await user.click(screen.getByRole('checkbox', { name: 'Brush teeth (1)' }));
    expect(screen.queryByTestId('confetti-burst')).not.toBeInTheDocument();
  });
});

describe('ChoresPage — AI starter chore plan entry point', () => {
  it('offers the generate button on the GLOBAL empty state and opens the modal', () => {
    const setIsGeneratingChoresOpen = vi.fn();
    renderWithApp(<ChoresPage />, { familyMembers: members, choresList: [], setIsGeneratingChoresOpen });
    const btn = screen.getByText(/Generate a starter chore plan/i);
    fireEvent.click(btn);
    expect(setIsGeneratingChoresOpen).toHaveBeenCalledWith(true);
  });

  it('retires the button once ANY chore exists (even for another kid) and hides it in kid mode', () => {
    // Ava's board is empty but Max has a chore → per-kid empty text shows WITHOUT the starter button.
    renderWithApp(<ChoresPage />, {
      familyMembers: members,
      choresList: [chore({ id: 'c1', assignedTo: 'Max' })],
    });
    expect(screen.getByText(/No chores yet for Ava/i)).toBeInTheDocument();
    expect(screen.queryByText(/Generate a starter chore plan/i)).toBeNull();
  });

  it('is absent in kid mode even on the empty state (parents review plans)', () => {
    renderWithApp(<ChoresPage />, { familyMembers: members, choresList: [], kidMode: true });
    expect(screen.queryByText(/Generate a starter chore plan/i)).toBeNull();
  });
});
