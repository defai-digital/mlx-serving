/**
 * Exponential backoff retry utilities.
 *
 * Provides a configurable retry helper that is aware of transient error codes,
 * exponential backoff with optional jitter, and abort signal support.
 * Designed for use by transport layers where duplicate requests must be
 * carefully controlled and retry attempts measured.
 */

export interface RetryConfig {
  /**
   * Maximum number of attempts (initial call + retries).
   */
  maxAttempts: number;
  /**
   * Delay used for the first retry attempt (in milliseconds).
   */
  initialDelayMs: number;
  /**
   * Maximum delay between attempts (in milliseconds).
   */
  maxDelayMs: number;
  /**
   * Exponential backoff multiplier applied after each attempt.
   */
  backoffMultiplier: number;
  /**
   * List of retryable error identifiers (case insensitive).
   */
  retryableErrors: string[];
  /**
   * Optional abort signal to short circuit retry scheduling.
   */
  signal?: AbortSignal;
  /**
   * Optional jitter factor (0-1). Multiply delay by random factor.
   * Defaults to 0 (disabled).
   */
  jitter?: number;
  /**
   * Optional callback invoked before each retry attempt.
   */
  onRetry?: (context: RetryAttemptContext) => void;
}

export interface RetryAttemptContext {
  attempt: number;
  delayMs: number;
  error: unknown;
}

/**
 * Error thrown when a retry loop is aborted via AbortSignal.
 */
export class RetryAbortedError extends Error {
  constructor(message = 'Retry aborted') {
    super(message);
    this.name = 'RetryAbortedError';
  }
}

type RetryTokenExtractor = (error: unknown) => string[];

const DEFAULT_RETRY_TOKENS: RetryTokenExtractor[] = [
  (error) => {
    if (error && typeof (error as { code?: unknown }).code === 'string') {
      return [(error as { code: string }).code];
    }
    return [];
  },
  (error) => {
    if (error && typeof (error as { code?: unknown }).code === 'number') {
      return [String((error as { code: number }).code)];
    }
    return [];
  },
  (error) => {
    if (error instanceof Error && typeof error.name === 'string') {
      return [error.name];
    }
    return [];
  },
  (error) => {
    if (error instanceof Error && typeof error.message === 'string') {
      const tokens: string[] = [];
      if (/(?:timeout|timed\s+out)/i.test(error.message)) {
        tokens.push('TIMEOUT');
      }
      return tokens;
    }
    return [];
  },
];

/**
 * Determine whether an error should be retried.
 *
 * @param error - The error thrown from the previous attempt
 * @param retryableSet - A case-normalized set of retryable identifiers
 */
export function isRetryableError(
  error: unknown,
  retryableSet: Set<string>,
  extractors: RetryTokenExtractor[] = DEFAULT_RETRY_TOKENS
): boolean {
  if (!retryableSet.size) {
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }

  if (error instanceof RetryAbortedError) {
    return false;
  }

  for (const extract of extractors) {
    const tokens = extract(error);
    for (const token of tokens) {
      if (retryableSet.has(token.toUpperCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sleep helper aware of AbortSignal.
 */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  if (signal.aborted) {
    throw new RetryAbortedError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new RetryAbortedError());
    };

    signal.addEventListener('abort', onAbort);
  });
}

function nextDelay(current: number, multiplier: number, max: number): number {
  if (!Number.isFinite(current) || current < 0) {
    return max;
  }
  const scaled = current * multiplier;
  return Math.min(max, Math.max(current, Math.round(scaled)));
}

/**
 * Execute an async function with retries and exponential backoff.
 *
 * @param fn - Async function to execute
 * @param config - Retry configuration
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  if (config.maxAttempts < 1) {
    throw new Error('maxAttempts must be >= 1');
  }
  if (config.initialDelayMs < 0) {
    throw new Error('initialDelayMs must be >= 0');
  }
  if (config.maxDelayMs < config.initialDelayMs) {
    throw new Error('maxDelayMs must be >= initialDelayMs');
  }
  if (config.backoffMultiplier < 1) {
    throw new Error('backoffMultiplier must be >= 1');
  }
  if (!Array.isArray(config.retryableErrors)) {
    throw new Error('retryableErrors must be an array');
  }

  const retryableSet = new Set(
    config.retryableErrors.map((token) => token.toUpperCase())
  );
  const jitter = Math.min(Math.max(config.jitter ?? 0, 0), 1);

  let attempt = 0;
  let delayMs = config.initialDelayMs;
  let lastError: unknown;

  while (attempt < config.maxAttempts) {
    attempt += 1;

    if (config.signal?.aborted) {
      throw new RetryAbortedError();
    }

    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;

      if (attempt >= config.maxAttempts) {
        break;
      }

      if (!isRetryableError(error, retryableSet)) {
        break;
      }

      // Apply jitter: randomize delay within ±jitter% of the base delay
      // Example: delayMs=1000, jitter=0.5 → result is 500-1500ms (±50%)
      const computedDelay = jitter > 0
        ? Math.floor(delayMs * (1 - jitter + 2 * jitter * Math.random()))
        : delayMs;

      config.onRetry?.({
        attempt,
        delayMs: computedDelay,
        error,
      });

      await delay(computedDelay, config.signal);

      delayMs = nextDelay(delayMs, config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError ?? new Error('Retry attempts exhausted with unknown error');
}
