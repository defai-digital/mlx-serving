#!/usr/bin/env tsx
/**
 * Example: Migrated code using kr-serve-mlx with TypeScript-style API
 *
 * This shows the recommended way to use kr-serve-mlx with camelCase parameters.
 * This is the most type-safe and ergonomic approach.
 */

import { createEngine } from '@knowrag/kr-serve-mlx';

async function main(): Promise<void> {
  // Create and start engine (factory pattern)
  const engine = await createEngine();

  try {
    // Load model with camelCase parameters (TypeScript style)
    const model = await engine.loadModel({
      model: 'llama-3.1-8b-instruct',
      maxTokens: 512,        // camelCase ✅
      temperature: 0.7,
      topP: 0.9,             // camelCase ✅
      repetitionPenalty: 1.1 // camelCase ✅
    });

    console.log('Model loaded:', model.id);

    // Generate text with camelCase parameters
    console.log('Generating text...');
    for await (const chunk of engine.createGenerator({
      model: 'llama-3.1-8b-instruct',
      prompt: 'Hello, how are you?',
      maxTokens: 100,  // camelCase ✅
      temperature: 0.7,
      streaming: true
    })) {
      if (chunk.type === 'token') {
        process.stdout.write(chunk.token);
      }
    }

    console.log('\n\nTokenization example:');
    const result = await engine.tokenize({
      model: 'llama-3.1-8b-instruct',
      text: 'Hello, world!',
      addBos: true  // camelCase ✅
    });
    console.log(`Tokens: ${result.tokens}`);
    console.log(`Token count: ${result.tokens.length}`);

  } finally {
    // Cleanup
    await engine.shutdown();
  }
}

main().catch(console.error);
