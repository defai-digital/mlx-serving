import { defineConfig } from 'tsup';

/**
 * Build configuration for mlx-serving
 *
 * This configuration:
 * 1. Generates both ESM and CJS outputs
 * 2. Generates TypeScript declarations
 * 3. Marks OpenTelemetry packages as external to avoid bundling issues
 * 4. Marks all other dependencies as external (they'll be resolved from node_modules)
 *
 * Why mark OpenTelemetry as external?
 * - OpenTelemetry packages contain dynamic require() calls for Node.js built-ins (http, https, etc.)
 * - These dynamic requires don't work when bundled in ES module format
 * - By marking them as external, they're resolved at runtime from node_modules
 * - This fixes: "Dynamic require of 'http' is not supported" error
 */
export default defineConfig({
  // Entry point
  entry: ['src/index.ts'],

  // Output formats
  format: ['esm', 'cjs'],

  // Generate TypeScript declarations
  dts: false, // Temporarily disabled due to TypeScript strict mode issues - TODO: Re-enable after fixing

  // Split output into chunks (better for tree-shaking)
  splitting: false,

  // Source maps for debugging
  sourcemap: true,

  // Clean dist folder before build
  clean: true,

  // Don't bundle any dependencies - resolve them from node_modules
  // This is the correct approach for a library that will be published to npm
  external: [
    // OpenTelemetry packages (fix for issue #2)
    '@opentelemetry/api',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/exporter-prometheus',

    // All other production dependencies from package.json
    'eventemitter3',
    'execa',
    'js-yaml',
    'pino',
    'yaml',
    'zod',

    // Node.js built-ins
    'child_process',
    'crypto',
    'events',
    'fs',
    'http',
    'https',
    'net',
    'os',
    'path',
    'stream',
    'util',
    'url',
  ],

  // Target Node.js 22+
  target: 'node22',

  // Use platform-specific shims
  platform: 'node',

  // Enable shims for __dirname, __filename, import.meta.url
  // This ensures compatibility between ESM and CJS outputs
  shims: true,

  // Minify production builds (optional)
  minify: false,

  // Tree shaking
  treeshake: true,

  // Copy config files to dist
  // The runtime.yaml file must be available at config/runtime.yaml relative to package root
  // tsup doesn't have built-in file copying, so we rely on package.json "files" field
  // to include config/ directory in npm package

  // Banner for output files
  banner: {
    js: `/**
 * mlx-serving - TypeScript MLX serving engine for Apple Silicon
 * @license Apache-2.0
 * Copyright 2025 DEFAI Private Limited
 */`,
  },
});
