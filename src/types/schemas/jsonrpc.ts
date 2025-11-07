/**
 * JSON-RPC Validation Integration
 *
 * Re-exports JSON-RPC schemas from serializers.ts and provides
 * validation helper functions for transport layer integration.
 *
 * @module schemas/jsonrpc
 */

// Re-export all JSON-RPC schemas from serializers
export {
  // Core JSON-RPC 2.0 schemas
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcErrorObjectSchema,
  JsonRpcNotificationSchema,
  JsonRpcMessageSchema,

  // Method-specific parameter schemas
  LoadModelParamsSchema,
  UnloadModelParamsSchema,
  GenerateParamsSchema,
  TokenizeParamsSchema,
  CheckDraftParamsSchema,
  BatchTokenizeParamsSchema,
  BatchCheckDraftParamsSchema,
  LoadVisionModelParamsSchema,
  GenerateWithImageParamsSchema,

  // Response schemas
  LoadModelResponseSchema,
  GenerateResponseSchema,
  // Note: TokenizeResponseSchema exported from tokenizer.ts (API schema) to avoid conflict
  CheckDraftResponseSchema,
  RuntimeInfoResponseSchema,
  RuntimeStateResponseSchema,
  ShutdownResponseSchema,
  VisionModelResponseSchema,

  // Notification schemas
  StreamChunkNotificationSchema,
  StreamStatsNotificationSchema,
  StreamEventNotificationSchema,

  // Types
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcMessage,
} from '../../bridge/serializers.js';

import type { ZodError } from 'zod';
import {
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationSchema,
  JsonRpcMessageSchema,
  LoadModelParamsSchema,
  UnloadModelParamsSchema,
  GenerateParamsSchema,
  TokenizeParamsSchema,
  CheckDraftParamsSchema,
} from '../../bridge/serializers.js';

/**
 * Map of JSON-RPC method names to their parameter schemas
 */
const METHOD_PARAM_SCHEMAS: Record<string, any> = {
  'load_model': LoadModelParamsSchema,
  'unload_model': UnloadModelParamsSchema,
  'generate': GenerateParamsSchema,
  'tokenize': TokenizeParamsSchema,
  'check_draft': CheckDraftParamsSchema,
};

/**
 * Validation result for JSON-RPC messages
 */
export interface JsonRpcValidationResult<T> {
  success: boolean;
  data?: T;
  error?: ZodError;
}

/**
 * Validate a JSON-RPC request with optional method-specific parameter validation
 *
 * @param request - The request object to validate
 * @param validateParams - Whether to validate method-specific params (default: true)
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateJsonRpcRequest({
 *   jsonrpc: '2.0',
 *   method: 'load_model',
 *   params: { model_id: 'llama-3-8b' },
 *   id: 1,
 * });
 *
 * if (!result.success) {
 *   console.error('Invalid request:', result.error);
 * }
 * ```
 */
export function validateJsonRpcRequest(
  request: unknown,
  validateParams: boolean = true
): JsonRpcValidationResult<any> {
  // 1. Validate generic JSON-RPC 2.0 structure
  const parseResult = JsonRpcRequestSchema.safeParse(request);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
    };
  }

  const parsed = parseResult.data;

  // 2. Validate method-specific params (if enabled and schema exists)
  if (validateParams && parsed.params !== undefined) {
    const paramSchema = METHOD_PARAM_SCHEMAS[parsed.method];
    if (paramSchema) {
      const paramsResult = paramSchema.safeParse(parsed.params);
      if (!paramsResult.success) {
        return {
          success: false,
          error: paramsResult.error,
        };
      }
    }
  }

  return {
    success: true,
    data: parsed,
  };
}

/**
 * Validate a JSON-RPC response (success or error)
 *
 * @param response - The response object to validate
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateJsonRpcResponse({
 *   jsonrpc: '2.0',
 *   result: { model_id: 'llama-3-8b', status: 'loaded' },
 *   id: 1,
 * });
 *
 * if (!result.success) {
 *   console.error('Invalid response:', result.error);
 * }
 * ```
 */
export function validateJsonRpcResponse(response: unknown): JsonRpcValidationResult<any> {
  // Try success schema first
  const successResult = JsonRpcSuccessSchema.safeParse(response);
  if (successResult.success) {
    return {
      success: true,
      data: successResult.data,
    };
  }

  // Try error schema
  const errorResult = JsonRpcErrorResponseSchema.safeParse(response);
  if (errorResult.success) {
    return {
      success: true,
      data: errorResult.data,
    };
  }

  // Neither schema matched
  return {
    success: false,
    error: successResult.error, // Return the first error
  };
}

/**
 * Validate a JSON-RPC notification
 *
 * @param notification - The notification object to validate
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateJsonRpcNotification({
 *   jsonrpc: '2.0',
 *   method: 'stream_chunk',
 *   params: { stream_id: 'abc123', chunk: 'Hello' },
 * });
 *
 * if (!result.success) {
 *   console.error('Invalid notification:', result.error);
 * }
 * ```
 */
export function validateJsonRpcNotification(notification: unknown): JsonRpcValidationResult<any> {
  const parseResult = JsonRpcNotificationSchema.safeParse(notification);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
    };
  }

  return {
    success: true,
    data: parseResult.data,
  };
}

/**
 * Validate any JSON-RPC message (request, response, or notification)
 *
 * @param message - The message object to validate
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateJsonRpcMessage(unknownMessage);
 * if (result.success) {
 *   console.log('Valid JSON-RPC message:', result.data);
 * }
 * ```
 */
export function validateJsonRpcMessage(message: unknown): JsonRpcValidationResult<any> {
  const parseResult = JsonRpcMessageSchema.safeParse(message);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
    };
  }

  return {
    success: true,
    data: parseResult.data,
  };
}
