// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GooglePushPicker from '../components/calendar/GooglePushPicker';
import { CalendarContext } from '../CalendarContext';
import { renderWithCalendar, makeCalendarCtx } from './helpers/mockContexts';
import type { CalendarEvent, GoogleCalendarListEntry } from '../types';

const ev: CalendarEvent = { id: 'e1', title: 'Soccer', start: '2026-06-18', category: 'Sports' };
const cals: GoogleCalendarListEntry[] = [
  { id: 'primary@x.com', summary: 'My Calendar', primary: true, accessRole: 'owner' },
  { id: 'work@x.com', summary: 'Work', accessRole: 'writer' },
  { id: 'holidays', summary: 'Holidays', accessRole: 'reader' }, // not writable → filtered out
];

describe('GooglePushPicker', () => {
  it('renders nothing when no event is targeted', () => {
    const { container } = renderWithCalendar(<GooglePushPicker />, { googlePushEvent: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only writable calendars (owner/writer), dropping read-only ones', () => {
    renderWithCalendar(<GooglePushPicker />, { googlePushEvent: ev, googleCalendarsList: cals });
    expect(document.getElementById('google-push-modal')).not.toBeNull();
    expect(screen.getByText('My Calendar')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.queryByText('Holidays')).toBeNull();
  });

  it('pre-checks the primary calendar and pushes the event to it', async () => {
    const user = userEvent.setup();
    const pushEventToGoogleCalendars = vi.fn(async () => 'Pushed to 1 calendar.');
    renderWithCalendar(<GooglePushPicker />, { googlePushEvent: ev, googleCalendarsList: cals, pushEventToGoogleCalendars });
    await user.click(document.getElementById('confirm-google-push-btn')!);
    expect(pushEventToGoogleCalendars).toHaveBeenCalledWith(ev, ['primary@x.com']);
    expect(await screen.findByText('Pushed to 1 calendar.')).toBeInTheDocument();
  });

  it('pushes to multiple calendars when more are checked', async () => {
    const user = userEvent.setup();
    const pushEventToGoogleCalendars = vi.fn(async () => 'Pushed to 2 calendars.');
    renderWithCalendar(<GooglePushPicker />, { googlePushEvent: ev, googleCalendarsList: cals, pushEventToGoogleCalendars });
    await user.click(screen.getByText('Work')); // check the writer calendar too
    await user.click(document.getElementById('confirm-google-push-btn')!);
    expect(pushEventToGoogleCalendars).toHaveBeenCalledWith(ev, ['primary@x.com', 'work@x.com']);
  });

  it('shows the empty state when there are no writable calendars', () => {
    renderWithCalendar(<GooglePushPicker />, {
      googlePushEvent: ev,
      googleCalendarsList: [{ id: 'r', summary: 'R', accessRole: 'reader' }] as GoogleCalendarListEntry[],
    });
    expect(screen.getByText(/No writable Google calendars/i)).toBeInTheDocument();
    expect(document.getElementById('confirm-google-push-btn')).toBeNull();
  });

  it('re-defaults selection to primary and clears the result banner when a different event is opened', async () => {
    // Exercises the derived-state-from-props reset (GooglePushPicker.tsx `if (evId !== trackedId)`).
    const user = userEvent.setup();
    const pushEventToGoogleCalendars = vi.fn(async () => 'Pushed to 2 calendars.');
    const { rerender } = render(
      <CalendarContext.Provider value={makeCalendarCtx({ googlePushEvent: ev, googleCalendarsList: cals, pushEventToGoogleCalendars })}>
        <GooglePushPicker />
      </CalendarContext.Provider>,
    );
    const boxes = () =>
      [...document.querySelectorAll<HTMLInputElement>('#google-push-calendar-list input[type=checkbox]')].map(b => b.checked);

    // Check a non-primary calendar and push so a result banner renders and selection diverges from default.
    await user.click(screen.getByText('Work'));
    await user.click(document.getElementById('confirm-google-push-btn')!);
    expect(await screen.findByText('Pushed to 2 calendars.')).toBeInTheDocument();
    expect(boxes()).toEqual([true, true]); // primary + Work both checked

    // Open a DIFFERENT event (new id) → the reset fires.
    const ev2: CalendarEvent = { id: 'e2', title: 'Recital', start: '2026-06-20', category: 'Arts' };
    rerender(
      <CalendarContext.Provider value={makeCalendarCtx({ googlePushEvent: ev2, googleCalendarsList: cals, pushEventToGoogleCalendars })}>
        <GooglePushPicker />
      </CalendarContext.Provider>,
    );
    expect(screen.getByText('Recital')).toBeInTheDocument();
    expect(document.getElementById('google-push-result')).toBeNull(); // prior banner cleared
    expect(boxes()).toEqual([true, false]); // selection re-defaulted to the primary calendar only
  });

  it('closes via Cancel', async () => {
    const user = userEvent.setup();
    const closeGooglePush = vi.fn();
    renderWithCalendar(<GooglePushPicker />, { googlePushEvent: ev, googleCalendarsList: cals, closeGooglePush });
    await user.click(screen.getByText('Cancel'));
    expect(closeGooglePush).toHaveBeenCalled();
  });
});
