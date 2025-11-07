/**
 * Two-request debug test to reproduce the bug
 */

import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';

const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 50;

async function testRequest(engine: Engine, questionNum: number, question: string) {
  console.log(`\n[${questionNum}] Testing: ${question}\n`);

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
      }
    }

    console.log(`✓ ${tokenCount} tokens: ${output.substring(0, 50)}...\n`);
  } catch (error) {
    console.log(`✗ ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function main() {
  console.log('\nTwo Requests Debug Test\n');

  // DEBUG level logging
  const logger = pino({ level: 'debug' });
  const engine = new Engine({}, { logger });

  console.log('Loading model...');
  await engine.loadModel({ model: MODEL_PATH });
  console.log('Model loaded!\n');

  // Request #1
  await testRequest(engine, 1, 'What is 2+2?');

  // Small delay
  await new Promise(resolve => setTimeout(resolve, 100));

  // Request #2 - this should reproduce the bug
  await testRequest(engine, 2, 'What is 3+3?');

  console.log('\nShutting down...');
  await engine.shutdown();
  console.log('Done!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
