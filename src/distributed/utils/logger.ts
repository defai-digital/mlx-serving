/**
 * Structured logger for distributed inference system
 *
 * Provides JSON-formatted logging with configurable log levels.
 * Log level can be controlled via KR_MLX_LOG_LEVEL environment variable.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Simple logger with debug/info/warn/error levels
 *
 * @example
 * ```typescript
 * const logger = createLogger('NatsClient', 'debug');
 * logger.info('Connected to NATS', { url: 'localhost:4222' });
 * logger.error('Connection failed', error, { attempt: 3 });
 * ```
 */
export class Logger {
  private readonly minLevel: LogLevel;

  constructor(
    private readonly component: string,
    minLevel?: LogLevel
  ) {
    // Support environment-based log level (KR_MLX_LOG_LEVEL)
    const envLevel = process.env.KR_MLX_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
    this.minLevel = minLevel ?? envLevel ?? 'info';
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const minIndex = levels.indexOf(this.minLevel);
    const currentIndex = levels.indexOf(level);
    return currentIndex >= minIndex;
  }

  /**
   * Format log entry as JSON string
   */
  private formatEntry(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'debug',
      component: this.component,
      message,
      ...(context && { context }),
    };

    // eslint-disable-next-line no-console
    console.debug(this.formatEntry(entry));
  }

  /**
   * Log info message
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      component: this.component,
      message,
      ...(context && { context }),
    };

    // eslint-disable-next-line no-console
    console.info(this.formatEntry(entry));
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      component: this.component,
      message,
      ...(context && { context }),
    };

    console.warn(this.formatEntry(entry));
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (!this.shouldLog('error')) return;

    const _entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      component: this.component,
      message,
      ...(context && { context }),
      ...(error && {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      }),
    };

    // console.error(this.formatEntry(_entry));
  }

  /**
   * Create a child logger with namespaced component
   *
   * @example
   * ```typescript
   * const parent = createLogger('Controller');
   * const child = parent.child('Registry');
   * child.info('Worker registered'); // component: "Controller:Registry"
   * ```
   */
  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`, this.minLevel);
  }
}

/**
 * Create a logger instance
 *
 * @param component - Component name (e.g., 'NatsClient', 'Controller')
 * @param level - Optional log level override (defaults to KR_MLX_LOG_LEVEL or 'info')
 */
export function createLogger(component: string, level?: LogLevel): Logger {
  return new Logger(component, level);
}
