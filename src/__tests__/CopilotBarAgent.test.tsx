// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// AGENT_ON is computed at module load from isAgentConfigured(); mock it true BEFORE importing the bar.
vi.mock('../utils/agentClient', () => ({
  isAgentConfigured: () => true,
  askConciergeAgent: vi.fn(async () => ({ reply: 'hi', sessionId: 's1', actions: [] })),
}));

import CopilotBar from '../components/shell/CopilotBar';
import { renderWithBoth } from './helpers/mockContexts';
import type { CopilotMessage } from '../types';

describe('CopilotBar — escalate to cloud agent (unified bar)', () => {
  it('no longer shows a top-bar cloud escalate button (the bar routes to the cloud agent by default now)', () => {
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />);
    expect(screen.queryByLabelText('Send to the cloud agent')).not.toBeInTheDocument();
  });

  it('shows the per-turn "Escalate" greyed-out (disabled) for now — kept for the local-model revival', async () => {
    const user = userEvent.setup();
    const handleSendCopilotMessage = vi.fn();
    const messages: CopilotMessage[] = [
      { role: 'user', text: 'plan a trip' },
      { role: 'assistant', text: 'Here are some ideas.', source: 'local' },
    ];
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { handleSendCopilotMessage, copilotMessages: messages });
    await user.click(screen.getByLabelText('Ask the copilot')); // open the thread
    const btn = screen.getByRole('button', { name: /Escalate/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.click(btn); // disabled → no-op
    expect(handleSendCopilotMessage).not.toHaveBeenCalled();
  });

  it('renders markdown links in an assistant reply as clickable new-tab anchors (#3)', async () => {
    const user = userEvent.setup();
    const messages: CopilotMessage[] = [{ role: 'assistant', text: 'See [the park](https://nps.gov/mora)', source: 'local' }];
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { copilotMessages: messages });
    await user.click(screen.getByLabelText('Ask the copilot')); // open the thread
    const link = screen.getByRole('link', { name: 'the park' });
    expect(link).toHaveAttribute('href', 'https://nps.gov/mora');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('tags a concierge turn with a SUBTLE cloud+model engine tag (one concierge — never a separate "cloud agent")', async () => {
    const user = userEvent.setup();
    const messages: CopilotMessage[] = [{ role: 'assistant', text: 'Done.', source: 'agent', model: 'gemini-2.5-flash' }];
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { copilotMessages: messages });
    // The thread (and its source tag) renders only when the panel is open — focus the input to open it.
    await user.click(screen.getByLabelText('Ask the copilot'));
    expect(screen.getByText(/cloud · gemini-2\.5-flash/i)).toBeInTheDocument(); // engine+model, muted
    expect(screen.queryByText(/cloud agent/i)).not.toBeInTheDocument();          // not a second assistant
  });

  it('labels the limited stand-in "limited mode" (same brand — never "offline" or a separate "cloud agent")', async () => {
    const user = userEvent.setup();
    const messages: CopilotMessage[] = [{ role: 'assistant', text: 'Quick answer.', source: 'fallback' }];
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { copilotMessages: messages });
    await user.click(screen.getByLabelText('Ask the copilot'));
    expect(screen.getByText(/limited mode/i)).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cloud agent/i)).not.toBeInTheDocument();
  });

  it('Clear hides the on-screen thread (view-only declutter)', async () => {
    const user = userEvent.setup();
    const messages: CopilotMessage[] = [{ role: 'assistant', text: 'A message in the thread' }];
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {}, { copilotMessages: messages });
    await user.click(screen.getByLabelText('Ask the copilot')); // open the panel
    expect(screen.getByText('A message in the thread')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('A message in the thread')).not.toBeInTheDocument(); // hidden, state untouched
  });
});

describe('CopilotBar — one-window chat: Actions / Approvals badges + modals (P3)', () => {
  it('opens the Actions modal (email finds) from the Actions badge', async () => {
    const user = userEvent.setup();
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, { autoEmailSuggestions: [{ start: '2026-07-01', title: 'Bill due: PSE' }] as any });
    await user.click(screen.getByLabelText('Actions (1)'));
    expect(screen.getByText(/New from email/i)).toBeInTheDocument();
  });

  it('opens the Approvals modal (pending drafts) from the Approvals badge', async () => {
    const user = userEvent.setup();
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {
      actionLedger: [{ id: 'l1', tool: 'update_event', riskTier: 'confirm', status: 'pending', summary: "Reschedule Zoo Day" }] as any,
    });
    await user.click(screen.getByLabelText('Approvals (1)'));
    expect(screen.getByText("Reschedule Zoo Day")).toBeInTheDocument();
  });

  it('lets the user Modify a staged draft with plain-language feedback (#4 HITL)', async () => {
    const user = userEvent.setup();
    const reviseLedgerEntry = vi.fn(async () => ({ ok: true }));
    renderWithBoth(<CopilotBar onOpenManage={vi.fn()} />, {
      actionLedger: [{ id: 'l1', tool: 'update_event', riskTier: 'confirm', status: 'pending', summary: "Reschedule Zoo Day" }] as any,
      reviseLedgerEntry,
    });
    await user.click(screen.getByLabelText('Approvals (1)'));
    await user.click(screen.getByRole('button', { name: 'Modify' }));
    await user.type(screen.getByLabelText('How to change this draft'), 'somewhere cheaper');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(reviseLedgerEntry).toHaveBeenCalledWith('l1', 'somewhere cheaper');
  });
});
