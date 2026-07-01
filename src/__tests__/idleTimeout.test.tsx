// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useIdleTimeout, isIdle } from '../useIdleTimeout';

describe('isIdle', () => {
  it('is true only once elapsed >= timeout', () => {
    expect(isIdle(0, 999, 1000)).toBe(false);
    expect(isIdle(0, 1000, 1000)).toBe(true);
    expect(isIdle(500, 2000, 1000)).toBe(true);
  });
});

function Probe({ enabled, onIdle, timeoutMs }: { enabled: boolean; onIdle: () => void; timeoutMs: number }) {
  useIdleTimeout(enabled, onIdle, timeoutMs);
  return null;
}

describe('useIdleTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onIdle after the timeout with no activity', () => {
    const onIdle = vi.fn();
    render(<Probe enabled onIdle={onIdle} timeoutMs={1000} />);
    act(() => { vi.advanceTimersByTime(31000); }); // past the 30s poll interval
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', () => {
    const onIdle = vi.fn();
    render(<Probe enabled={false} onIdle={onIdle} timeoutMs={1000} />);
    act(() => { vi.advanceTimersByTime(120000); });
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires at most once per enabled period', () => {
    const onIdle = vi.fn();
    render(<Probe enabled onIdle={onIdle} timeoutMs={1000} />);
    act(() => { vi.advanceTimersByTime(120000); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity resets the idle timer', () => {
    const onIdle = vi.fn();
    render(<Probe enabled onIdle={onIdle} timeoutMs={100000} />);
    act(() => { vi.advanceTimersByTime(90000); });          // not yet idle
    act(() => { window.dispatchEvent(new Event('mousemove')); }); // reset
    act(() => { vi.advanceTimersByTime(90000); });          // would have fired without the reset
    expect(onIdle).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(30000); });          // now past timeout since last activity
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
