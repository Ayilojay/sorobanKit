// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useLatencyTracker } from './useLatencyTracker';

describe('useLatencyTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function TestComponent() {
    useLatencyTracker();
    return null;
  }

  it('clears the polling interval on unmount and does not fire callbacks afterwards', async () => {
    const { unmount } = render(<TestComponent />);

    // Allow any initial effect-triggered fetch to settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsBeforeUnmount = fetch.mock.calls.length;

    unmount();

    // Advance timers well past the 30s polling interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });

    expect(fetch.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('does not update state after unmount (no React warnings)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(<TestComponent />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });

    const stateUpdateWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      String(call[0]).includes('unmounted component')
    );
    expect(stateUpdateWarnings).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });
});