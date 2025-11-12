import { describe, it, expect } from 'vitest';
import {
  validateLoadModelOptions,
  validateGeneratorParams,
  validateTokenizeRequest,
  assertValidLoadModelOptions,
  assertValidGeneratorParams,
  assertValidTokenizeRequest,
  sanitizeModelId,
  isValidModelIdFormat,
  normalizeTemperature,
  normalizeTopP,
  clamp,
} from '@/api/validators.js';
import { EngineClientError } from '@/api/errors.js';

describe('API Validators', () => {
  describe('validateLoadModelOptions', () => {
    it('should validate correct options', () => {
      const result = validateLoadModelOptions({
        model: 'test-model',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject empty model identifier', () => {
      const result = validateLoadModelOptions({
        model: '  ',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('model identifier cannot be empty');
    });

    it('should reject invalid quantization', () => {
      const result = validateLoadModelOptions({
        model: 'test-model',
        quantization: 'invalid' as unknown as 'int4',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('quantization must be one of'))).toBe(true);
    });

    it('should accept valid quantization modes', () => {
      const modes: ('none' | 'int8' | 'int4')[] = ['none', 'int8', 'int4'];

      for (const mode of modes) {
        const result = validateLoadModelOptions({
          model: 'test-model',
          quantization: mode,
        });

        expect(result.valid).toBe(true);
      }
    });
  });

  describe('validateGeneratorParams', () => {
    it('should validate correct parameters', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'Hello, world!',
        maxTokens: 100,
        temperature: 0.7,
        topP: 0.9,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject missing model', () => {
      const result = validateGeneratorParams({
        model: '',
        prompt: 'test',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('model is required');
    });

    it('should reject missing prompt', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: '',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('prompt is required');
    });

    it('should reject invalid maxTokens', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        maxTokens: -1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxTokens must be a positive integer');
    });

    it('should reject maxTokens exceeding limit', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        maxTokens: 200000,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxTokens cannot exceed 100000');
    });

    it('should reject invalid temperature', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        temperature: 3.0,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('temperature must be a number between 0 and 2');
    });

    it('should reject invalid topP', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        topP: 1.5,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('topP must be a number between 0 and 1');
    });

    it('should reject invalid penalties', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        presencePenalty: 5.0,
        frequencyPenalty: -3.0,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('presencePenalty must be a number between -2 and 2');
      expect(result.errors).toContain('frequencyPenalty must be a number between -2 and 2');
    });

    it('should reject negative repetitionPenalty', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        repetitionPenalty: -1.0,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('repetitionPenalty must be a non-negative number');
    });

    it('should reject invalid seed', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        seed: -1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('seed must be a non-negative integer');
    });

    it('should validate structured output config', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        structured: {
          schema: { type: 'object' },
          format: 'json',
        },
      });

      expect(result.valid).toBe(true);
    });

    it('should reject invalid structured output format', () => {
      const result = validateGeneratorParams({
        model: 'test-model',
        prompt: 'test',
        structured: {
          schema: { type: 'object' },
          format: 'invalid' as any,
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('structured.format must be "json" or "yaml"');
    });
  });

  describe('validateTokenizeRequest', () => {
    it('should validate correct request', () => {
      const result = validateTokenizeRequest({
        model: 'test-model',
        text: 'Hello, world!',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject missing model', () => {
      const result = validateTokenizeRequest({
        model: '',
        text: 'test',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('model is required');
    });

    it('should reject missing text', () => {
      const result = validateTokenizeRequest({
        model: 'test-model',
        text: '',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('text is required');
    });
  });

  describe('assertValidLoadModelOptions', () => {
    it('should not throw for valid options', () => {
      expect(() =>
        assertValidLoadModelOptions({
          model: 'test-model',
        })
      ).not.toThrow();
    });

    it('should throw EngineClientError for invalid options', () => {
      expect(() =>
        assertValidLoadModelOptions({
          model: '',
        })
      ).toThrow(EngineClientError);
    });
  });

  describe('assertValidGeneratorParams', () => {
    it('should not throw for valid params', () => {
      expect(() =>
        assertValidGeneratorParams({
          model: 'test-model',
          prompt: 'test',
        })
      ).not.toThrow();
    });

    it('should throw EngineClientError for invalid params', () => {
      expect(() =>
        assertValidGeneratorParams({
          model: 'test-model',
          prompt: '',
        })
      ).toThrow(EngineClientError);
    });
  });

  describe('assertValidTokenizeRequest', () => {
    it('should not throw for valid request', () => {
      expect(() =>
        assertValidTokenizeRequest({
          model: 'test-model',
          text: 'test',
        })
      ).not.toThrow();
    });

    it('should throw EngineClientError for invalid request', () => {
      expect(() =>
        assertValidTokenizeRequest({
          model: '',
          text: 'test',
        })
      ).toThrow(EngineClientError);
    });
  });

  describe('sanitizeModelId', () => {
    it('should accept valid model identifiers', () => {
      expect(sanitizeModelId('test-model')).toBe('test-model');
      expect(sanitizeModelId('  test-model  ')).toBe('test-model');
    });

    it('should reject empty identifiers', () => {
      expect(() => sanitizeModelId('')).toThrow(EngineClientError);
      expect(() => sanitizeModelId('   ')).toThrow(EngineClientError);
    });

    it('should reject path traversal attempts', () => {
      expect(() => sanitizeModelId('../etc/passwd')).toThrow(EngineClientError);
      expect(() => sanitizeModelId('test/model')).toThrow(EngineClientError);
      expect(() => sanitizeModelId('test\\model')).toThrow(EngineClientError);
    });
  });

  describe('isValidModelIdFormat', () => {
    it('should accept valid formats', () => {
      expect(isValidModelIdFormat('test-model')).toBe(true);
      expect(isValidModelIdFormat('test_model')).toBe(true);
      expect(isValidModelIdFormat('test.model')).toBe(true);
      expect(isValidModelIdFormat('TestModel123')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isValidModelIdFormat('test/model')).toBe(false);
      expect(isValidModelIdFormat('test model')).toBe(false);
      expect(isValidModelIdFormat('test@model')).toBe(false);
    });
  });

  describe('clamp', () => {
    it('should clamp values to range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('normalizeTemperature', () => {
    it('should return undefined for undefined input', () => {
      expect(normalizeTemperature(undefined)).toBeUndefined();
    });

    it('should clamp temperature to valid range', () => {
      expect(normalizeTemperature(0.7)).toBe(0.7);
      expect(normalizeTemperature(-1)).toBe(0);
      expect(normalizeTemperature(3)).toBe(2);
    });
  });

  describe('normalizeTopP', () => {
    it('should return undefined for undefined input', () => {
      expect(normalizeTopP(undefined)).toBeUndefined();
    });

    it('should clamp top-p to valid range', () => {
      expect(normalizeTopP(0.9)).toBe(0.9);
      expect(normalizeTopP(-0.5)).toBe(0);
      expect(normalizeTopP(1.5)).toBe(1);
    });
  });
});
