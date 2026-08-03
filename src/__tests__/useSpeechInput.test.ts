// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpeechInput } from '../hooks/useSpeechInput';

// A minimal fake of the Web Speech API's SpeechRecognition — enough to drive onresult/onend/onerror
// the same way a real browser implementation calls them.
class FakeRecognition {
  lang = ''; interimResults = false; continuous = false;
  onresult: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  start() { /* no-op */ }
  stop() { this.onend?.(); }
  abort() { /* no-op */ }
}

let sessions: FakeRecognition[] = [];
const current = () => sessions[sessions.length - 1]!;
const result = (rec: FakeRecognition, transcript: string) =>
  rec.onresult!({ results: [{ 0: { transcript }, isFinal: false }] });

beforeEach(() => {
  sessions = [];
  // A plain function (not arrow) so `new Ctor()` works — an arrow function can't be a constructor,
  // but a regular function that returns an object makes `new` use that returned object as `this`.
  (window as any).SpeechRecognition = vi.fn(function () { const r = new FakeRecognition(); sessions.push(r); return r; });
});

afterEach(() => {
  delete (window as any).SpeechRecognition;
});

describe('useSpeechInput — press-and-hold with session restart', () => {
  it('is continuous (so a mid-hold pause does not end the session on its own)', () => {
    const { result: hook } = renderHook(() => useSpeechInput(vi.fn()));
    act(() => hook.current.start());
    expect(current().continuous).toBe(true);
  });

  it('streams interim text while held, without marking it final', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => result(current(), 'add milk'));
    expect(onTranscript).toHaveBeenCalledWith('add milk', false);
    expect(hook.current.listening).toBe(true);
  });

  it('submits the accumulated transcript as final only on release', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => result(current(), 'add milk to the list'));
    onTranscript.mockClear();
    act(() => hook.current.stop());
    expect(onTranscript).toHaveBeenCalledWith('add milk to the list', true);
    expect(hook.current.listening).toBe(false);
  });

  it('RESTARTS the session when Chrome ends it mid-hold, instead of treating it as a release', () => {
    // The real-world bug: Chrome's speech service ends sessions on its own well under a second in.
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => result(current(), 'plan a trip'));
    act(() => current().onend!());              // service-initiated end — button still held
    expect(sessions.length).toBe(2);            // a fresh session was spawned
    expect(hook.current.listening).toBe(true);  // still recording as far as the user can tell
    expect(onTranscript).not.toHaveBeenCalledWith(expect.anything(), true); // NOT finalized
  });

  it('accumulates text across restarted sub-sessions and submits it all on release', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => result(current(), 'plan a trip'));
    act(() => current().onend!());              // restart #1
    act(() => result(current(), 'to olympic national park'));
    onTranscript.mockClear();
    act(() => hook.current.stop());
    expect(onTranscript).toHaveBeenCalledWith('plan a trip to olympic national park', true);
  });

  it('gives up after 3 consecutive errored sessions with no speech (dead mic), finalizing what it has', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    for (let i = 0; i < 3; i++) {
      act(() => { current().onerror!({ error: 'network' }); current().onend!(); });
    }
    expect(sessions.length).toBe(3);            // spawned 1 + 2 restarts, then stopped trying
    expect(hook.current.listening).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled(); // nothing captured → nothing submitted
  });

  it('a successful result resets the error run, so intermittent errors do not end the hold', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => { current().onerror!({ error: 'no-speech' }); current().onend!() });  // errored restart 1
    act(() => { current().onerror!({ error: 'no-speech' }); current().onend!() });  // errored restart 2
    act(() => result(current(), 'hello'));                                          // audio flows → reset
    act(() => { current().onerror!({ error: 'no-speech' }); current().onend!() });  // fresh error run
    expect(hook.current.listening).toBe(true);  // still holding, still listening
    act(() => hook.current.stop());
    expect(onTranscript).toHaveBeenCalledWith('hello', true);
  });

  it('does not fire a final callback if the hold ends with no transcript captured', () => {
    const onTranscript = vi.fn();
    const { result: hook } = renderHook(() => useSpeechInput(onTranscript));
    act(() => hook.current.start());
    act(() => hook.current.stop());
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('a second start() while already holding is a no-op (does not spawn a second session)', () => {
    const { result: hook } = renderHook(() => useSpeechInput(vi.fn()));
    act(() => hook.current.start());
    act(() => hook.current.start());
    expect(sessions.length).toBe(1);
  });
});
