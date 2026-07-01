// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignInGate from '../components/SignInGate';

describe('SignInGate', () => {
  it('shows the loading splash until auth is checked', () => {
    render(<SignInGate authChecked={false} onLogin={vi.fn()} errorStatus={null} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(document.getElementById('google-authenticate-btn')).toBeNull();
  });

  it('renders the Google sign-in once auth is checked', () => {
    render(<SignInGate authChecked={true} onLogin={vi.fn()} errorStatus={null} />);
    expect(document.getElementById('google-authenticate-btn')).toBeInTheDocument();
  });

  it('shows the no-login demo button only when onTryDemo is provided, and fires it', async () => {
    const user = userEvent.setup();
    const onTryDemo = vi.fn();
    render(<SignInGate authChecked={true} onLogin={vi.fn()} onTryDemo={onTryDemo} errorStatus={null} />);
    const btn = document.getElementById('evaluator-demo-login');
    expect(btn).toBeInTheDocument();
    await user.click(btn!);
    expect(onTryDemo).toHaveBeenCalledTimes(1);
  });

  it('omits the demo button when onTryDemo is not provided', () => {
    render(<SignInGate authChecked={true} onLogin={vi.fn()} errorStatus={null} />);
    expect(document.getElementById('evaluator-demo-login')).toBeNull();
  });
});
