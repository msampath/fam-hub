// @vitest-environment jsdom
// History-log privacy (security bundle 3c): the copilot Q+A log + quick-add log are household-synced
// audit/RL data, so Manage → Account must (a) disclose that plainly and (b) offer a REAL two-step
// delete wired to AppContext.clearCopilotHistory — not a view-only reset.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import Manage from '../components/shell/Manage';
import { renderWithBoth } from './helpers/mockContexts';
import type { AccountSettings } from '../components/shell/Manage';

const account: AccountSettings = {
  user: null, onSignOut: vi.fn(), idleTimeoutMs: 0, onChangeIdleTimeout: vi.fn(),
  signOutMs: 0, onChangeSignOut: vi.fn(), remindersEnabled: false, onToggleReminders: vi.fn(),
  reminderTime: 0, onChangeReminderTime: vi.fn(), reminderLead: 0, onChangeReminderLead: vi.fn(),
  onRefresh: vi.fn(), isRefreshing: false, autoScanEnabled: false, onToggleAutoScan: vi.fn(),
  photosScreensaver: false, onChangePhotosScreensaver: vi.fn(),
};
const stub = { googleUser: { user_metadata: {} } as never };

describe('Manage — clear copilot history (privacy)', () => {
  it('discloses the history log and clears it only after the explicit confirm step', () => {
    const clearCopilotHistory = vi.fn();
    const { getByText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { clearCopilotHistory },
      stub,
    );

    // Disclosure note is always visible in the Account section.
    expect(getByText(/keeps a rolling history of questions and quick-adds/i)).toBeInTheDocument();

    // Step 1 arms the confirm — nothing deleted yet.
    fireEvent.click(getByText('Clear copilot history'));
    expect(clearCopilotHistory).not.toHaveBeenCalled();
    expect(getByText(/Delete the saved copilot \+ quick-add history/i)).toBeInTheDocument();

    // Step 2 performs the wipe and reports it.
    fireEvent.click(getByText('Yes, clear it'));
    expect(clearCopilotHistory).toHaveBeenCalledTimes(1);
    expect(getByText('History cleared.')).toBeInTheDocument();
  });

  it('Cancel disarms the confirm without deleting anything', () => {
    const clearCopilotHistory = vi.fn();
    const { getByText, queryByText } = renderWithBoth(
      <Manage account={account} onClose={vi.fn()} />,
      { clearCopilotHistory },
      stub,
    );
    fireEvent.click(getByText('Clear copilot history'));
    fireEvent.click(getByText('Cancel'));
    expect(clearCopilotHistory).not.toHaveBeenCalled();
    expect(queryByText(/Delete the saved copilot/i)).toBeNull();
    expect(getByText('Clear copilot history')).toBeInTheDocument(); // back to the armed=false state
  });
});
