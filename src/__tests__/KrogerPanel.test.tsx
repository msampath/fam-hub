// @vitest-environment jsdom
// The two-level connections panel — pinned against the owner-reported Lists bug: the Costco list's
// dropdown offered FRED MEYER STORE LOCATIONS. List rows may only ever offer CONNECTIONS; the store
// location lives on the connection card ("Shop at"), picked once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KrogerPanel from '../components/shell/KrogerPanel';
import { renderWithApp } from './helpers/mockContexts';

// The panel talks to krogerClient for connection state + nearby locations — mock it wholesale.
const stores = [
  { locationId: '70100658', chain: 'FRED', name: 'Fred Meyer - Issaquah', address: '123 Front St, Issaquah' },
  { locationId: '70100777', chain: 'FRED', name: 'Fred Meyer - Bellevue', address: '456 Main St, Bellevue' },
];
vi.mock('../utils/krogerClient', () => ({
  isKrogerConnected: () => true,
  connectKroger: vi.fn(async () => {}),
  disconnectKroger: vi.fn(),
  fetchKrogerStores: vi.fn(async () => stores),
}));

const LOC = { locationId: '70100658', name: 'Fred Meyer - Issaquah' };
const base = {
  storeList: ['Costco', 'Indian Store', 'Grocery Store', 'Other'],
  homeLat: 47.6, homeLng: -122.0,
  krogerConnection: LOC,
  storeBindings: { 'Grocery Store': LOC },
};

beforeEach(() => vi.clearAllMocks());

describe('KrogerPanel (two-level connections)', () => {
  it("a LIST row's dropdown offers connections only — NEVER store locations (the Costco bug)", async () => {
    renderWithApp(<KrogerPanel />, base);
    const costcoRow = await screen.findByLabelText('Connection for the Costco list');
    const options = within(costcoRow).getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual(['Not linked', 'Kroger (Fred Meyer - Issaquah)']);
    expect(options.join()).not.toMatch(/Bellevue/); // no raw store locations in a list row, ever
  });

  it('the CONNECTION card owns the step-2 location picker, labels are chain-code-free', async () => {
    renderWithApp(<KrogerPanel />, base);
    const shopAt = await screen.findByLabelText('Kroger store location for this connection');
    const options = within(shopAt).getAllByRole('option').map(o => o.textContent);
    expect(options).toContain('Fred Meyer - Issaquah');
    expect(options).toContain('Fred Meyer - Bellevue');
    expect(options.join()).not.toMatch(/FRED Fred/); // the chain-code prefix stays dead
  });

  it('linking a list calls setListLink; changing the location calls setKrogerConnection', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<KrogerPanel />, base);
    await user.selectOptions(await screen.findByLabelText('Connection for the Costco list'), 'kroger');
    expect(ctx.setListLink).toHaveBeenCalledWith('Costco', 'kroger');
    await user.selectOptions(screen.getByLabelText('Kroger store location for this connection'), '70100777');
    expect(ctx.setKrogerConnection).toHaveBeenCalledWith({ locationId: '70100777', name: 'Fred Meyer - Bellevue' });
  });

  it('list linking is disabled until the connection has a store', async () => {
    renderWithApp(<KrogerPanel />, { ...base, krogerConnection: null, storeBindings: {} });
    const row = await screen.findByLabelText('Connection for the Costco list');
    expect(row).toBeDisabled();
    expect(screen.getByText(/Pick the connection's store above/)).toBeInTheDocument();
  });
});
