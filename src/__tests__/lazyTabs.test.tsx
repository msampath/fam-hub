// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { lazy, Suspense } from 'react';
import { waitFor } from '@testing-library/react';
import { renderWithApp } from './helpers/mockContexts';

// App.tsx code-splits the add-event modal with React.lazy + Suspense (it isn't shown on the landing
// view). This guards that change: the dynamic-import path resolves, the module is still a DEFAULT
// export (lazy() requires it), and it mounts under a Suspense boundary with the app context available —
// so a typo'd lazy path or an accidental named export fails the suite, not prod.
const LazyAddEventModal = lazy(() => import('../components/AddEventModal'));

const fallback = <div>Loading…</div>;

describe('lazy-loaded modal mounts through Suspense', () => {
  it('resolves and renders the lazy AddEventModal when a day is selected', async () => {
    renderWithApp(
      <Suspense fallback={fallback}><LazyAddEventModal /></Suspense>,
      { selectedDayToAdd: '2026-06-20' },
    );
    await waitFor(() => expect(document.getElementById('modal-evt-start-time')).not.toBeNull());
  });
});
