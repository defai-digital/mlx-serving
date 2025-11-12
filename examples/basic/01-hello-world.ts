/**
 * Example 1: Hello World
 * Simplest possible example of using kr-serve-mlx
 */

import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  console.log('🚀 Starting kr-serve-mlx Hello World example\n');

  // Create engine instance
  const engine = await createEngine();
  console.log('✅ Engine created\n');

  // Load model
  console.log('📦 Loading model...');
  await engine.loadModel({
    model: 'meta-llama/Llama-3.2-1B-Instruct',
  });
  console.log('✅ Model loaded\n');

  // Generate text
  console.log('💬 Generating response:\n');
  console.log('User: Hello! How are you?\n');
  console.log('Assistant: ');

  for await (const chunk of engine.createGenerator({
    model: 'meta-llama/Llama-3.2-1B-Instruct',
    prompt: 'Hello! How are you?',
    maxTokens: 50,
    temperature: 0.7,
  })) {
    if (chunk.type === 'token') {
      process.stdout.write(chunk.token);
    } else if (chunk.type === 'metadata') {
      console.log(`\n\n📊 Stats: ${chunk.stats.tokensPerSecond.toFixed(2)} tokens/sec`);
    }
  }

  // Clean up
  console.log('\n\n🧹 Cleaning up...');
  await engine.dispose();
  console.log('✅ Done!');
}

main().catch(console.error);
