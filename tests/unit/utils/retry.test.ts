import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryWithBackoff,
  RetryAbortedError,
  isRetryableError,
} from '../../../src/utils/retry.js';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('executes without retry when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 50,
      maxDelayMs: 200,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT'],
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on matching error code and succeeds on subsequent attempt', async () => {
    const error = new Error('simulated timeout');
    (error as NodeJS.ErrnoException).code = 'TIMEOUT';

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 25,
      maxDelayMs: 100,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT'],
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after reaching maxAttempts', async () => {
    const error = new Error('permanent failure');
    (error as NodeJS.ErrnoException).code = 'TIMEOUT';
    const fn = vi.fn().mockRejectedValue(error);

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 20,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT'],
    });

    const expectation = expect(promise).rejects.toThrow('permanent failure');
    await vi.runAllTimersAsync();
    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('aborts retries when the abort signal fires during backoff', async () => {
    const controller = new AbortController();
    const error = new Error('socket reset');
    (error as NodeJS.ErrnoException).code = 'ECONNRESET';
    const fn = vi.fn().mockRejectedValue(error);

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 200,
      backoffMultiplier: 2,
      retryableErrors: ['ECONNRESET'],
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when error is not marked as retryable', async () => {
    const error = new Error('validation failed');
    (error as NodeJS.ErrnoException).code = 'INVALID';

    const fn = vi.fn().mockRejectedValue(error);

    const promise = retryWithBackoff(fn, {
      maxAttempts: 4,
      initialDelayMs: 10,
      maxDelayMs: 40,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT'],
    });

    const expectation = expect(promise).rejects.toThrow('validation failed');
    await vi.runAllTimersAsync();
    await expectation;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry callback with contextual information', async () => {
    const error = new Error('network blip');
    (error as NodeJS.ErrnoException).code = 'ECONNRESET';

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const onRetry = vi.fn();

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 10,
      maxDelayMs: 10,
      backoffMultiplier: 2,
      retryableErrors: ['ECONNRESET'],
      onRetry,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('success');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        delayMs: 10,
        error,
      })
    );
  });
});

describe('isRetryableError', () => {
  it('matches based on error code and message heuristics', () => {
    const error = new Error('Operation timed out');
    const retryable = new Set(['TIMEOUT']);

    expect(isRetryableError(error, retryable)).toBe(true);
  });

  it('excludes abort errors from retry consideration', () => {
    const abortError = new Error('Request aborted');
    abortError.name = 'AbortError';

    const retryable = new Set(['ECONNRESET', 'TIMEOUT']);

    expect(isRetryableError(abortError, retryable)).toBe(false);
  });
});
