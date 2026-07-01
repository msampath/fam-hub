// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Manage from '../components/shell/Manage';
import { renderWithBoth } from './helpers/mockContexts';
import type { AccountSettings } from '../components/shell/Manage';

// Minimal account prop — the add-member form under test doesn't touch any of these.
const account: AccountSettings = {
  user: null, onSignOut: vi.fn(), idleTimeoutMs: 0, onChangeIdleTimeout: vi.fn(),
  signOutMs: 0, onChangeSignOut: vi.fn(), remindersEnabled: false, onToggleReminders: vi.fn(),
  reminderTime: 0, onChangeReminderTime: vi.fn(), reminderLead: 0, onChangeReminderLead: vi.fn(),
  onRefresh: vi.fn(), isRefreshing: false, autoScanEnabled: false, onToggleAutoScan: vi.fn(),
};

describe('Manage — add-member captures dietary/interests at creation (A4)', () => {
  it('renders dietary + interests inputs in the add-member form and wires them to their setters', () => {
    const setNewMemberDietary = vi.fn();
    const setNewMemberInterests = vi.fn();
    const { getByPlaceholderText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { setNewMemberDietary, setNewMemberInterests },
      // Manage embeds GoogleSyncPanel, which derefs googleUser — provide a minimal stub.
      { googleUser: { user_metadata: {} } as never },
    );
    fireEvent.change(getByPlaceholderText(/Dietary \(optional/), { target: { value: 'vegetarian' } });
    fireEvent.change(getByPlaceholderText(/Interests \(optional/), { target: { value: 'soccer' } });
    expect(setNewMemberDietary).toHaveBeenCalledWith('vegetarian');
    expect(setNewMemberInterests).toHaveBeenCalledWith('soccer');
  });
});

describe('Manage — modal a11y (Phase 3)', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderWithBoth(<Manage account={account} onClose={onClose} />, {}, { googleUser: { user_metadata: {} } as never });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Manage — PIN-change gate (P1 #2: changing an existing PIN requires the current one)', () => {
  const stub = { googleUser: { user_metadata: {} } as never };

  it('first-time set goes straight through (no current-PIN prompt, verify not called)', async () => {
    const setStepUpPin = vi.fn(async () => ({ ok: true }));
    const verifyStepUpPin = vi.fn(async () => true);
    const { getByLabelText, getByText, queryByLabelText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { hasStepUpPin: false, setStepUpPin, verifyStepUpPin },
      stub,
    );
    expect(queryByLabelText('Current PIN')).toBeNull(); // no current-PIN field on first set
    fireEvent.change(getByLabelText('PIN'), { target: { value: '1234' } });
    fireEvent.click(getByText('Set PIN'));
    await waitFor(() => expect(setStepUpPin).toHaveBeenCalledWith('1234'));
    expect(verifyStepUpPin).not.toHaveBeenCalled();
  });

  it('blocks a change when no current PIN is entered', async () => {
    const setStepUpPin = vi.fn(async () => ({ ok: true }));
    const { getByLabelText, getByText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { hasStepUpPin: true, setStepUpPin },
      stub,
    );
    fireEvent.change(getByLabelText('New PIN'), { target: { value: '5678' } });
    fireEvent.click(getByText('Change PIN'));
    await waitFor(() => expect(getByText(/Enter your current PIN/i)).toBeInTheDocument());
    expect(setStepUpPin).not.toHaveBeenCalled();
  });

  it('blocks a change when the current PIN is wrong (verify → false)', async () => {
    const setStepUpPin = vi.fn(async () => ({ ok: true }));
    const verifyStepUpPin = vi.fn(async () => false);
    const { getByLabelText, getByText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { hasStepUpPin: true, setStepUpPin, verifyStepUpPin },
      stub,
    );
    fireEvent.change(getByLabelText('Current PIN'), { target: { value: '0000' } });
    fireEvent.change(getByLabelText('New PIN'), { target: { value: '5678' } });
    fireEvent.click(getByText('Change PIN'));
    await waitFor(() => expect(verifyStepUpPin).toHaveBeenCalledWith('0000'));
    expect(setStepUpPin).not.toHaveBeenCalled();
    expect(getByText(/Current PIN is incorrect/i)).toBeInTheDocument();
  });

  it('allows a change when the current PIN verifies', async () => {
    const setStepUpPin = vi.fn(async () => ({ ok: true }));
    const verifyStepUpPin = vi.fn(async () => true);
    const { getByLabelText, getByText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { hasStepUpPin: true, setStepUpPin, verifyStepUpPin },
      stub,
    );
    fireEvent.change(getByLabelText('Current PIN'), { target: { value: '1234' } });
    fireEvent.change(getByLabelText('New PIN'), { target: { value: '5678' } });
    fireEvent.click(getByText('Change PIN'));
    await waitFor(() => expect(setStepUpPin).toHaveBeenCalledWith('5678'));
    expect(verifyStepUpPin).toHaveBeenCalledWith('1234');
  });
});

describe('Manage — PIN field keeps focus while typing (W2 remount-bug regression)', () => {
  it('does not lose focus / reset between keystrokes in the PIN input', async () => {
    const user = userEvent.setup();
    const { getByPlaceholderText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      {},
      { googleUser: { user_metadata: {} } as never },
    );
    const pin = getByPlaceholderText('4–8 digit PIN') as HTMLInputElement;
    pin.focus();
    // Before the fix, Section/Select were declared inside Manage → every keystroke remounted the subtree,
    // blurring this input and dropping characters. Typing several digits must accumulate AND keep focus.
    await user.type(pin, '1234');
    expect(pin.value).toBe('1234');
    expect(document.activeElement).toBe(pin);
  });
});
