import { describe, it, expect } from 'vitest';
import { routeTurn } from '../utils/copilotRouter';

const reachable = { agentReachable: true };

describe('routeTurn', () => {
  it('routes ACTION + active-DISCOVERY intents to the cloud agent', () => {
    for (const m of [
      'add a zoo day Saturday',
      'schedule a dentist appointment for Ava',
      'remind me to pack for the trip',
      'add milk to the shopping list',
      'find us a good vegan restaurant nearby',
      'plan a zoo day for the kids',
      'where can we take the kids Saturday?',
    ]) {
      expect(routeTurn(m, reachable)).toBe('agent');
    }
  });

  it('keeps read / Q&A local (the local copilot grounds these — no need to spend the cloud agent)', () => {
    for (const m of [
      'what bills are due this month?',   // read → local (cost discipline)
      'what are my chores today?',        // read → local
      "what's happening this weekend?",   // local copilot has PLACES/EVENTS grounding
      'what is the capital of France?',
      'how do I use this app?',
      'explain how XP works',
    ]) {
      expect(routeTurn(m, reachable)).toBe('local');
    }
  });

  it('routes anything that asks the bar to DO something to the agent — incl. phrasings the old verb-list missed (the bar IS the concierge, never refuses)', () => {
    for (const m of [
      'make a reservation for 4 at Din Tai Fung Friday',  // "make" — old router missed this → went local → refused
      'get us a table at the Thai place',
      'delete all chores',
      'sort the kids summer camps',
      'organize our camping trip',
      'i want to plan Leo\'s birthday party',
    ]) {
      expect(routeTurn(m, reachable)).toBe('agent');
    }
  });

  it('forced (escalate) always routes to the agent', () => {
    expect(routeTurn('what is the capital of France?', { agentReachable: true, forced: true })).toBe('agent');
  });

  it('falls back to local when the agent is unreachable, even for action intent', () => {
    expect(routeTurn('add a zoo day Saturday', { agentReachable: false })).toBe('local');
    expect(routeTurn('add a zoo day Saturday', { agentReachable: false, forced: true })).toBe('local');
  });
});
