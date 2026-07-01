// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GoogleSyncPanel from '../components/calendar/GoogleSyncPanel';
import { renderWithCalendar } from './helpers/mockContexts';

// The panel assumes a signed-in Google user (uses googleUser! for the account header).
const googleUser = { email: 'dad@example.com', user_metadata: { full_name: 'Dad' } } as any;

describe('GoogleSyncPanel — Hidden events restore', () => {
  it('hides the Hidden-events card when nothing is hidden', () => {
    renderWithCalendar(<GoogleSyncPanel />, { googleUser, hiddenEvents: [] });
    expect(document.getElementById('hidden-events-card')).toBeNull();
  });

  it('shows the count but keeps the list collapsed by default', () => {
    renderWithCalendar(<GoogleSyncPanel />, {
      googleUser,
      hiddenEvents: [
        { id: 'gcal-cal1-a', title: 'Daily standup', start: '2026-06-15' },
        { id: 'gcal-cal1-b', title: 'Recycling night', start: '2026-06-16' },
      ],
    });
    // The count toggle is always visible…
    expect(screen.getByText(/Hidden from sync \(2\)/)).toBeInTheDocument();
    // …but the events + restore-all are hidden until expanded.
    expect(screen.queryByText('Daily standup')).toBeNull();
    expect(document.getElementById('hidden-events-restore-all')).toBeNull();
  });

  it('reveals the events with their titles once expanded', async () => {
    const user = userEvent.setup();
    renderWithCalendar(<GoogleSyncPanel />, {
      googleUser,
      hiddenEvents: [
        { id: 'gcal-cal1-a', title: 'Daily standup', start: '2026-06-15' },
        { id: 'gcal-cal1-b', title: 'Recycling night', start: '2026-06-16' },
      ],
    });
    await user.click(document.getElementById('hidden-events-toggle')!);
    expect(screen.getByText('Daily standup')).toBeInTheDocument();
    expect(screen.getByText('Recycling night')).toBeInTheDocument();
  });

  it('"Restore all" calls restoreAllHiddenEvents (after expanding)', async () => {
    const user = userEvent.setup();
    const restoreAllHiddenEvents = vi.fn();
    renderWithCalendar(<GoogleSyncPanel />, {
      googleUser,
      restoreAllHiddenEvents,
      hiddenEvents: [{ id: 'gcal-cal1-a', title: 'Daily standup', start: '2026-06-15' }],
    });
    await user.click(document.getElementById('hidden-events-toggle')!);
    await user.click(document.getElementById('hidden-events-restore-all')!);
    expect(restoreAllHiddenEvents).toHaveBeenCalledTimes(1);
  });

  it('an individual Restore calls restoreHiddenEvent with that event id (after expanding)', async () => {
    const user = userEvent.setup();
    const restoreHiddenEvent = vi.fn();
    renderWithCalendar(<GoogleSyncPanel />, {
      googleUser,
      restoreHiddenEvent,
      hiddenEvents: [{ id: 'gcal-cal1-a', title: 'Daily standup', start: '2026-06-15' }],
    });
    await user.click(document.getElementById('hidden-events-toggle')!);
    await user.click(screen.getByTitle('Restore this event'));
    expect(restoreHiddenEvent).toHaveBeenCalledWith('gcal-cal1-a');
  });
});
