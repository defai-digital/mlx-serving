#!/usr/bin/env tsx
/**
 * Simple Engine Test - Phase 2 without MessagePack
 * Test if timeout issue is resolved with MessagePack disabled
 */

import { Engine } from '../src/index.js';

const MODEL = 'mlx-community/Qwen3-30B-A3B-4bit';
const QUESTIONS = [
  'What is the capital of France?',
  'Explain quantum computing.',
  'What are benefits of exercise?',
];
const MAX_TOKENS = 100;

async function main() {
  console.log('============================================================');
  console.log('Testing Engine with MessagePack DISABLED');
  console.log(`Model: ${MODEL}`);
  console.log('Questions: 3');
  console.log('============================================================\n');

  const engine = new Engine();

  try {
    console.log('Loading model...');
    const startLoad = Date.now();

    await engine.loadModel({
      model: MODEL,
    });

    const loadTime = (Date.now() - startLoad) / 1000;
    console.log(`✓ Model loaded in ${loadTime.toFixed(2)}s\n`);

    console.log('Generating responses...');
    const startGen = Date.now();
    let totalTokens = 0;

    for (let i = 0; i < QUESTIONS.length; i++) {
      console.log(`  Question ${i + 1}/${QUESTIONS.length}...`);
      let tokens = 0;

      const result = await engine.generate({
        model: MODEL,
        prompt: QUESTIONS[i],
        maxTokens: MAX_TOKENS,
        temperature: 0.7,
        streaming: false, // Use non-streaming to get full result
      });

      tokens = result.usage?.totalTokens || 0;

      totalTokens += tokens;
      console.log(`    ✓ Generated ${tokens} tokens`);
    }

    const genTime = (Date.now() - startGen) / 1000;
    const tokensPerSecond = totalTokens / genTime;

    console.log(`\n============================================================`);
    console.log(`✓ SUCCESS!`);
    console.log(`============================================================`);
    console.log(`Total tokens: ${totalTokens}`);
    console.log(`Time: ${genTime.toFixed(2)}s`);
    console.log(`Throughput: ${tokensPerSecond.toFixed(2)} tokens/second`);
    console.log(`============================================================\n`);

    await engine.unloadModel({ model: MODEL });

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ FAILED:`, error);
    process.exit(1);
  }
}

main();
