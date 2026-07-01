// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IdleScreensaver from '../components/IdleScreensaver';

describe('IdleScreensaver', () => {
  it('shows the wake hint and wakes on a tap', () => {
    const onWake = vi.fn();
    render(<IdleScreensaver onWake={onWake} refreshing={false} />);
    expect(screen.getByText('tap or press any key to wake')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('shows live weather chips when provided', () => {
    render(
      <IdleScreensaver
        onWake={vi.fn()}
        refreshing={false}
        weather={{
          tempF: 72, condition: 'Sunny', homeLabel: 'Sammamish',
          aqi: 42, aqiLabel: 'Good', aqiColor: '#34d399',
          uv: 6, uvLabel: 'High', uvColor: '#fb923c',
        }}
      />,
    );
    expect(screen.getByText('72° Sunny · Sammamish')).toBeInTheDocument();
    expect(screen.getByText('AQI 42 · Good')).toBeInTheDocument();
    expect(screen.getByText('UV 6 · High')).toBeInTheDocument();
  });

  it('wakes on a keypress', () => {
    const onWake = vi.fn();
    render(<IdleScreensaver onWake={onWake} refreshing={false} />);
    fireEvent.keyDown(window, { key: 'a' });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('shows a refreshing state and ignores taps while refreshing', () => {
    const onWake = vi.fn();
    render(<IdleScreensaver onWake={onWake} refreshing={true} />);
    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
    expect(screen.queryByText('tap or press any key to wake')).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('dialog'));
    fireEvent.keyDown(window, { key: 'a' });
    expect(onWake).not.toHaveBeenCalled();
  });
});
