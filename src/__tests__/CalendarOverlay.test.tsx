// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import CalendarOverlay from '../components/shell/CalendarOverlay';
import { renderWithCalendar } from './helpers/mockContexts';

describe('CalendarOverlay — modal a11y (Phase 3)', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderWithCalendar(<CalendarOverlay onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click, but NOT when the dialog body is clicked', () => {
    const onClose = vi.fn();
    renderWithCalendar(<CalendarOverlay onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog); // inside the dialog → stopPropagation, stays open
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement!); // the backdrop → closes
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
