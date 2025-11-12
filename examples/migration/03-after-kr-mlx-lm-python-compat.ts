#!/usr/bin/env tsx
/**
 * Example: Migrated code using kr-serve-mlx with Python-compatible API
 *
 * This shows how to use kr-serve-mlx with snake_case parameters for minimal
 * migration effort from mlx-engine. This API is fully supported but less
 * type-safe than the TypeScript-style API.
 */

import { createEngine } from '@defai.digital/mlx-serving';

async function main(): Promise<void> {
  // Create and start engine
  const engine = await createEngine();

  try {
    // Load model with snake_case parameters (Python style)
    // NOTE: This requires Config Normalizer (Phase 2) to be implemented
    const model = await engine.load_model({
      model: 'llama-3.1-8b-instruct',
      max_tokens: 512,        // snake_case (Python compatible)
      temperature: 0.7,
      top_p: 0.9,             // snake_case (Python compatible)
      repetition_penalty: 1.1 // snake_case (Python compatible)
    });

    console.log('Model loaded:', model.id);

    // Generate text with snake_case parameters
    console.log('Generating text...');
    for await (const chunk of engine.create_generator({
      model: 'llama-3.1-8b-instruct',
      prompt: 'Hello, how are you?',
      max_tokens: 100,  // snake_case (Python compatible)
      temperature: 0.7,
      stream: true
    })) {
      if (chunk.type === 'token') {
        process.stdout.write(chunk.token);
      }
    }

    console.log('\n\nTokenization example:');
    const result = await engine.tokenize({
      model: 'llama-3.1-8b-instruct',
      text: 'Hello, world!',
      add_bos: true  // snake_case (Python compatible)
    });
    console.log(`Tokens: ${result.tokens}`);
    console.log(`Token count: ${result.tokens.length}`);

  } finally {
    // Cleanup
    await engine.shutdown();
  }
}

main().catch(console.error);
