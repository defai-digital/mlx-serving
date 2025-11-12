/**
 * Model Scanner
 *
 * Scans local "model" directory to discover available MLX models.
 * Used for worker skills announcement for smart routing (Week 3).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';
import type { ModelSkills } from '../types/messages.js';

export interface ModelInfo {
  name: string;
  path: string;
  size: number;
}

export class ModelScanner {
  private logger: Logger;
  private readonly modelDir: string;

  constructor(modelDir = 'model') {
    this.modelDir = modelDir;
    this.logger = createLogger('ModelScanner');
  }

  /**
   * Scan model directory and return ModelSkills
   *
   * @returns ModelSkills object with discovered models
   */
  async scan(): Promise<ModelSkills> {
    try {
      // Check if model directory exists
      const dirExists = await this.directoryExists(this.modelDir);
      if (!dirExists) {
        this.logger.warn(`Model directory does not exist: ${this.modelDir}`);
        return this.emptySkills();
      }

      // Scan for models recursively
      const models = await this.scanDirectory(this.modelDir);

      // Build skills object
      const availableModels: string[] = [];
      const modelPaths: Record<string, string> = {};
      let totalModelSize = 0;

      for (const model of models) {
        availableModels.push(model.name);
        modelPaths[model.name] = model.path;
        totalModelSize += model.size;
      }

      const skills: ModelSkills = {
        availableModels,
        modelPaths,
        totalModelSize,
        lastScanned: Date.now(),
      };

      this.logger.info('Model scan complete', {
        count: availableModels.length,
        totalSizeGB: (totalModelSize / (1024 * 1024 * 1024)).toFixed(2),
      });

      return skills;
    } catch (error) {
      this.logger.error('Failed to scan models', error as Error);
      return this.emptySkills();
    }
  }

  /**
   * Scan directory recursively for MLX models
   *
   * A directory is considered a model if it contains:
   * - model.safetensors (or variants)
   * - config.json
   *
   * @param dirPath - Directory to scan
   * @returns Array of discovered models
   */
  private async scanDirectory(dirPath: string): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Check if this directory is a model
          const isModel = await this.isModelDirectory(fullPath);
          if (isModel) {
            const modelInfo = await this.getModelInfo(fullPath, entry.name);
            models.push(modelInfo);
          } else {
            // Recursively scan subdirectories
            const subModels = await this.scanDirectory(fullPath);
            models.push(...subModels);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to scan directory: ${dirPath}`, error as Error);
    }

    return models;
  }

  /**
   * Check if directory contains an MLX model
   *
   * @param dirPath - Directory to check
   * @returns True if directory is a model
   */
  private async isModelDirectory(dirPath: string): Promise<boolean> {
    try {
      const files = await fs.readdir(dirPath);

      // Check for model.safetensors or variants
      const hasModelFile = files.some(
        (file) =>
          file === 'model.safetensors' ||
          file.startsWith('model-') ||
          file.endsWith('.safetensors') ||
          file === 'pytorch_model.bin',
      );

      // Check for config.json
      const hasConfig = files.includes('config.json');

      return hasModelFile && hasConfig;
    } catch {
      return false;
    }
  }

  /**
   * Get model information
   *
   * @param dirPath - Model directory path
   * @param name - Model name
   * @returns Model info
   */
  private async getModelInfo(dirPath: string, name: string): Promise<ModelInfo> {
    try {
      // Calculate total size of all files in model directory
      const size = await this.getDirectorySize(dirPath);

      // Extract model name (last component of path)
      const modelName = this.extractModelName(dirPath);

      return {
        name: modelName || name,
        path: dirPath,
        size,
      };
    } catch (error) {
      this.logger.error(`Failed to get model info: ${dirPath}`, error as Error);
      return {
        name,
        path: dirPath,
        size: 0,
      };
    }
  }

  /**
   * Calculate total size of directory
   *
   * @param dirPath - Directory path
   * @returns Total size in bytes
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
        } else if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to calculate size: ${dirPath}`, error as Error);
    }

    return totalSize;
  }

  /**
   * Extract model name from path
   *
   * Tries to extract HuggingFace-style name (org/model-name)
   *
   * @param dirPath - Model directory path
   * @returns Model name
   */
  private extractModelName(dirPath: string): string | null {
    try {
      // Get last two path components (e.g., "mlx-community/Llama-3.2-3B-Instruct-4bit")
      const parts = dirPath.split(path.sep).filter((p) => p.length > 0);
      if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
      }
      return parts[parts.length - 1] || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if directory exists
   *
   * @param dirPath - Directory path
   * @returns True if exists
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Return empty skills object
   *
   * @returns Empty ModelSkills
   */
  private emptySkills(): ModelSkills {
    return {
      availableModels: [],
      modelPaths: {},
      totalModelSize: 0,
      lastScanned: Date.now(),
    };
  }
}
