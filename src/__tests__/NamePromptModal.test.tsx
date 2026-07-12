// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import NamePromptModal from '../components/NamePromptModal';
import { renderWithApp } from './helpers/mockContexts';

describe('NamePromptModal — reclaim existing profile (🐞 #6 lockout fix)', () => {
  it('offers a one-tap reclaim per existing profile and calls handleReclaimProfile', () => {
    const handleReclaimProfile = vi.fn();
    const { container, getByText } = renderWithApp(<NamePromptModal />, {
      handleReclaimProfile,
      familyMembers: [
        { name: 'Dad', role: 'Parent', color: 'indigo' },
        { name: 'Mom', role: 'Parent', color: 'rose' },
      ],
    });
    expect(getByText("I'm Dad")).toBeInTheDocument();
    expect(getByText("I'm Mom")).toBeInTheDocument();
    fireEvent.click(container.querySelector('#reclaim-profile-Dad')!);
    expect(handleReclaimProfile).toHaveBeenCalledWith('Dad');
  });

  it('hides the reclaim section for a brand-new household (no members → just the name input)', () => {
    const { queryByText, container } = renderWithApp(<NamePromptModal />, { familyMembers: [] });
    expect(queryByText(/Already set up/)).toBeNull();
    expect(container.querySelector('#name-prompt-input')).not.toBeNull();
  });
});

describe('NamePromptModal — dismissable (on-demand "link my profile" open)', () => {
  it('shows a close button and calls onDismiss when opened dismissably', () => {
    const onDismiss = vi.fn();
    const { container } = renderWithApp(<NamePromptModal dismissable onDismiss={onDismiss} />, { familyMembers: [] });
    const close = container.querySelector('#name-prompt-close')!;
    expect(close).not.toBeNull();
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no close button for the first-run gate (not dismissable)', () => {
    const { container } = renderWithApp(<NamePromptModal />, { familyMembers: [] });
    expect(container.querySelector('#name-prompt-close')).toBeNull();
  });

  it('is a labelled dialog and closes on Escape when dismissable (modal a11y)', () => {
    const onDismiss = vi.fn();
    const { container } = renderWithApp(<NamePromptModal dismissable onDismiss={onDismiss} />, { familyMembers: [] });
    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('NamePromptModal — optional onboarding prefs (first-login dietary/interests)', () => {
  it('shows the prefs step when onboardingName is set, and saves entered values', () => {
    const handleSaveOnboardingPrefs = vi.fn();
    const { container } = renderWithApp(<NamePromptModal />, { onboardingName: 'Dad', handleSaveOnboardingPrefs });
    const dietary = container.querySelector('#onboarding-dietary-input') as HTMLInputElement;
    const interests = container.querySelector('#onboarding-interests-input') as HTMLInputElement;
    expect(dietary).not.toBeNull();
    fireEvent.change(dietary, { target: { value: 'vegetarian' } });
    fireEvent.change(interests, { target: { value: 'hiking' } });
    fireEvent.click(container.querySelector('#onboarding-save-btn')!);
    expect(handleSaveOnboardingPrefs).toHaveBeenCalledWith({ dietary: 'vegetarian', interests: 'hiking' });
  });

  it('lets the user skip the prefs step', () => {
    const dismissOnboarding = vi.fn();
    const { container } = renderWithApp(<NamePromptModal />, { onboardingName: 'Dad', dismissOnboarding });
    fireEvent.click(container.querySelector('#onboarding-skip-btn')!);
    expect(dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  it('does not show the name input while onboarding prefs are showing', () => {
    const { container } = renderWithApp(<NamePromptModal />, { onboardingName: 'Dad' });
    expect(container.querySelector('#name-prompt-input')).toBeNull();
  });
});

describe('NamePromptModal — join an existing household by invite code', () => {
  it('offers the invite-code join and calls handleJoinHousehold on submit', () => {
    const handleJoinHousehold = vi.fn(e => e.preventDefault());
    const { container } = renderWithApp(<NamePromptModal />, {
      handleJoinHousehold,
      inviteCodeInput: 'ABC123', // ≥6 chars → Join enabled
    });
    const input = container.querySelector('#name-prompt-invite-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    const joinBtn = container.querySelector('#name-prompt-join-btn') as HTMLButtonElement;
    expect(joinBtn.disabled).toBe(false);
    fireEvent.submit(joinBtn.closest('form')!);
    expect(handleJoinHousehold).toHaveBeenCalled();
  });

  it('disables Join until a full 6-char code is entered', () => {
    const { container } = renderWithApp(<NamePromptModal />, { inviteCodeInput: 'AB' });
    const joinBtn = container.querySelector('#name-prompt-join-btn') as HTMLButtonElement;
    expect(joinBtn.disabled).toBe(true);
  });

  it('leads with the join CTA for a brand-new (empty) household', () => {
    const { getByText } = renderWithApp(<NamePromptModal />, { familyMembers: [] });
    expect(getByText(/Joining your family, or starting fresh/)).toBeInTheDocument();
  });
});
