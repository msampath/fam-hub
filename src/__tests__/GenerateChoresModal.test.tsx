// @vitest-environment jsdom
// AI starter chore plan modal (docs/ai-chore-plan-generator.md): form gating, preview grouping,
// selected-only bulk add, and the honest error path (no fabricated preview). Mocked at the ctx
// boundary like every other component test — no App boot, no real fetch.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import GenerateChoresModal from '../components/GenerateChoresModal';
import { renderWithApp } from './helpers/mockContexts';
import type { FamilyMember } from '../types';
import type { GeneratedChore } from '../utils/chorePlan';

const members: FamilyMember[] = [
  { name: 'Mom', role: 'Parent', color: 'indigo' },
  { name: 'Ava', role: 'Kid', color: 'sky' },
  { name: 'Max', role: 'Kid', color: 'lime' },
];

const SAMPLE: GeneratedChore[] = [
  { title: 'Make bed', assignedTo: 'Ava', points: 10, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Morning', notes: 'Flat blanket, pillow on top.' },
  { title: 'Water plants', assignedTo: 'Ava', points: 15, timesPerDay: 1, repeatType: 'weekly', scheduleTimeOfDay: 'Afternoon' },
  { title: 'Toy bin tidy', assignedTo: 'Max', points: 5, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Evening' },
];

const fillAges = (getByLabelText: any = null, container?: HTMLElement) => {
  const ava = (container ?? document).querySelector('#gen-chore-age-Ava') as HTMLInputElement;
  const max = (container ?? document).querySelector('#gen-chore-age-Max') as HTMLInputElement;
  fireEvent.change(ava, { target: { value: '8' } });
  fireEvent.change(max, { target: { value: '4' } });
};

describe('GenerateChoresModal', () => {
  it('renders one age row per kid; Generate stays disabled until every age is valid', () => {
    const { container, getByText } = renderWithApp(<GenerateChoresModal />, { familyMembers: members });
    expect(container.querySelector('#gen-chore-age-Ava')).toBeTruthy();
    expect(container.querySelector('#gen-chore-age-Max')).toBeTruthy();
    const submit = getByText('Generate plan') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fillAges(null, container);
    expect((getByText('Generate plan') as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits ages (+optional fields only when set), previews grouped per kid with notes, all pre-checked', async () => {
    const handleGenerateChores = vi.fn(async () => SAMPLE);
    const { container, getByText } = renderWithApp(<GenerateChoresModal />, { familyMembers: members, handleGenerateChores });
    fillAges(null, container);
    fireEvent.click(getByText('Generate plan'));
    await waitFor(() => expect(handleGenerateChores).toHaveBeenCalledWith([
      { name: 'Ava', age: 8 },
      { name: 'Max', age: 4 },
    ]));
    await waitFor(() => expect(getByText('Make bed')).toBeInTheDocument());
    expect(getByText('Water plants')).toBeInTheDocument();
    expect(getByText('Toy bin tidy')).toBeInTheDocument();
    expect(getByText('Flat blanket, pillow on top.')).toBeInTheDocument(); // notes render
    const checkboxes = Array.from(container.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.every(c => c.checked)).toBe(true); // default: everything selected
    expect(getByText('Add selected (3)')).toBeInTheDocument();
  });

  it('adds only the SELECTED rows and reports the added/duplicate summary', async () => {
    const handleGenerateChores = vi.fn(async () => SAMPLE);
    const addGeneratedChores = vi.fn(() => ({ added: 2, duplicates: 1 }));
    const { container, getByText } = renderWithApp(<GenerateChoresModal />, { familyMembers: members, handleGenerateChores, addGeneratedChores });
    fillAges(null, container);
    fireEvent.click(getByText('Generate plan'));
    await waitFor(() => getByText('Make bed'));
    // Untick the second row (Water plants), then add.
    const checkboxes = Array.from(container.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[];
    fireEvent.click(checkboxes[1]);
    fireEvent.click(getByText('Add selected (2)'));
    expect(addGeneratedChores).toHaveBeenCalledWith([SAMPLE[0], SAMPLE[2]]);
    expect(getByText(/Added 2 · skipped 1 duplicate\./)).toBeInTheDocument();
    expect(getByText('Done')).toBeInTheDocument();
  });

  it('a generation failure stays on the form and shows choreGenError — no fabricated preview', async () => {
    const handleGenerateChores = vi.fn(async () => null);
    const { container, getByText, queryByText } = renderWithApp(
      <GenerateChoresModal />,
      { familyMembers: members, handleGenerateChores, choreGenError: 'The AI service is busy right now — try again in a moment.' },
    );
    fillAges(null, container);
    fireEvent.click(getByText('Generate plan'));
    await waitFor(() => expect(handleGenerateChores).toHaveBeenCalled());
    expect(getByText(/AI service is busy/)).toBeInTheDocument();
    expect(queryByText(/Add selected/)).toBeNull(); // still the form phase
    expect(container.querySelector('#gen-chore-age-Ava')).toBeTruthy();
  });

  it('closes via setIsGeneratingChoresOpen(false)', () => {
    const setIsGeneratingChoresOpen = vi.fn();
    const { getByText } = renderWithApp(<GenerateChoresModal />, { familyMembers: members, setIsGeneratingChoresOpen });
    fireEvent.click(getByText('Cancel'));
    expect(setIsGeneratingChoresOpen).toHaveBeenCalledWith(false);
  });
});
