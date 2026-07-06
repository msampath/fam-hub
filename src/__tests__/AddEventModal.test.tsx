// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import AddEventModal from '../components/AddEventModal';
import { renderWithApp } from './helpers/mockContexts';

describe('AddEventModal — event times', () => {
  it('renders optional start/end time inputs', () => {
    renderWithApp(<AddEventModal />, { selectedDayToAdd: '2026-06-16' });
    expect(document.getElementById('modal-evt-start-time')).not.toBeNull();
    expect(document.getElementById('modal-evt-end-time')).not.toBeNull();
  });

  it('reports start-time changes', () => {
    const setCustomEventStartTime = vi.fn();
    renderWithApp(<AddEventModal />, { selectedDayToAdd: '2026-06-16', setCustomEventStartTime });
    fireEvent.change(document.getElementById('modal-evt-start-time')!, { target: { value: '16:00' } });
    expect(setCustomEventStartTime).toHaveBeenCalledWith('16:00');
  });

  it('reflects the current end-time value', () => {
    renderWithApp(<AddEventModal />, { selectedDayToAdd: '2026-06-16', customEventEndTime: '17:30' });
    expect((document.getElementById('modal-evt-end-time') as HTMLInputElement).value).toBe('17:30');
  });
});

describe('AddEventModal — RRULE-lite repeat picker (W8)', () => {
  it('renders One-off / Daily / Weekly pills and reports the choice', () => {
    const setCustomEventRepeat = vi.fn();
    renderWithApp(<AddEventModal />, { selectedDayToAdd: '2026-07-06', setCustomEventRepeat });
    expect(document.getElementById('modal-evt-repeat-none')).not.toBeNull();
    fireEvent.click(document.getElementById('modal-evt-repeat-weekly')!);
    expect(setCustomEventRepeat).toHaveBeenCalledWith('weekly');
    fireEvent.click(document.getElementById('modal-evt-repeat-daily')!);
    expect(setCustomEventRepeat).toHaveBeenCalledWith('daily');
  });

  it('explains the expansion when a repeat is selected', () => {
    const { getByText } = renderWithApp(<AddEventModal />, { selectedDayToAdd: '2026-07-06', customEventRepeat: 'weekly' });
    expect(getByText(/12 weekly entries/i)).toBeInTheDocument();
  });
});
