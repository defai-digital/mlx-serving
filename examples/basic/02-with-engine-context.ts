/**
 * Example: Context Manager Style with withEngine()
 *
 * Demonstrates Python-style context manager behavior in TypeScript.
 * Automatically manages engine lifecycle with guaranteed cleanup.
 */

import { withEngine } from '@defai.digital/mlx-serving';

async function main() {
  console.log('=== Example 1: Basic Usage ===');

  // Equivalent to Python's: with MLXEngine() as engine:
  const result = await withEngine(async (engine) => {
    // Load model
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Generate text
    return await engine.generate({
      model: 'llama-3.2-3b-instruct',
      prompt: 'Hello, world!',
      maxTokens: 50,
    });
  });
  // Engine automatically disposed here ✓

  console.log('Generated text:', result);

  console.log('\n=== Example 2: Streaming with Auto-cleanup ===');

  await withEngine(async (engine) => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    console.log('Streaming response:');
    for await (const chunk of engine.createGenerator({
      model: 'llama-3.2-3b-instruct',
      prompt: 'Tell me a short story',
      maxTokens: 100,
    })) {
      if (chunk.type === 'token') {
        process.stdout.write(chunk.token);
      }
    }
    console.log('\n');
  });
  // Engine automatically cleaned up after streaming ✓

  console.log('\n=== Example 3: Error Handling ===');

  try {
    await withEngine(async (engine) => {
      // This will fail (invalid model)
      await engine.loadModel({ model: 'non-existent-model' });
    });
  } catch (error) {
    console.log('✓ Error handled gracefully');
    console.log('✓ Engine was still properly disposed');
  }

  console.log('\n=== Example 4: With Custom Options ===');

  const tokens = await withEngine(
    async (engine) => {
      await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

      const response = await engine.tokenize({
        model: 'llama-3.2-3b-instruct',
        text: 'Hello, world!',
      });

      return response.tokens;
    },
    {
      // Custom engine options
      cacheDir: './custom-cache',
    }
  );

  console.log('Token count:', tokens.length);
}

main().catch(console.error);
