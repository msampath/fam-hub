// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import GoalsStrip from '../components/shell/GoalsStrip';
import { renderWithBoth } from './helpers/mockContexts';
import type { Goal } from '../types';

const goals: Goal[] = [
  { id: 'g1', text: 'Plan the Rainier trip', status: 'open', nextAction: 'Book the timed-entry pass' },
  { id: 'g2', text: 'Renew library cards', status: 'done' },
];

describe('GoalsStrip (A6 — goals the concierge tracks)', () => {
  it('shows open goals with their next action', () => {
    const { getByText } = renderWithBoth(<GoalsStrip />, { goalsList: goals });
    expect(getByText('Plan the Rainier trip')).toBeInTheDocument();
    expect(getByText(/Book the timed-entry pass/)).toBeInTheDocument();
  });

  it('has no manual add box — goals are agent-created (ask the copilot in the bar)', () => {
    const { queryByLabelText, getByText } = renderWithBoth(<GoalsStrip />, { goalsList: [] });
    expect(queryByLabelText('Add a goal')).not.toBeInTheDocument();
    expect(getByText(/ask the copilot in the bar/i)).toBeInTheDocument();
  });

  it('toggles and removes a goal', () => {
    const toggleGoal = vi.fn();
    const deleteGoal = vi.fn();
    const { getByLabelText } = renderWithBoth(<GoalsStrip />, { goalsList: goals, toggleGoal, deleteGoal });
    fireEvent.click(getByLabelText('Mark "Plan the Rainier trip" done'));
    expect(toggleGoal).toHaveBeenCalledWith('g1');
    fireEvent.click(getByLabelText('Remove Plan the Rainier trip'));
    expect(deleteGoal).toHaveBeenCalledWith('g1');
  });

  it('shows the empty state when there are no goals', () => {
    const { getByText } = renderWithBoth(<GoalsStrip />, { goalsList: [] });
    expect(getByText(/No goals yet/)).toBeInTheDocument();
  });

  it('titles the strip with the family-chosen copilot name', () => {
    const { getByText } = renderWithBoth(<GoalsStrip />, { goalsList: [], copilotName: 'Sparkles' });
    expect(getByText(/Goals Sparkles is tracking/)).toBeInTheDocument();
  });
});
