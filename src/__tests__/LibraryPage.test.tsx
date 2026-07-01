// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import LibraryPage from '../components/shell/pages/LibraryPage';
import { renderWithBoth } from './helpers/mockContexts';
import type { LibraryDoc } from '../types';

const docs: LibraryDoc[] = [
  { id: 'doc-1', folder: 'School', name: 'Early-release', text: 'Wednesdays at 1:30pm' },
  { id: 'doc-2', folder: 'Home', name: 'Lease', text: 'Rent due on the 1st' },
];

describe('LibraryPage (A5 — real CRUD + search)', () => {
  it('renders persisted docs grouped by folder (no hardcoded placeholders)', () => {
    const { getByText, queryByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: docs });
    expect(getByText('School')).toBeInTheDocument();
    expect(getByText('Early-release')).toBeInTheDocument();
    expect(getByText('Lease')).toBeInTheDocument();
    // The old decorative placeholder names must be gone.
    expect(queryByText('Band calendar.pdf')).toBeNull();
  });

  it('shows the empty state when there are no docs', () => {
    const { getByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: [] });
    expect(getByText(/No documents yet/)).toBeInTheDocument();
  });

  it('adds a document via the form', () => {
    const setLibraryDocs = vi.fn();
    const { getByText, getByRole, getByLabelText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: [], setLibraryDocs });
    fireEvent.click(getByRole('button', { name: '＋ Add document' }));
    fireEvent.change(getByLabelText('Folder'), { target: { value: 'School' } });
    fireEvent.change(getByLabelText('Document name'), { target: { value: 'Band' } });
    fireEvent.change(getByLabelText('Document text'), { target: { value: 'Concert May 3' } });
    fireEvent.click(getByText('Save'));
    expect(setLibraryDocs).toHaveBeenCalled();
  });

  it('filters docs by the search box', () => {
    const { getByLabelText, queryByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: docs });
    fireEvent.change(getByLabelText('Search documents'), { target: { value: 'rent' } });
    expect(queryByText('Lease')).toBeInTheDocument();
    expect(queryByText('Early-release')).toBeNull();
  });

  it('deletes a document from the ⋯ actions menu (capstone #7)', () => {
    const setLibraryDocs = vi.fn();
    const { getByLabelText, getByRole } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: docs, setLibraryDocs });
    fireEvent.click(getByLabelText('Actions for Lease'));
    fireEvent.click(getByRole('menuitem', { name: /Delete/ }));
    expect(setLibraryDocs).toHaveBeenCalled();
  });

  it('renames a document from the ⋯ actions menu (capstone #7)', () => {
    const setLibraryDocs = vi.fn();
    const { getByLabelText, getByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: docs, setLibraryDocs });
    fireEvent.click(getByLabelText('Actions for Lease'));
    fireEvent.click(getByText('✏️ Rename'));
    fireEvent.change(getByLabelText('New name for Lease'), { target: { value: 'Lease 2026' } });
    fireEvent.click(getByText('Save'));
    expect(setLibraryDocs).toHaveBeenCalled();
  });

  it('moves a document to another folder from the ⋯ actions menu (capstone #7)', () => {
    const setLibraryDocs = vi.fn();
    const { getByLabelText, getByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: docs, setLibraryDocs });
    fireEvent.click(getByLabelText('Actions for Lease'));
    fireEvent.click(getByText('📁 Move'));
    fireEvent.change(getByLabelText('Move Lease to folder'), { target: { value: 'Archive' } });
    fireEvent.click(getByText('Save'));
    expect(setLibraryDocs).toHaveBeenCalled();
  });

  it('hides auto-ingested Newsletters from the visible Library, even via search (capstone #6 — kept for RAG)', () => {
    const withNews: LibraryDoc[] = [
      ...docs,
      { id: 'n1', folder: 'Newsletters', name: 'EverOut Weekend', text: 'VegFest Saturday' },
    ];
    const { getByLabelText, queryByText } = renderWithBoth(<LibraryPage />, {}, { libraryDocs: withNews });
    // Newsletters are background grounding for the agent — never shown as filed documents.
    expect(queryByText('Newsletters')).toBeNull();
    expect(queryByText('EverOut Weekend')).toBeNull();
    fireEvent.change(getByLabelText('Search documents'), { target: { value: 'vegfest' } });
    expect(queryByText('EverOut Weekend')).toBeNull();
  });
});
