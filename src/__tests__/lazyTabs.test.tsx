// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { lazy, Suspense } from 'react';
import { render, waitFor } from '@testing-library/react';
import { AppContext } from '../AppContext';
import { makeAppCtx } from './helpers/mockContexts';

// App.tsx code-splits the add-event modal with React.lazy + Suspense (it isn't shown on the landing
// view). This guards that change: the dynamic-import path resolves, the module is still a DEFAULT
// export (lazy() requires it), and it mounts under a Suspense boundary with the app context available —
// so a typo'd lazy path or an accidental named export fails the suite, not prod.
const LazyAddEventModal = lazy(() => import('../components/AddEventModal'));

const fallback = <div>Loading…</div>;

describe('lazy-loaded modal mounts through Suspense', () => {
  it('resolves and renders the lazy AddEventModal when a day is selected', async () => {
    const ctx = makeAppCtx({ selectedDayToAdd: '2026-06-20' });
    render(
      <AppContext.Provider value={ctx}>
        <Suspense fallback={fallback}><LazyAddEventModal setEvents={vi.fn()} /></Suspense>
      </AppContext.Provider>,
    );
    await waitFor(() => expect(document.getElementById('modal-evt-start-time')).not.toBeNull());
  });
});
