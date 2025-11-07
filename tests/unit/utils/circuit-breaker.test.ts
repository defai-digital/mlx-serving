import { describe, it, expect, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../../src/utils/circuit-breaker.js';

const createBreaker = (): { breaker: CircuitBreaker; advance: (ms: number) => void } => {
  let now = 0;
  const advance = (ms: number): void => {
    now += ms;
  };

  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    recoveryTimeoutMs: 1000,
    halfOpenMaxCalls: 1,
    halfOpenSuccessThreshold: 2,
    failureWindowMs: 5000,
    now: () => now,
  });

  return { breaker, advance };
};

describe('CircuitBreaker', () => {
  it('allows execution when closed', async () => {
    const { breaker } = createBreaker();

    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('opens after exceeding failure threshold', async () => {
    const { breaker } = createBreaker();
    const failing = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(breaker.execute(failing)).rejects.toThrow('fail');
    await expect(breaker.execute(failing)).rejects.toThrow('fail');
    await expect(breaker.execute(failing)).rejects.toThrow('fail');

    expect(breaker.getState()).toBe('OPEN');
    await expect(breaker.execute(async () => 'recover')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    );
  });

  it('transitions to half-open after recovery timeout and closes on successes', async () => {
    const { breaker, advance } = createBreaker();
    const failing = vi.fn().mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    advance(1000);

    const probe = vi.fn().mockResolvedValue('ok');

    const firstProbe = breaker.execute(probe);
    await expect(firstProbe).resolves.toBe('ok');
    expect(breaker.getState()).toBe('HALF_OPEN');

    const secondProbe = breaker.execute(probe);
    await expect(secondProbe).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('reopens when a half-open probe fails', async () => {
    const { breaker, advance } = createBreaker();
    const failing = vi.fn().mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    advance(1000);

    await expect(
      breaker.execute(async () => {
        throw new Error('still failing');
      })
    ).rejects.toThrow('still failing');

    expect(breaker.getState()).toBe('OPEN');
  });

  it('limits concurrent calls while half-open', async () => {
    const { breaker, advance } = createBreaker();

    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        })
      ).rejects.toThrow('fail');
    }

    advance(1000);

    let resolveProbe: (() => void) | undefined;
    const pendingProbe = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          resolveProbe = () => resolve('ok');
        })
    );

    await expect(
      breaker.execute(async () => 'parallel')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    resolveProbe?.();
    await expect(pendingProbe).resolves.toBe('ok');
  });

  it('can be manually reset', async () => {
    const { breaker } = createBreaker();

    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        })
      ).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe('OPEN');
    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
  });
});
