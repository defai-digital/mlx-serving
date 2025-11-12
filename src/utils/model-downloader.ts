/**
 * MLX Model Downloader TypeScript Wrapper
 *
 * Provides TypeScript API for downloading and managing MLX models
 * from Hugging Face mlx-community.
 */

import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { EventEmitter } from 'node:events';

export interface ModelInfo {
  repo_id: string;
  path: string;
  size_bytes: number;
  files: string[];
  last_modified?: string;
  quantization?: string;
}

export interface MLXModelEntry {
  repo_id: string;
  downloads: number;
  likes: number;
  tags: string[];
  created_at?: string;
}

export interface DownloadOptions {
  localDir?: string;
  allowPatterns?: string[];
  ignorePatterns?: string[];
  forceDownload?: boolean;
  cacheDir?: string;
  token?: string;
  onProgress?: (message: string) => void;
}

export interface ListOptions {
  filter?: string;
  limit?: number;
  sort?: 'downloads' | 'likes' | 'created';
  token?: string;
}

export interface CacheOptions {
  cacheDir?: string;
}

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly repoId?: string
  ) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

/**
 * MLX Model Downloader
 *
 * TypeScript wrapper for the Python model downloader utility.
 *
 * @example
 * ```typescript
 * const downloader = new MLXModelDownloader();
 *
 * // Download a model
 * const modelInfo = await downloader.download('mlx-community/Llama-3.2-3B-Instruct-4bit');
 * console.log('Model path:', modelInfo.path);
 *
 * // List available models
 * const models = await downloader.list({ filter: 'llama', limit: 10 });
 * console.log(`Found ${models.length} models`);
 *
 * // Get cached models
 * const cached = await downloader.getCachedModels();
 * console.log(`${cached.length} models in cache`);
 * ```
 */
export class MLXModelDownloader extends EventEmitter {
  private pythonPath: string;

  constructor(pythonPath?: string) {
    super();
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    // Downloader script path: resolvePath(__dirname, '../../python/model_downloader.py')
  }

  /**
   * Download a model from Hugging Face mlx-community
   *
   * @param repoId - Repository ID (e.g., "mlx-community/Llama-3.2-3B-Instruct-4bit")
   * @param options - Download options
   * @returns Model information
   * @throws {ModelDownloadError} If download fails
   *
   * @example
   * ```typescript
   * const modelInfo = await downloader.download(
   *   'mlx-community/Llama-3.2-3B-Instruct-4bit',
   *   {
   *     onProgress: (msg) => console.log(msg),
   *     forceDownload: false
   *   }
   * );
   * ```
   */
  async download(repoId: string, options: DownloadOptions = {}): Promise<ModelInfo> {
    const args = ['download', repoId];

    if (options.localDir) args.push('--local-dir', options.localDir);
    if (options.allowPatterns) {
      args.push('--allow-patterns', ...options.allowPatterns);
    }
    if (options.ignorePatterns) {
      args.push('--ignore-patterns', ...options.ignorePatterns);
    }
    if (options.forceDownload) args.push('--force');
    if (options.cacheDir) args.push('--cache-dir', options.cacheDir);
    if (options.token) args.push('--token', options.token);

    try {
      await this._runPython(args, options.onProgress);

      // Parse model info from output
      // The Python script outputs the model info, we need to extract it
      // For now, we'll make a second call to get cache info
      const cached = await this.getCachedModels(options.cacheDir);
      const modelInfo = cached.find((m) => m.repo_id === repoId);

      if (!modelInfo) {
        throw new ModelDownloadError(
          'Model downloaded but not found in cache',
          'CACHE_ERROR',
          repoId
        );
      }

      this.emit('downloaded', modelInfo);
      return modelInfo;
    } catch (error) {
      const err = error as Error;
      throw new ModelDownloadError(
        `Failed to download model ${repoId}: ${err.message}`,
        'DOWNLOAD_ERROR',
        repoId
      );
    }
  }

  /**
   * List available MLX models from mlx-community
   *
   * @param options - List options
   * @returns Array of model entries
   * @throws {ModelDownloadError} If listing fails
   *
   * @example
   * ```typescript
   * const models = await downloader.list({
   *   filter: 'llama',
   *   limit: 20,
   *   sort: 'downloads'
   * });
   *
   * models.forEach(m => {
   *   console.log(`${m.repo_id} - ${m.downloads} downloads`);
   * });
   * ```
   */
  async list(options: ListOptions = {}): Promise<MLXModelEntry[]> {
    const args = ['list', '--json'];

    if (options.filter) args.push('--filter', options.filter);
    if (options.limit) args.push('--limit', options.limit.toString());
    if (options.sort) args.push('--sort', options.sort);
    if (options.token) args.push('--token', options.token);

    try {
      const { stdout } = await this._runPython(args);
      const models = JSON.parse(stdout) as MLXModelEntry[];

      this.emit('list', models);
      return models;
    } catch (error) {
      const err = error as Error;
      throw new ModelDownloadError(
        `Failed to list models: ${err.message}`,
        'LIST_ERROR'
      );
    }
  }

  /**
   * Get list of cached models
   *
   * @param cacheDir - Optional cache directory
   * @returns Array of cached model info
   * @throws {ModelDownloadError} If cache read fails
   *
   * @example
   * ```typescript
   * const cached = await downloader.getCachedModels();
   * const totalSize = cached.reduce((sum, m) => sum + m.size_bytes, 0);
   * console.log(`Cache size: ${totalSize} bytes`);
   * ```
   */
  async getCachedModels(cacheDir?: string): Promise<ModelInfo[]> {
    const args = ['cache', '--list', '--json'];

    if (cacheDir) args.push('--cache-dir', cacheDir);

    try {
      const { stdout } = await this._runPython(args);
      const models = JSON.parse(stdout) as ModelInfo[];

      this.emit('cache-list', models);
      return models;
    } catch (error) {
      const err = error as Error;
      throw new ModelDownloadError(
        `Failed to get cached models: ${err.message}`,
        'CACHE_ERROR'
      );
    }
  }

  /**
   * Clear cached models
   *
   * @param repoId - Optional specific model to clear (default: clear all)
   * @param cacheDir - Optional cache directory
   * @throws {ModelDownloadError} If cache clear fails
   *
   * @example
   * ```typescript
   * // Clear specific model
   * await downloader.clearCache('mlx-community/Llama-3.2-3B-Instruct-4bit');
   *
   * // Clear all models
   * await downloader.clearCache();
   * ```
   */
  async clearCache(repoId?: string, cacheDir?: string): Promise<void> {
    const args = ['cache'];

    if (repoId) {
      args.push('--clear-model', repoId);
    } else {
      args.push('--clear');
    }

    if (cacheDir) args.push('--cache-dir', cacheDir);

    try {
      await this._runPython(args);
      this.emit('cache-cleared', repoId || 'all');
    } catch (error) {
      const err = error as Error;
      throw new ModelDownloadError(
        `Failed to clear cache: ${err.message}`,
        'CACHE_ERROR',
        repoId
      );
    }
  }

  /**
   * Run Python downloader script
   *
   * @private
   */
  private _runPython(
    args: string[],
    onProgress?: (message: string) => void
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const cwd = resolvePath(__dirname, '../..');
      const proc = spawn(this.pythonPath, ['-m', 'python.model_downloader', ...args], {
        cwd,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        const message = data.toString();
        stdout += message;
        if (onProgress) {
          onProgress(message);
        }
        this.emit('progress', message);
      });

      proc.stderr.on('data', (data: Buffer) => {
        const message = data.toString();
        stderr += message;
        this.emit('error-output', message);
      });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolvePromise({ stdout, stderr });
        } else {
          reject(new Error(`Python process exited with code ${code}\n${stderr}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(new Error(`Failed to spawn Python process: ${err.message}`));
      });
    });
  }
}

/**
 * Helper function to download a model
 *
 * @param repoId - Repository ID
 * @param options - Download options
 * @returns Model information
 *
 * @example
 * ```typescript
 * const model = await downloadModel('mlx-community/Llama-3.2-3B-Instruct-4bit');
 * console.log('Downloaded to:', model.path);
 * ```
 */
export async function downloadModel(
  repoId: string,
  options?: DownloadOptions
): Promise<ModelInfo> {
  const downloader = new MLXModelDownloader();
  return downloader.download(repoId, options);
}

/**
 * Helper function to list available models
 *
 * @param options - List options
 * @returns Array of model entries
 *
 * @example
 * ```typescript
 * const models = await listMLXModels({ filter: 'llama', limit: 10 });
 * models.forEach(m => console.log(m.repo_id));
 * ```
 */
export async function listMLXModels(options?: ListOptions): Promise<MLXModelEntry[]> {
  const downloader = new MLXModelDownloader();
  return downloader.list(options);
}
