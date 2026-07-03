// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CopilotBar from '../components/shell/CopilotBar';
import { renderWithBoth } from './helpers/mockContexts';
import type { LedgerEntry } from '../types';

// Default tool is an AGENT-EXECUTABLE (update_event) so it lands in the Approvals bucket. Handoffs
// (reserve/prepare_handoff/add_to_cart) are USER-completed "Actions" — pass `tool: 'reserve'` for those.
const draft = (over: Partial<LedgerEntry> & { id: string }): LedgerEntry =>
  ({ tool: 'update_event', riskTier: 'confirm', status: 'pending', summary: 'Reschedule · Zoo Day', ...over } as LedgerEntry);

describe('CopilotBar', () => {
  it('has a single copilot input that sends on submit', async () => {
    const user = userEvent.setup();
    // copilotInput is now LOCAL state in the bar (§3.3): type into it and submit sends that exact text.
    const { calCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />);
    const input = screen.getByLabelText('Ask the copilot');
    await user.type(input, 'are we free saturday{enter}');
    expect(calCtx.handleSendCopilotMessage).toHaveBeenCalledWith('are we free saturday');
  });

  it('does NOT render a second input inside the expanded Ask column', async () => {
    const user = userEvent.setup();
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />);
    await user.click(screen.getByLabelText('Ask the copilot')); // focus → opens panel
    // exactly one textbox in the whole bar (the single top input)
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('shows the Approvals badge with the pending count and approves a draft from its modal', async () => {
    const user = userEvent.setup();
    const { appCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { actionLedger: [draft({ id: 'd1' })] });
    await user.click(screen.getByLabelText('Approvals (1)')); // badge opens the Approvals modal
    await user.click(screen.getByText('Approve'));
    expect(appCtx.approveLedgerEntry).toHaveBeenCalledWith('d1');
  });

  it('shows a quiet "History" tag (no pending count) when the queue has only resolved entries', () => {
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { actionLedger: [draft({ id: 'r1', status: 'approved' })] });
    // history-only → the history aria-label, NOT the "(1)" pending one that reads as "1 to handle"
    expect(screen.getByLabelText('Approvals history (1)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Approvals (1)')).not.toBeInTheDocument();
  });

  it('surfaces an "Open →" button for a handoff in the Actions modal and opens it in a new tab', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    // A handoff (reserve) is a USER-completed Action — it lives in the Actions modal, not Approvals.
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { actionLedger: [draft({ id: 'd1', tool: 'reserve', link: 'https://www.yelp.com/reserve/dtf-bellevue' })] });
    await user.click(screen.getByLabelText('Actions (1)'));
    await user.click(screen.getByRole('button', { name: /Open →/ }));
    expect(openSpy).toHaveBeenCalledWith('https://www.yelp.com/reserve/dtf-bellevue', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('does NOT render an Open button for a javascript: handoff link (no phishing into the queue)', async () => {
    const user = userEvent.setup();
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { actionLedger: [draft({ id: 'd2', tool: 'reserve', link: 'javascript:alert(1)' as any })] });
    await user.click(screen.getByLabelText('Actions (1)'));
    expect(screen.queryByRole('button', { name: /Open →/ })).not.toBeInTheDocument();
  });

  it('completes a handoff Action via "Done" (routes through approveLedgerEntry — keeps the goal loop)', async () => {
    const user = userEvent.setup();
    const { appCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { actionLedger: [draft({ id: 'h1', tool: 'prepare_handoff', summary: 'Lodging — details to enter: …' })] });
    await user.click(screen.getByLabelText('Actions (1)'));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(appCtx.approveLedgerEntry).toHaveBeenCalledWith('h1');
  });

  it('gates a stepup-tier draft behind the security PIN before approving', async () => {
    const user = userEvent.setup();
    const { appCtx } = renderWithBoth(
      <CopilotBar onOpenManage={vi.fn()} />,
      { actionLedger: [draft({ id: 's1', riskTier: 'stepup', summary: 'Unlock front door' })], hasStepUpPin: true },
    );
    await user.click(screen.getByLabelText('Approvals (1)')); // open the Approvals modal
    await user.click(screen.getByText('Approve'));
    // PIN required — must NOT approve directly
    expect(appCtx.approveLedgerEntry).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Security PIN'), '1234');
    await user.click(screen.getByText('Confirm'));
    expect(appCtx.verifyStepUpPin).toHaveBeenCalledWith('1234');
    // approves with the verified flag → the logic-layer A3 guard allows the stepup approve
    await waitFor(() => expect(appCtx.approveLedgerEntry).toHaveBeenCalledWith('s1', true));
  });

  it('does NOT close the Approvals modal on backdrop click while a PIN is being entered', async () => {
    const user = userEvent.setup();
    renderWithBoth(
      <CopilotBar onOpenManage={vi.fn()} />,
      { actionLedger: [draft({ id: 's1', riskTier: 'stepup', summary: 'Unlock front door' })], hasStepUpPin: true },
    );
    await user.click(screen.getByLabelText('Approvals (1)'));
    await user.click(screen.getByText('Approve')); // → step-up PIN form shows
    expect(screen.getByLabelText('Security PIN')).toBeInTheDocument();
    // A stray backdrop click must NOT discard the half-entered PIN (the dialog's parent is the backdrop).
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.getByLabelText('Security PIN')).toBeInTheDocument(); // still open
  });

  it('runs an email scan from the Actions modal', async () => {
    const user = userEvent.setup();
    const { appCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />);
    await user.click(screen.getByLabelText('Actions (0)')); // Actions badge → modal (always reachable for scans)
    await user.click(screen.getByText('Bills'));
    expect(appCtx.scanEmailForBills).toHaveBeenCalled();
  });

  it('renders a Retry button on a failed turn that re-sends the last user question', async () => {
    const user = userEvent.setup();
    const messages = [
      { role: 'user' as const, text: 'plan a trip' },
      { role: 'assistant' as const, text: '⚠️ The AI is overloaded right now — try again in a moment.', source: 'fallback' as const, error: true },
    ];
    const { calCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { copilotMessages: messages });
    await user.click(screen.getByLabelText('Ask the copilot')); // focus → opens the thread panel
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(calCtx.handleSendCopilotMessage).toHaveBeenCalledWith('plan a trip');
  });

  it('opens Manage from the gear button', async () => {
    const user = userEvent.setup();
    const onOpenManage = vi.fn();
    renderWithBoth(<CopilotBar onOpenManage={onOpenManage} />);
    await user.click(screen.getByLabelText('Manage'));
    expect(onOpenManage).toHaveBeenCalledTimes(1);
  });

  it('kid mode hides Actions/Approvals/Import/Manage and shows the hold-to-exit lock; the input stays', () => {
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {
      kidMode: true,
      actionLedger: [draft({ id: 'd1' })], // a pending approval exists — badge must STILL be hidden
    });
    expect(screen.queryByLabelText(/Actions/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Approvals/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Import')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manage')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Exit kid mode (press and hold)')).toBeInTheDocument();
    // The copilot input remains — destructive tools are confirm-tier, a kid can only STAGE drafts.
    expect(screen.getByLabelText('Ask the copilot')).toBeInTheDocument();
  });

  it('exiting kid mode requires the 3s hold (a quick tap does nothing)', async () => {
    vi.useFakeTimers();
    try {
      const { appCtx } = renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { kidMode: true });
      const lock = screen.getByLabelText('Exit kid mode (press and hold)');
      // Quick tap: down → up before 3s → no exit.
      fireEvent.pointerDown(lock);
      vi.advanceTimersByTime(1000);
      fireEvent.pointerUp(lock);
      vi.advanceTimersByTime(5000);
      expect(appCtx.setKidMode).not.toHaveBeenCalled();
      // Full 3s hold (no PIN set in the mock ctx) → exits.
      fireEvent.pointerDown(lock);
      await vi.advanceTimersByTimeAsync(3100);
      expect(appCtx.setKidMode).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
