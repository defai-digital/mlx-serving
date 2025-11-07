/**
 * Basic Vision Question Answering Example
 *
 * Demonstrates how to use vision-language models for image analysis
 */

import { createEngine } from '../../src/api/engine.js';
import { readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  console.log('Loading kr-mlx-lm engine...');
  const engine = await createEngine();

  try {
    // 1. Load vision model
    console.log('\nLoading LLaVA vision model...');
    const visionModel = await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
      revision: 'main',
      // Optional: Use quantization for faster inference
      // quantization: { bits: 4 }
    });

    console.log('Vision model loaded successfully!');
    console.log('Model info:', {
      id: visionModel.descriptor.id,
      modality: visionModel.descriptor.modality,
      contextLength: visionModel.contextLength,
      processorType: visionModel.metadata.processorType,
    });

    // 2. Load test image
    const imagePath = join(__dirname, 'assets', 'sample-image.jpg');
    console.log(`\nAnalyzing image: ${imagePath}`);

    // 3. Generate description
    console.log('\nGenerating description...\n');
    console.log('AI: ');

    let tokenCount = 0;
    const startTime = Date.now();

    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'Describe this image in detail. What objects, people, or scenes do you see?',
      image: { source: imagePath },
      maxTokens: 200,
      temperature: 0.7,
    })) {
      if (chunk.type === 'token' && chunk.token) {
        process.stdout.write(chunk.token);
        tokenCount++;
      } else if (chunk.type === 'metadata' && chunk.stats) {
        const elapsed = Date.now() - startTime;
        console.log('\n\n=== Generation Statistics ===');
        console.log(`Tokens generated: ${chunk.stats.tokensGenerated}`);
        console.log(`Tokens/second: ${chunk.stats.tokensPerSecond.toFixed(2)}`);
        console.log(`Time to first token: ${chunk.stats.timeToFirstToken.toFixed(0)}ms`);
        console.log(`Total time: ${elapsed.toFixed(0)}ms`);
      }
    }

    // 4. Ask follow-up question
    console.log('\n\n--- Follow-up Question ---\n');
    console.log('AI: ');

    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'What colors are dominant in this image?',
      image: { source: imagePath },
      maxTokens: 100,
    })) {
      if (chunk.type === 'token' && chunk.token) {
        process.stdout.write(chunk.token);
      }
    }

    console.log('\n');

  } finally {
    console.log('\nShutting down engine...');
    await engine.dispose();
    console.log('Done!');
  }
}

main().catch(console.error);
