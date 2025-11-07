/**
 * Simple 10-request sequential test to debug stream cancellation issue
 */

import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';

const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 50;

const QUESTIONS = [
  'What is 2+2?',
  'What is 3+3?',
  'What is 4+4?',
  'What is 5+5?',
  'What is 6+6?',
  'What is 7+7?',
  'What is 8+8?',
  'What is 9+9?',
  'What is 10+10?',
  'What is 11+11?',
];

async function main() {
  console.log('\nSimple 10-request Sequential Test\n');

  const logger = pino({ level: 'info' }); // Show more logs
  const engine = new Engine({}, { logger });

  console.log('Loading model...');
  await engine.loadModel({ model: MODEL_PATH });
  console.log('Model loaded!\n');

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    console.log(`[${i + 1}/${QUESTIONS.length}] ${question}`);

    try {
      let tokenCount = 0;
      let output = '';

      const generator = engine.createGenerator({
        model: MODEL_PATH,
        prompt: question,
        maxTokens: MAX_TOKENS,
        streaming: true,
      });

      for await (const chunk of generator) {
        if (chunk.type === 'token') {
          tokenCount++;
          output += chunk.token;
        }
      }

      console.log(`  ✓ ${tokenCount} tokens: ${output.substring(0, 50)}...\n`);
    } catch (error) {
      console.log(`  ✗ ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('\nShutting down...');
  await engine.shutdown();
  console.log('Done!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
