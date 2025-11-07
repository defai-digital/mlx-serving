/**
 * Image Format Support Example
 *
 * Demonstrates different ways to provide images to vision models
 */

import { createEngine } from '../../src/api/engine.js';
import { readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  const engine = await createEngine();

  try {
    await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
    });

    // Example 1: File path
    console.log('=== From File Path ===');
    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'What is this?',
      image: { source: './assets/sample-image.jpg' },
      maxTokens: 50,
    })) {
      if (chunk.type === 'token') process.stdout.write(chunk.token || '');
    }
    console.log('\n');

    // Example 2: Buffer
    console.log('=== From Buffer ===');
    const imageBuffer = readFileSync('./assets/sample-image.jpg');
    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'Describe this.',
      image: { source: imageBuffer, format: 'jpg' },
      maxTokens: 50,
    })) {
      if (chunk.type === 'token') process.stdout.write(chunk.token || '');
    }
    console.log('\n');

    // Example 3: URL (if supported by image-encoding.ts)
    console.log('=== From URL ===');
    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'What do you see?',
      image: { source: 'https://example.com/image.jpg' },
      maxTokens: 50,
    })) {
      if (chunk.type === 'token') process.stdout.write(chunk.token || '');
    }
    console.log('\n');

  } finally {
    await engine.dispose();
  }
}

main().catch(console.error);
