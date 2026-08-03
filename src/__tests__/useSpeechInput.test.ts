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
  started = false;
  start() { this.started = true; }
  stop() { this.onend?.(); }
  abort() { this.started = false; }
}

let lastRec: FakeRecognition | null = null;

beforeEach(() => {
  lastRec = null;
  // A plain function (not arrow) so `new Ctor()` works — an arrow function can't be a constructor,
  // but a regular function that returns an object makes `new` use that returned object as `this`.
  (window as any).SpeechRecognition = vi.fn(function () { lastRec = new FakeRecognition(); return lastRec; });
});

afterEach(() => {
  delete (window as any).SpeechRecognition;
});

describe('useSpeechInput — press-and-hold (start/stop, not tap-to-toggle)', () => {
  it('is continuous (so a mid-hold pause does not end the session on its own)', () => {
    const { result } = renderHook(() => useSpeechInput(vi.fn()));
    act(() => result.current.start());
    expect(lastRec!.continuous).toBe(true);
  });

  it('streams interim text on every result while held, without marking it final', () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onTranscript));
    act(() => result.current.start());
    act(() => lastRec!.onresult!({ results: [{ 0: { transcript: 'add milk' }, isFinal: false }] }));
    expect(onTranscript).toHaveBeenCalledWith('add milk', false);
    expect(result.current.listening).toBe(true);
  });

  it('submits the accumulated transcript as final only when the session ends (on release)', () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onTranscript));
    act(() => result.current.start());
    act(() => lastRec!.onresult!({ results: [{ 0: { transcript: 'add milk to the list' }, isFinal: true }] }));
    onTranscript.mockClear(); // drop the interim call above; only the release-triggered final call matters here
    act(() => result.current.stop());
    expect(onTranscript).toHaveBeenCalledWith('add milk to the list', true);
    expect(result.current.listening).toBe(false);
  });

  it('does not fire a final callback if the session ends with no transcript captured', () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onTranscript));
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('a second start() while already listening is a no-op (does not spawn a second session)', () => {
    const { result } = renderHook(() => useSpeechInput(vi.fn()));
    act(() => result.current.start());
    const ctor = (window as any).SpeechRecognition;
    act(() => result.current.start());
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('a recognition error stops listening and does not submit a final transcript', () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onTranscript));
    act(() => result.current.start());
    act(() => lastRec!.onresult!({ results: [{ 0: { transcript: 'partial' }, isFinal: false }] }));
    onTranscript.mockClear();
    act(() => lastRec!.onerror!({ error: 'audio-capture' }));
    expect(result.current.listening).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
