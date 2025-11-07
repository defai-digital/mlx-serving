#!/usr/bin/env node

/**
 * MLX Model Downloader CLI
 *
 * Command-line interface for downloading and managing MLX models
 *
 * Usage:
 *   mlx-download <repo-id>                        # Download a model
 *   mlx-download list [options]                   # List available models
 *   mlx-download cache [options]                  # Manage cache
 */

import { MLXModelDownloader, ModelDownloadError } from '../utils/model-downloader.js';

interface CLIArgs {
  _: string[];
  filter?: string;
  limit?: number;
  sort?: 'downloads' | 'likes' | 'created';
  'cache-dir'?: string;
  'local-dir'?: string;
  force?: boolean;
  token?: string;
  help?: boolean;
  version?: boolean;
  quiet?: boolean;
  json?: boolean;
  clear?: boolean;
  'clear-model'?: string;
}

function parseArgs(args: string[]): CLIArgs {
  const result: CLIArgs = { _: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith('--')) {
        (result as unknown as Record<string, unknown>)[key] = nextArg;
        i++;
      } else {
        (result as unknown as Record<string, unknown>)[key] = true;
      }
    } else {
      result._.push(arg);
    }
  }

  return result;
}

function printHelp() {
  console.log(`
MLX Model Downloader - Download and manage MLX models from Hugging Face

USAGE:
  mlx-download <repo-id> [options]      Download a model
  mlx-download list [options]           List available models
  mlx-download cache [options]          Manage cached models

COMMANDS:
  <repo-id>                             Download specified model
                                        Example: mlx-community/Llama-3.2-3B-Instruct-4bit

  list                                  List available MLX models
    --filter <text>                     Filter by model name
    --limit <number>                    Max models to show (default: 50)
    --sort <field>                      Sort by downloads|likes|created
    --json                              Output as JSON

  cache                                 Manage model cache
    --list                              List cached models
    --clear                             Clear all cached models
    --clear-model <repo-id>             Clear specific model
    --json                              Output as JSON

OPTIONS:
  --cache-dir <path>                    Cache directory
  --local-dir <path>                    Download to specific directory
  --force                               Force re-download
  --token <token>                       Hugging Face API token
  --quiet                               Suppress output
  --help                                Show this help message
  --version                             Show version

EXAMPLES:
  # Download a model
  mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit

  # List models with filter
  mlx-download list --filter llama --limit 10

  # Show cached models
  mlx-download cache --list

  # Clear specific model from cache
  mlx-download cache --clear-model mlx-community/Llama-3.2-3B-Instruct-4bit

ENVIRONMENT VARIABLES:
  HF_TOKEN                              Hugging Face API token
  PYTHON_PATH                           Path to Python executable

For more information, visit: https://github.com/defai-digital/mlx-serving
`);
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    const pkg = await import('../../package.json', { assert: { type: 'json' } });
    console.log(`mlx-download v${pkg.default.version}`);
    process.exit(0);
  }

  const command = args._[0];

  if (!command) {
    console.error('❌ Error: No command specified\n');
    printHelp();
    process.exit(1);
  }

  const downloader = new MLXModelDownloader();
  const verbose = !args.quiet;

  try {
    // Handle 'list' command
    if (command === 'list') {
      const models = await downloader.list({
        filter: args.filter,
        limit: args.limit ? parseInt(String(args.limit), 10) : 50,
        sort: args.sort || 'downloads',
        token: args.token,
      });

      if (args.json) {
        console.log(JSON.stringify(models, null, 2));
      } else if (verbose) {
        console.log(`\n📋 MLX Community Models (showing ${models.length})`);
        console.log('='.repeat(80));
        models.forEach((model, i) => {
          console.log(`${i + 1}. ${model.repo_id}`);
          console.log(`   📥 Downloads: ${model.downloads.toLocaleString()} | ❤️  Likes: ${model.likes}`);
          if (model.tags.length > 0) {
            console.log(`   🏷️  Tags: ${model.tags.slice(0, 5).join(', ')}`);
          }
          console.log();
        });
      }

      process.exit(0);
    }

    // Handle 'cache' command
    if (command === 'cache') {
      if (args.clear) {
        await downloader.clearCache(undefined, args['cache-dir']);
        if (verbose) {
          console.log('✅ Cache cleared successfully!');
        }
        process.exit(0);
      }

      if (args['clear-model']) {
        await downloader.clearCache(args['clear-model'], args['cache-dir']);
        if (verbose) {
          console.log(`✅ Cleared model: ${args['clear-model']}`);
        }
        process.exit(0);
      }

      // Default: list cache
      const cached = await downloader.getCachedModels(args['cache-dir']);

      if (args.json) {
        console.log(JSON.stringify(cached, null, 2));
      } else if (verbose) {
        if (cached.length === 0) {
          console.log('📭 No models in cache');
        } else {
          const totalSize = cached.reduce((sum, m) => sum + m.size_bytes, 0);
          console.log(`\n💾 Cached Models (${cached.length} total, ${formatSize(totalSize)})`);
          console.log('='.repeat(80));
          cached.forEach((model, i) => {
            console.log(`${i + 1}. ${model.repo_id}`);
            console.log(`   💾 Size: ${formatSize(model.size_bytes)}`);
            if (model.quantization) {
              console.log(`   🔢 Quantization: ${model.quantization}`);
            }
            console.log(`   📂 Path: ${model.path}`);
            console.log();
          });
        }
      }

      process.exit(0);
    }

    // Handle download command (repo-id)
    const repoId = command;

    if (verbose) {
      console.log(`\n📥 Downloading model: ${repoId}`);
      console.log('⏳ This may take a while...\n');
    }

    const modelInfo = await downloader.download(repoId, {
      localDir: args['local-dir'],
      forceDownload: args.force,
      cacheDir: args['cache-dir'],
      token: args.token,
      onProgress: verbose ? (msg) => process.stdout.write(msg) : undefined,
    });

    if (verbose) {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ Model Downloaded: ${modelInfo.repo_id}`);
      console.log('='.repeat(60));
      console.log(`📂 Path: ${modelInfo.path}`);
      console.log(`💾 Size: ${formatSize(modelInfo.size_bytes)}`);
      if (modelInfo.quantization) {
        console.log(`🔢 Quantization: ${modelInfo.quantization}`);
      }
      console.log(`📄 Files: ${modelInfo.files.length} total`);
      console.log('='.repeat(60));
    }

    process.exit(0);
  } catch (error) {
    const err = error as ModelDownloadError;

    if (verbose) {
      console.error(`\n❌ Error: ${err.message}`);

      if (err.code) {
        console.error(`   Code: ${err.code}`);
      }
      if (err.repoId) {
        console.error(`   Model: ${err.repoId}`);
      }

      if (!args.quiet && err.stack) {
        console.error('\nStack trace:');
        console.error(err.stack);
      }
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
