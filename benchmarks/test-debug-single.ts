/**
 * Single-request debug test with full logging
 */

import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';

const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 50;

async function main() {
  console.log('\nSingle Request Debug Test\n');

  // DEBUG level logging to see all logs
  const logger = pino({ level: 'debug' });
  const engine = new Engine({}, { logger });

  console.log('Loading model...');
  await engine.loadModel({ model: MODEL_PATH });
  console.log('Model loaded!\n');

  // Try request #2 (since request #1 works)
  const question = 'What is 3+3?';
  console.log(`Testing: ${question}\n`);

  try {
    let tokenCount = 0;
    let output = '';

    const generator = engine.createGenerator({
      model: MODEL_PATH,
      prompt: question,
      maxTokens: MAX_TOKENS,
      streaming: true,
    });

    console.log('Generator created, starting iteration...\n');

    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        tokenCount++;
        output += chunk.token;
        console.log(`  Token #${tokenCount}: "${chunk.token}"`);
      }
    }

    console.log(`\n✓ ${tokenCount} tokens: ${output.substring(0, 100)}...\n`);
  } catch (error) {
    console.log(`\n✗ ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  console.log('\nShutting down...');
  await engine.shutdown();
  console.log('Done!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
