import { describe, it, expect } from 'vitest';
import {
  normalizeGeneratorParams,
  denormalizeGeneratorParams,
  normalizeLoadModelOptions,
  denormalizeLoadModelOptions,
  normalizeTokenizeRequest,
  denormalizeTokenizeRequest,
} from '../../../src/compat/config-normalizer.js';

describe('config-normalizer', () => {
  describe('normalizeGeneratorParams', () => {
    it('converts snake_case fields to camelCase equivalents', () => {
      const normalized = normalizeGeneratorParams({
        model_id: 'llama-3',
        prompt: 'Hi there',
        max_tokens: 32,
        top_p: 0.9,
        presence_penalty: 0.2,
        stream: false,
        custom_flag: true,
      });

      expect(normalized).toBeDefined();
      expect(normalized?.model).toBe('llama-3');
      expect(normalized?.maxTokens).toBe(32);
      expect(normalized?.topP).toBe(0.9);
      expect(normalized?.presencePenalty).toBe(0.2);
      expect(normalized?.streaming).toBe(false);
      expect((normalized as Record<string, unknown>).custom_flag).toBe(true);
    });

    it('returns undefined for nullish inputs', () => {
      expect(normalizeGeneratorParams(null)).toBeUndefined();
      expect(normalizeGeneratorParams(undefined)).toBeUndefined();
    });
  });

  describe('denormalizeGeneratorParams', () => {
    it('produces snake_case payloads with model_id', () => {
      const snake = denormalizeGeneratorParams({
        model: 'llama-3',
        prompt: 'Test',
        maxTokens: 16,
        frequencyPenalty: 0.3,
        streaming: true,
      });

      expect(snake).toBeDefined();
      expect(snake?.model_id).toBe('llama-3');
      expect(snake?.max_tokens).toBe(16);
      expect(snake?.frequency_penalty).toBe(0.3);
      expect(snake?.streaming).toBe(true);
      expect(snake?.prompt).toBe('Test');
    });
  });

  describe('normalizeLoadModelOptions', () => {
    it('normalizes inline generation parameters and nested snake_case', () => {
      const normalized = normalizeLoadModelOptions({
        model_id: 'llama-3',
        max_tokens: 256,
        top_p: 0.95,
        parameters: {
          temperature: 0.7,
          stopSequences: ['\n'],
        },
        extra_option: 'keep-me',
      } as any);

      expect(normalized).toBeDefined();
      expect(normalized?.model).toBe('llama-3');
      expect(normalized?.parameters).toMatchObject({
        maxTokens: 256,
        topP: 0.95,
        temperature: 0.7,
        stopSequences: ['\n'],
      });
      expect(
        (normalized as Record<string, unknown>).extra_option
      ).toBe('keep-me');
    });
  });

  describe('denormalizeLoadModelOptions', () => {
    it('produces snake_case parameters with generator fields', () => {
      const snake = denormalizeLoadModelOptions({
        model: 'llama-3',
        revision: 'main',
        parameters: {
          maxTokens: 128,
          presencePenalty: 0.1,
        },
      });

      expect(snake).toBeDefined();
      expect(snake?.model_id).toBe('llama-3');
      expect(snake?.revision).toBe('main');
      expect((snake?.parameters as Record<string, unknown>)?.max_tokens).toBe(128);
      expect((snake?.parameters as Record<string, unknown>)?.presence_penalty).toBe(0.1);
    });
  });

  describe('normalizeTokenizeRequest', () => {
    it('maps snake_case fields to camelCase equivalents', () => {
      const normalized = normalizeTokenizeRequest({
        model: 'llama-3',  // model is required
        model_id: 'llama-3',
        text: 'hello',
        add_bos: true,
      });

      expect(normalized).toBeDefined();
      expect(normalized?.model).toBe('llama-3');
      expect(normalized?.addBos).toBe(true);
    });
  });

  describe('denormalizeTokenizeRequest', () => {
    it('produces snake_case payload with add_special_tokens flag', () => {
      const snake = denormalizeTokenizeRequest({
        model: 'llama-3',
        text: 'world',
        addBos: false,
      });

      expect(snake).toBeDefined();
      expect(snake?.model_id).toBe('llama-3');
      expect(snake?.add_special_tokens).toBe(false);
      expect(snake?.add_bos).toBe(false);
    });
  });
});
