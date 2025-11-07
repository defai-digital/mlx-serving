/**
 * Telemetry Configuration Schema
 *
 * Zod schema for validating OpenTelemetry configuration.
 *
 * @module schemas/telemetry
 */

import { z } from 'zod';

/**
 * Engine Telemetry Configuration Schema (camelCase)
 *
 * Validates OpenTelemetry configuration for the Engine API.
 * This is different from the runtime.yaml TelemetryConfigSchema (snake_case).
 *
 * Note: The `logger` field is intentionally omitted from validation
 * as it's a Pino instance that cannot be validated at runtime.
 *
 * @example
 * ```typescript
 * const config = {
 *   enabled: true,
 *   serviceName: 'mlx-serving',
 *   prometheusPort: 9464,
 *   exportIntervalMs: 60000,
 * };
 *
 * const result = EngineTelemetryConfigSchema.safeParse(config);
 * if (result.success) {
 *   console.log('Valid config:', result.data);
 * }
 * ```
 */
export const EngineTelemetryConfigSchema = z.object({
  /**
   * Enable metrics collection
   */
  enabled: z.boolean({
    required_error: 'enabled field is required',
    invalid_type_error: 'enabled must be a boolean',
  }),

  /**
   * Service name for metrics (alphanumeric + hyphens/underscores, max 100 chars)
   * Follows Prometheus naming conventions
   */
  serviceName: z
    .string()
    .min(1, 'Service name cannot be empty')
    .max(100, 'Service name cannot exceed 100 characters')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Service name must contain only alphanumeric characters, hyphens, and underscores'
    )
    .optional(),

  /**
   * Prometheus exporter port (non-privileged ports only: 1024-65535)
   */
  prometheusPort: z
    .number()
    .int('Prometheus port must be an integer')
    .min(1024, 'Prometheus port must be >= 1024')
    .max(65535, 'Prometheus port must be <= 65535')
    .optional(),

  /**
   * Metrics export interval in milliseconds (1s - 10m)
   */
  exportIntervalMs: z
    .number()
    .int('Export interval must be an integer')
    .min(1000, 'Export interval must be >= 1000ms (1 second)')
    .max(600000, 'Export interval must be <= 600000ms (10 minutes)')
    .optional(),
});

/**
 * Type inference for Engine TelemetryConfig
 */
export type EngineTelemetryConfig = z.infer<typeof EngineTelemetryConfigSchema>;
