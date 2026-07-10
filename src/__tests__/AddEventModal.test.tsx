// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import AddEventModal from '../components/AddEventModal';
import { AppContext } from '../AppContext';
import { makeAppCtx } from './helpers/mockContexts';

function renderModal(appOverrides: Parameters<typeof makeAppCtx>[0] = {}) {
  const setEvents = vi.fn();
  const ctx = makeAppCtx({ selectedDayToAdd: '2026-06-16', ...appOverrides });
  const utils = render(
    <AppContext.Provider value={ctx}>
      <AddEventModal setEvents={setEvents} />
    </AppContext.Provider>,
  );
  return { ...utils, ctx, setEvents };
}

describe('AddEventModal — event times', () => {
  it('renders optional start/end time inputs', () => {
    renderModal();
    expect(document.getElementById('modal-evt-start-time')).not.toBeNull();
    expect(document.getElementById('modal-evt-end-time')).not.toBeNull();
  });

  it('accepts start-time input', () => {
    renderModal();
    const input = document.getElementById('modal-evt-start-time') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '16:00' } });
    expect(input.value).toBe('16:00');
  });

  it('accepts end-time input', () => {
    renderModal();
    const input = document.getElementById('modal-evt-end-time') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '17:30' } });
    expect(input.value).toBe('17:30');
  });
});

describe('AddEventModal — RRULE-lite repeat picker (W8)', () => {
  it('renders One-off / Daily / Weekly pills and reports the choice', () => {
    renderModal({ selectedDayToAdd: '2026-07-06' });
    expect(document.getElementById('modal-evt-repeat-none')).not.toBeNull();
    fireEvent.click(document.getElementById('modal-evt-repeat-weekly')!);
    fireEvent.click(document.getElementById('modal-evt-repeat-daily')!);
  });

  it('explains the expansion when a repeat is selected', () => {
    const { getByText } = renderModal({ selectedDayToAdd: '2026-07-06' });
    fireEvent.click(document.getElementById('modal-evt-repeat-weekly')!);
    expect(getByText(/12 weekly entries/i)).toBeInTheDocument();
  });
});
