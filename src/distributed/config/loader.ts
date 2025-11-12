/**
 * Configuration loader for distributed inference system
 *
 * Loads and validates cluster configuration from YAML files.
 */

import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../utils/logger.js';
import { ConfigurationError, ValidationError } from '../utils/errors.js';
import { validateClusterConfig, type ClusterConfig } from '../types/index.js';
import { ZodError } from 'zod';

const logger = createLogger('ConfigLoader');

/**
 * Load cluster configuration from YAML file
 *
 * @param path - Path to YAML configuration file
 * @returns Validated ClusterConfig
 * @throws {ConfigurationError} if file cannot be read
 * @throws {ValidationError} if configuration is invalid
 *
 * @example
 * ```typescript
 * const config = await loadClusterConfig('config/cluster.yaml');
 * console.log('Mode:', config.mode);
 * console.log('NATS port:', config.nats.embedded?.port);
 * ```
 */
export async function loadClusterConfig(path: string): Promise<ClusterConfig> {
  logger.info('Loading cluster configuration', { path });

  try {
    // Read YAML file
    const fileContent = await readFile(path, 'utf-8');
    logger.debug('Configuration file read successfully', { path });

    // Parse YAML
    const rawConfig = parseYaml(fileContent);
    logger.debug('YAML parsed successfully');

    // Validate with Zod schema
    try {
      const config = validateClusterConfig(rawConfig);
      logger.info('Configuration validated successfully', {
        mode: config.mode,
        natsMode: config.nats.mode,
      });

      return config;
    } catch (error) {
      if (error instanceof ZodError) {
        // Convert Zod errors to ValidationError
        const validationErrors = error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        logger.error('Configuration validation failed', undefined, {
          errors: validationErrors,
        });

        throw new ValidationError(
          'Configuration validation failed',
          validationErrors
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    logger.error('Failed to load configuration', error as Error, { path });
    throw new ConfigurationError(
      `Failed to load configuration from ${path}: ${(error as Error).message}`,
      error as Error
    );
  }
}

/**
 * Load configuration with environment variable interpolation
 *
 * Supports ${ENV_VAR} syntax in YAML files.
 *
 * @param path - Path to YAML configuration file
 * @returns Validated ClusterConfig
 */
export async function loadClusterConfigWithEnv(path: string): Promise<ClusterConfig> {
  logger.info('Loading cluster configuration with env interpolation', { path });

  try {
    // Read YAML file
    let fileContent = await readFile(path, 'utf-8');

    // Replace environment variables
    fileContent = interpolateEnvVars(fileContent);

    // Parse YAML
    const rawConfig = parseYaml(fileContent);

    // Validate with Zod schema
    try {
      const config = validateClusterConfig(rawConfig);
      logger.info('Configuration validated successfully', {
        mode: config.mode,
        natsMode: config.nats.mode,
      });

      return config;
    } catch (error) {
      if (error instanceof ZodError) {
        const validationErrors = error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        throw new ValidationError(
          'Configuration validation failed',
          validationErrors
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ConfigurationError(
      `Failed to load configuration from ${path}: ${(error as Error).message}`,
      error as Error
    );
  }
}

/**
 * Interpolate environment variables in string
 *
 * Replaces ${VAR_NAME} with process.env.VAR_NAME
 */
function interpolateEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      logger.warn(`Environment variable not found: ${varName}`);
      return '';
    }
    return value;
  });
}

/**
 * Validate configuration object without loading from file
 *
 * @param config - Configuration object to validate
 * @returns Validated ClusterConfig
 * @throws {ValidationError} if configuration is invalid
 */
export function validateConfig(config: unknown): ClusterConfig {
  try {
    return validateClusterConfig(config);
  } catch (error) {
    if (error instanceof ZodError) {
      const validationErrors = error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message,
      }));

      throw new ValidationError('Configuration validation failed', validationErrors);
    }
    throw error;
  }
}
