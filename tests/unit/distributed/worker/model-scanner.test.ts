import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelScanner } from '@/distributed/worker/model-scanner.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs module
vi.mock('fs/promises');

describe('ModelScanner', () => {
  let scanner: ModelScanner;
  const mockModelDir = 'test-model-dir';

  beforeEach(() => {
    scanner = new ModelScanner(mockModelDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('scan()', () => {
    it('should return empty skills if directory does not exist', async () => {
      // Mock directory doesn't exist
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

      const skills = await scanner.scan();

      expect(skills.availableModels).toEqual([]);
      expect(skills.modelPaths).toEqual({});
      expect(skills.totalModelSize).toBe(0);
      expect(skills.lastScanned).toBeGreaterThan(0);
    });

    it('should return empty skills if directory is empty', async () => {
      // Mock empty directory
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const skills = await scanner.scan();

      expect(skills.availableModels).toEqual([]);
      expect(skills.modelPaths).toEqual({});
      expect(skills.totalModelSize).toBe(0);
    });

    it('should discover models with safetensors and config', async () => {
      const _mockModelPath = path.join(mockModelDir, 'mlx-community', 'test-model');

      // Mock directory structure
      vi.mocked(fs.stat).mockImplementation(async (p) => {
        if (typeof p === 'string') {
          if (p === mockModelDir) {
            return { isDirectory: () => true } as any;
          }
          if (p.includes('test-model')) {
            return { isDirectory: () => false, size: 1000 } as any;
          }
        }
        return { isDirectory: () => true } as any;
      });

      vi.mocked(fs.readdir).mockImplementation(async (p, options) => {
        if (typeof p === 'string') {
          if (p === mockModelDir) {
            return [
              { name: 'mlx-community', isDirectory: () => true } as any,
            ];
          }
          if (p.includes('mlx-community')) {
            return [
              { name: 'test-model', isDirectory: () => true } as any,
            ];
          }
          if (p.includes('test-model')) {
            if (options && 'withFileTypes' in options) {
              return [
                { name: 'model.safetensors', isFile: () => true, isDirectory: () => false } as any,
                { name: 'config.json', isFile: () => true, isDirectory: () => false } as any,
              ];
            }
            return ['model.safetensors', 'config.json'];
          }
        }
        return [];
      });

      const skills = await scanner.scan();

      expect(skills.availableModels.length).toBeGreaterThan(0);
      expect(skills.totalModelSize).toBeGreaterThan(0);
    });

    it('should calculate total model size correctly', async () => {
      const _mockModelPath = path.join(mockModelDir, 'test-model');
      const mockFileSize = 5000;

      vi.mocked(fs.stat).mockImplementation(async (p) => {
        if (typeof p === 'string') {
          if (p === mockModelDir) {
            return { isDirectory: () => true } as any;
          }
          return { isDirectory: () => false, size: mockFileSize } as any;
        }
        return { isDirectory: () => true } as any;
      });

      vi.mocked(fs.readdir).mockImplementation(async (p, options) => {
        if (typeof p === 'string') {
          if (p === mockModelDir) {
            return [
              { name: 'test-model', isDirectory: () => true } as any,
            ];
          }
          if (p.includes('test-model')) {
            if (options && 'withFileTypes' in options) {
              return [
                { name: 'model.safetensors', isFile: () => true, isDirectory: () => false } as any,
                { name: 'config.json', isFile: () => true, isDirectory: () => false } as any,
              ];
            }
            return ['model.safetensors', 'config.json'];
          }
        }
        return [];
      });

      const skills = await scanner.scan();

      expect(skills.totalModelSize).toBe(mockFileSize * 2); // 2 files
    });

    it('should handle scan errors gracefully', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

      const skills = await scanner.scan();

      expect(skills.availableModels).toEqual([]);
      expect(skills.modelPaths).toEqual({});
      expect(skills.totalModelSize).toBe(0);
    });

    it('should set lastScanned timestamp', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const beforeScan = Date.now();
      const skills = await scanner.scan();
      const afterScan = Date.now();

      expect(skills.lastScanned).toBeGreaterThanOrEqual(beforeScan);
      expect(skills.lastScanned).toBeLessThanOrEqual(afterScan);
    });

    it('should extract model names correctly', async () => {
      const _mockModelPath = path.join(mockModelDir, 'mlx-community', 'Llama-3.2-3B-Instruct-4bit');

      vi.mocked(fs.stat).mockImplementation(async (p) => {
        if (typeof p === 'string') {
          if (p === mockModelDir || p.includes('mlx-community')) {
            return { isDirectory: () => true } as any;
          }
          return { isDirectory: () => false, size: 1000 } as any;
        }
        return { isDirectory: () => true } as any;
      });

      vi.mocked(fs.readdir).mockImplementation(async (p, options) => {
        if (typeof p === 'string') {
          if (p === mockModelDir) {
            return [
              { name: 'mlx-community', isDirectory: () => true } as any,
            ];
          }
          if (p.includes('mlx-community') && !p.includes('Llama')) {
            return [
              { name: 'Llama-3.2-3B-Instruct-4bit', isDirectory: () => true } as any,
            ];
          }
          if (p.includes('Llama')) {
            if (options && 'withFileTypes' in options) {
              return [
                { name: 'model.safetensors', isFile: () => true, isDirectory: () => false } as any,
                { name: 'config.json', isFile: () => true, isDirectory: () => false } as any,
              ];
            }
            return ['model.safetensors', 'config.json'];
          }
        }
        return [];
      });

      const skills = await scanner.scan();

      const modelName = skills.availableModels[0];
      expect(modelName).toContain('mlx-community');
      expect(modelName).toContain('Llama-3.2-3B-Instruct-4bit');
    });
  });
});
