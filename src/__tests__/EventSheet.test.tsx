// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventSheet from '../components/shell/EventSheet';
import { renderWithCalendar } from './helpers/mockContexts';
import type { CalendarEvent, FamilyMember } from '../types';

const ev: CalendarEvent = {
  id: 'e1', title: 'Swim Practice', start: '2026-06-01', category: 'Sports',
  members: ['Leo'], ageGroup: 'All ages',
};
const members: FamilyMember[] = [{ name: 'Leo', role: 'Kid', color: 'sky' }];

describe('EventSheet', () => {
  it('renders nothing when no event is selected', () => {
    const { container } = renderWithCalendar(<EventSheet />, { selectedEventDetail: null });
    expect(container.firstChild).toBeNull();
  });

  it('shows the event and deletes + closes', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithCalendar(<EventSheet />, { selectedEventDetail: ev, familyMembers: members });
    expect(screen.getByText('Swim Practice')).toBeInTheDocument();
    await user.click(screen.getByText('Delete'));
    expect(ctx.handleDeleteEvent).toHaveBeenCalledWith('e1');
    expect(ctx.setSelectedEventDetail).toHaveBeenCalledWith(null);
  });

  it('sets free/busy via the override buttons', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithCalendar(<EventSheet />, { selectedEventDetail: ev, familyMembers: members });
    await user.click(screen.getByText('Busy'));
    expect(ctx.handleSetEventFreeBusy).toHaveBeenCalledWith('e1', 'busy');
  });

  it('is a labelled dialog and closes on Escape (modal a11y)', () => {
    const { ctx } = renderWithCalendar(<EventSheet />, { selectedEventDetail: ev, familyMembers: members });
    expect(screen.getByRole('dialog', { name: 'Event details' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(ctx.setSelectedEventDetail).toHaveBeenCalledWith(null);
  });
});
