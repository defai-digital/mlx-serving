/**
 * API Validators for mlx-serving
 *
 * Provides validation utilities for API parameters to catch errors early.
 */

import type {
  LoadModelOptions,
  GeneratorParams,
  TokenizeRequest,
} from '../types/index.js';
import { EngineClientError } from './errors.js';

/**
 * Validation result type
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate LoadModelOptions parameters.
 *
 * @param options - Load model options to validate
 * @returns Validation result with errors if any
 */
export function validateLoadModelOptions(
  options: LoadModelOptions
): ValidationResult {
  const errors: string[] = [];

  if (!options.model) {
    errors.push('model is required');
  }

  if (typeof options.model === 'string') {
    if (options.model.trim().length === 0) {
      errors.push('model identifier cannot be empty');
    }
  } else {
    if (!options.model.id || options.model.id.trim().length === 0) {
      errors.push('model descriptor must have a valid id');
    }
  }

  if (options.quantization) {
    const validQuantizations = ['none', 'int8', 'int4'];
    if (!validQuantizations.includes(options.quantization)) {
      errors.push(
        `quantization must be one of: ${validQuantizations.join(', ')}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate GeneratorParams parameters.
 *
 * @param params - Generator parameters to validate
 * @returns Validation result with errors if any
 */
export function validateGeneratorParams(
  params: GeneratorParams
): ValidationResult {
  const errors: string[] = [];

  if (!params.model) {
    errors.push('model is required');
  } else if (typeof params.model === 'string' && params.model.trim().length === 0) {
    errors.push('model identifier cannot be empty');
  }

  if (!params.prompt) {
    errors.push('prompt is required');
  } else if (typeof params.prompt === 'string' && params.prompt.trim().length === 0) {
    errors.push('prompt cannot be empty');
  }

  if (params.maxTokens !== undefined) {
    if (!Number.isInteger(params.maxTokens) || params.maxTokens <= 0) {
      errors.push('maxTokens must be a positive integer');
    }
    if (params.maxTokens > 100000) {
      errors.push('maxTokens cannot exceed 100000');
    }
  }

  if (params.temperature !== undefined) {
    if (typeof params.temperature !== 'number' || params.temperature < 0 || params.temperature > 2) {
      errors.push('temperature must be a number between 0 and 2');
    }
  }

  if (params.topP !== undefined) {
    if (typeof params.topP !== 'number' || params.topP < 0 || params.topP > 1) {
      errors.push('topP must be a number between 0 and 1');
    }
  }

  if (params.presencePenalty !== undefined) {
    if (typeof params.presencePenalty !== 'number' || params.presencePenalty < -2 || params.presencePenalty > 2) {
      errors.push('presencePenalty must be a number between -2 and 2');
    }
  }

  if (params.frequencyPenalty !== undefined) {
    if (typeof params.frequencyPenalty !== 'number' || params.frequencyPenalty < -2 || params.frequencyPenalty > 2) {
      errors.push('frequencyPenalty must be a number between -2 and 2');
    }
  }

  if (params.repetitionPenalty !== undefined) {
    if (typeof params.repetitionPenalty !== 'number' || params.repetitionPenalty < 0) {
      errors.push('repetitionPenalty must be a non-negative number');
    }
  }

  if (params.seed !== undefined) {
    if (!Number.isInteger(params.seed) || params.seed < 0) {
      errors.push('seed must be a non-negative integer');
    }
  }

  if (params.stopSequences !== undefined) {
    if (!Array.isArray(params.stopSequences)) {
      errors.push('stopSequences must be an array');
    } else if (params.stopSequences.some(s => typeof s !== 'string')) {
      errors.push('all stopSequences must be strings');
    }
  }

  if (params.stopTokenIds !== undefined) {
    if (!Array.isArray(params.stopTokenIds)) {
      errors.push('stopTokenIds must be an array');
    } else if (params.stopTokenIds.some(id => !Number.isInteger(id) || id < 0)) {
      errors.push('all stopTokenIds must be non-negative integers');
    }
  }

  if (params.structured) {
    if (!params.structured.schema) {
      errors.push('structured.schema is required when using structured output');
    }
    if (!params.structured.format) {
      errors.push('structured.format is required when using structured output');
    } else if (!['json', 'yaml'].includes(params.structured.format)) {
      errors.push('structured.format must be "json" or "yaml"');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate TokenizeRequest parameters.
 *
 * @param request - Tokenize request to validate
 * @returns Validation result with errors if any
 */
export function validateTokenizeRequest(
  request: TokenizeRequest
): ValidationResult {
  const errors: string[] = [];

  if (!request.model) {
    errors.push('model is required');
  } else if (typeof request.model === 'string' && request.model.trim().length === 0) {
    errors.push('model identifier cannot be empty');
  }

  if (!request.text) {
    errors.push('text is required');
  } else if (typeof request.text !== 'string') {
    errors.push('text must be a string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Assert that LoadModelOptions are valid, throwing if invalid.
 *
 * @param options - Load model options to validate
 * @throws {EngineClientError} if validation fails
 */
export function assertValidLoadModelOptions(
  options: LoadModelOptions
): void {
  const result = validateLoadModelOptions(options);
  if (!result.valid) {
    throw new EngineClientError(
      'InvalidParams',
      `Invalid LoadModelOptions: ${result.errors.join(', ')}`,
      { errors: result.errors }
    );
  }
}

/**
 * Assert that GeneratorParams are valid, throwing if invalid.
 *
 * @param params - Generator parameters to validate
 * @throws {EngineClientError} if validation fails
 */
export function assertValidGeneratorParams(
  params: GeneratorParams
): void {
  const result = validateGeneratorParams(params);
  if (!result.valid) {
    throw new EngineClientError(
      'InvalidParams',
      `Invalid GeneratorParams: ${result.errors.join(', ')}`,
      { errors: result.errors }
    );
  }
}

/**
 * Assert that TokenizeRequest is valid, throwing if invalid.
 *
 * @param request - Tokenize request to validate
 * @throws {EngineClientError} if validation fails
 */
export function assertValidTokenizeRequest(
  request: TokenizeRequest
): void {
  const result = validateTokenizeRequest(request);
  if (!result.valid) {
    throw new EngineClientError(
      'InvalidParams',
      `Invalid TokenizeRequest: ${result.errors.join(', ')}`,
      { errors: result.errors }
    );
  }
}

/**
 * Sanitize model identifier to prevent path traversal.
 *
 * @param modelId - The model identifier
 * @returns Sanitized model identifier
 * @throws {EngineClientError} if identifier is invalid
 */
export function sanitizeModelId(modelId: string): string {
  if (!modelId || modelId.trim().length === 0) {
    throw new EngineClientError(
      'InvalidParams',
      'Model identifier cannot be empty'
    );
  }

  // Check for path traversal attempts
  if (modelId.includes('..') || modelId.includes('/') || modelId.includes('\\')) {
    throw new EngineClientError(
      'InvalidParams',
      'Model identifier cannot contain path separators or traversal sequences',
      { modelId }
    );
  }

  return modelId.trim();
}

/**
 * Validate model ID format (alphanumeric, hyphens, underscores, dots).
 *
 * @param modelId - The model identifier
 * @returns true if valid, false otherwise
 */
export function isValidModelIdFormat(modelId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(modelId);
}

/**
 * Clamp a number to a specified range.
 *
 * @param value - The value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize temperature value to valid range.
 *
 * @param temperature - Temperature value
 * @returns Normalized temperature (0-2)
 */
export function normalizeTemperature(temperature: number | undefined): number | undefined {
  if (temperature === undefined) {
    return undefined;
  }
  return clamp(temperature, 0, 2);
}

/**
 * Normalize top-p value to valid range.
 *
 * @param topP - Top-p value
 * @returns Normalized top-p (0-1)
 */
export function normalizeTopP(topP: number | undefined): number | undefined {
  if (topP === undefined) {
    return undefined;
  }
  return clamp(topP, 0, 1);
}
