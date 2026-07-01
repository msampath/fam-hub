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
