// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the shared API helper so the URL→Docs path doesn't hit the network.
const apiFetch = vi.fn();
vi.mock('../supabase', () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import ImportDrawer from '../components/shell/ImportDrawer';
import { renderWithBoth } from './helpers/mockContexts';

beforeEach(() => apiFetch.mockReset());

describe('ImportDrawer (import folded into the copilot surface)', () => {
  it('offers URL / Paste text / Files modes', () => {
    renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { syncMode: 'url' });
    expect(screen.getByText('Web URL')).toBeInTheDocument();
    expect(screen.getByText('Paste text')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('switching mode calls setSyncMode', async () => {
    const user = userEvent.setup();
    const { calCtx } = renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { syncMode: 'url' });
    await user.click(screen.getByText('Paste text'));
    expect(calCtx.setSyncMode).toHaveBeenCalledWith('text');
  });

  it('Files mode shows a drop zone for any document type', () => {
    renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { syncMode: 'pdf' });
    expect(screen.getByText(/Drop a file/i)).toBeInTheDocument();
  });
});

describe('ImportDrawer — universal uploader → Docs vs Calendar (P5)', () => {
  it('saves pasted text as a Doc in the chosen folder (default destination is Docs)', () => {
    const setLibraryDocs = vi.fn();
    renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      { authorStamp: () => ({ createdByEmail: 'mom@home.test', createdAt: '2026-06-24' }) },
      { syncMode: 'text', pastedText: 'Soccer practice moved to 5pm', setLibraryDocs },
    );
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Sports' } });
    fireEvent.click(screen.getByText('Save to Docs'));
    expect(setLibraryDocs).toHaveBeenCalledTimes(1);
    const updater = setLibraryDocs.mock.calls[0][0] as (prev: any[]) => any[];
    const [doc] = updater([]);
    expect(doc.folder).toBe('Sports');
    expect(doc.text).toBe('Soccer practice moved to 5pm');
    expect(doc.createdByEmail).toBe('mom@home.test'); // author stamp applied
  });

  it('routes pasted text to the calendar pipeline when "this is a calendar" is ticked', () => {
    const handleTextSubmit = vi.fn();
    const setLibraryDocs = vi.fn();
    renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'text', pastedText: 'School holiday Oct 14', handleTextSubmit, setLibraryDocs },
    );
    fireEvent.click(screen.getByLabelText('This is a calendar'));
    fireEvent.click(screen.getByText('Extract events'));
    expect(handleTextSubmit).toHaveBeenCalledTimes(1);
    expect(setLibraryDocs).not.toHaveBeenCalled();
  });

  it('routes a URL to the calendar pipeline when ticked', () => {
    const handleAddSource = vi.fn();
    renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'url', newUrl: 'https://school.example/calendar', handleAddSource },
    );
    fireEvent.click(screen.getByLabelText('This is a calendar'));
    fireEvent.click(screen.getByText('Import from URL'));
    expect(handleAddSource).toHaveBeenCalledTimes(1);
  });

  it('extracts a .docx via /api/extract-docx-text and saves the returned text as a Doc', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ text: 'Lease body text.' }) });
    const setLibraryDocs = vi.fn();
    const { container } = renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'pdf', setLibraryDocs },
    );
    const input = container.querySelector('#shell-file-selector') as HTMLInputElement;
    const file = new File(['ignored'], 'Lease.docx', { type: '' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/extract-docx-text', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(setLibraryDocs).toHaveBeenCalled());
    const [doc] = (setLibraryDocs.mock.calls[0][0] as (p: any[]) => any[])([]);
    expect(doc.name).toBe('Lease');
    expect(doc.text).toBe('Lease body text.');
  });

  it('reads a .txt file locally (no apiFetch) and saves it as a Doc', async () => {
    const setLibraryDocs = vi.fn();
    const { container } = renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'pdf', setLibraryDocs },
    );
    const input = container.querySelector('#shell-file-selector') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['plain notes'], 'memo.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(setLibraryDocs).toHaveBeenCalled());
    expect(apiFetch).not.toHaveBeenCalled();
    const [doc] = (setLibraryDocs.mock.calls[0][0] as (p: any[]) => any[])([]);
    expect(doc.text).toBe('plain notes');
  });

  it('refuses a non-PDF file when "this is a calendar" is ticked (no opaque PDF call)', async () => {
    const handlePdfUpload = vi.fn();
    const { container, getByLabelText, findByText } = renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'pdf', handlePdfUpload },
    );
    fireEvent.click(getByLabelText('This is a calendar'));
    const input = container.querySelector('#shell-file-selector') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'budget.xlsx', { type: '' })] } });
    expect(await findByText(/calendar reader only handles PDFs/i)).toBeInTheDocument();
    expect(handlePdfUpload).not.toHaveBeenCalled();
  });

  it('saves a web page as a Doc via /api/extract-url-text when not a calendar', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ text: 'Readable page text here.' }) });
    const setLibraryDocs = vi.fn();
    renderWithBoth(
      <ImportDrawer onClose={vi.fn()} />,
      {},
      { syncMode: 'url', newUrl: 'https://example.com/info', newSourceName: 'Info page', setLibraryDocs },
    );
    fireEvent.click(screen.getByText('Save page to Docs'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/extract-url-text', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(setLibraryDocs).toHaveBeenCalled());
    const updater = setLibraryDocs.mock.calls[0][0] as (prev: any[]) => any[];
    const [doc] = updater([]);
    expect(doc.name).toBe('Info page');
    expect(doc.text).toMatch(/Readable page text here/);
    expect(doc.text).toMatch(/example\.com\/info/); // keeps the source URL
  });
});

describe('ImportDrawer — Sync feeds (W8 feed re-sync)', () => {
  const sources = [
    { id: 'src-1', name: 'School ICS', url: 'https://school.example/cal.ics', category: 'School' as const, lastSync: 'Synced 2026-07-01', status: 'active' as const, eventCount: 7 },
    { id: 'src-2', name: 'Library page', url: 'https://library.example/events', category: 'Other' as const, lastSync: 'Last sync failed — kept the previous import', status: 'error' as const, eventCount: 3 },
  ];

  it('shows the Sync feeds button next to the saved sources and wires it to handleSyncSources', () => {
    const handleSyncSources = vi.fn();
    const { getByText } = renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { sources, handleSyncSources });
    fireEvent.click(getByText('Sync feeds'));
    expect(handleSyncSources).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows progress while a sync is running', () => {
    const { getByText } = renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { sources, isSyncingSources: true });
    expect((getByText('Syncing…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a failed source honestly instead of the import count', () => {
    const { getByText } = renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { sources });
    expect(getByText('✨ 7 imported')).toBeInTheDocument();               // healthy source
    expect(getByText(/Last sync failed — kept the previous import/)).toBeInTheDocument(); // failed one
  });

  it('renders no Sync feeds button when there are no saved sources', () => {
    const { queryByText } = renderWithBoth(<ImportDrawer onClose={vi.fn()} />, {}, { sources: [] });
    expect(queryByText('Sync feeds')).toBeNull();
  });
});
