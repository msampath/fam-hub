// @vitest-environment jsdom
// BriefingCard (§7a on-demand morning agent): the planner's validated proposals render as a list and
// stage into Approvals CLIENT-side (confirm-tier pending entries under the visitor's own identity).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the shared API helper so the preview doesn't hit the network.
const apiFetch = vi.fn();
vi.mock('../supabase', () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import BriefingCard from '../components/shell/BriefingCard';
import { renderWithBoth } from './helpers/mockContexts';
import type { LedgerEntry } from '../types';

beforeEach(() => apiFetch.mockReset());

const briefingResponse = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    title: 'Today: 1 event',
    lines: ['Soccer at 4pm'],
    nudges: [],
    proposals: [
      { tool: 'add_shopping_item', summary: 'Rain 80% during soccer — umbrella?', payload: { text: 'Umbrella', store: 'Other' } },
      { tool: 'suggest_event', summary: 'Free Saturday + sun — park morning', payload: { booking: { title: 'Park morning', start: '2026-07-05' } }, goalId: 'goal-1' },
    ],
    ...over,
  }),
});

describe('BriefingCard (morning planner surface)', () => {
  it('sends goals/shopping/pending-ledger context with the preview request', async () => {
    const user = userEvent.setup();
    apiFetch.mockResolvedValueOnce(briefingResponse());
    renderWithBoth(<BriefingCard />, {
      goalsList: [{ id: 'goal-1', text: 'Trip', status: 'active' } as never],
      actionLedger: [
        { id: 'p1', tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending' } as LedgerEntry,
        { id: 'r1', tool: 'add_shopping_item', riskTier: 'confirm', status: 'approved' } as LedgerEntry,
      ],
    });
    await user.click(screen.getByText(/Preview today/));
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.goals).toHaveLength(1);
    expect(body.ledger.map((e: LedgerEntry) => e.id)).toEqual(['p1']); // pending only
  });

  it('renders planner proposals and stages them as confirm-tier pending entries on tap', async () => {
    const user = userEvent.setup();
    apiFetch.mockResolvedValueOnce(briefingResponse());
    const { appCtx } = renderWithBoth(<BriefingCard />);
    await user.click(screen.getByText(/Preview today/));
    expect(await screen.findByText(/umbrella\?/)).toBeInTheDocument();
    expect(screen.getByText(/park morning/)).toBeInTheDocument();

    await user.click(screen.getByText(/Stage 2 drafts in Approvals/));
    expect(appCtx.stageLedgerEntries).toHaveBeenCalledTimes(1);
    const staged = (appCtx.stageLedgerEntries as ReturnType<typeof vi.fn>).mock.calls[0][0] as LedgerEntry[];
    expect(staged).toHaveLength(2);
    for (const e of staged) {
      expect(e.riskTier).toBe('confirm');
      expect(e.status).toBe('pending');
      expect(e.id).toBeTruthy();
    }
    expect(staged[1].goalId).toBe('goal-1'); // goal linkage survives → approval advances the goal
    // Button flips to the staged state (no double-staging).
    expect(screen.getByText(/Staged — review in Approvals/)).toBeInTheDocument();
  });

  it('renders the plain briefing when the planner returns no proposals', async () => {
    const user = userEvent.setup();
    apiFetch.mockResolvedValueOnce(briefingResponse({ proposals: [] }));
    renderWithBoth(<BriefingCard />);
    await user.click(screen.getByText(/Preview today/));
    expect(await screen.findByText('Soccer at 4pm')).toBeInTheDocument();
    expect(screen.queryByText(/Stage .* in Approvals/)).not.toBeInTheDocument();
  });
});
