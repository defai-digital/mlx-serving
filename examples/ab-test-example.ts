#!/usr/bin/env tsx
/**
 * A/B Test Example
 *
 * Demonstrates how to use the A/B testing framework to compare
 * baseline and variant engines with statistical validation.
 *
 * Usage:
 *   tsx examples/ab-test-example.ts
 */

import { createEngine } from '../dist/index.js';
import {
  ABTestRunner,
  createTestWorkload,
  saveTestResults,
  type ABTestConfig,
} from '../dist/testing/index.js';

async function main() {
  console.log('A/B Test Example - Statistical Validation\n');

  // Sample prompts for testing
  const prompts = [
    'What is the capital of France?',
    'Explain quantum computing in simple terms.',
    'Write a haiku about technology.',
    'What are the benefits of TypeScript?',
    'How does machine learning work?',
    'Describe the solar system.',
    'What is artificial intelligence?',
    'Explain the concept of recursion.',
    'What are the principles of OOP?',
    'How does the internet work?',
    'What is blockchain technology?',
    'Explain neural networks.',
    'What is cloud computing?',
    'Describe REST API design.',
    'What is containerization?',
    'Explain microservices architecture.',
    'What is continuous integration?',
    'Describe version control with Git.',
    'What is test-driven development?',
    'Explain agile methodology.',
    'What is DevOps?',
    'Describe database normalization.',
    'What is encryption?',
    'Explain OAuth 2.0.',
    'What is GraphQL?',
    'Describe serverless computing.',
    'What is edge computing?',
    'Explain data structures.',
    'What are design patterns?',
    'Describe functional programming.',
  ];

  // Create test workload (30 test cases for minimum sample size)
  const testWorkload = createTestWorkload('mlx-community/Qwen2.5-7B-Instruct-4bit', prompts, {
    maxTokens: 50,
    temperature: 0.7,
  });

  console.log(`Created test workload with ${testWorkload.length} test cases\n`);

  // Initialize engines
  console.log('Initializing engines...');
  const baselineEngine = await createEngine();
  const variantEngine = await createEngine();

  // Load models
  console.log('Loading models...');
  await baselineEngine.loadModel({
    model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  });
  await variantEngine.loadModel({
    model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  });

  console.log('Models loaded successfully\n');

  // Configure A/B test
  const config: ABTestConfig = {
    baselineEngine,
    variantEngine,
    testWorkload,
    minSampleSize: 30,
    confidenceLevel: 0.95,
    alpha: 0.05,
    concurrent: false, // Sequential for fair comparison
    warmupRuns: 3,
    timeoutMs: 30000,
    verbose: true,
  };

  // Run A/B test
  const runner = new ABTestRunner(config);
  const results = await runner.run();

  // Save results to file
  const outputPath = 'automatosx/tmp/ab-test-results.json';
  await saveTestResults(outputPath, results);
  console.log(`\nResults saved to: ${outputPath}`);

  // Print decision summary
  console.log('\n' + '='.repeat(80));
  console.log('DECISION SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nRecommendation: ${results.decision.recommendation.toUpperCase()}`);
  console.log(`Confidence level: ${(results.decision.confidenceLevel * 100).toFixed(1)}%`);
  console.log('\nAnalysis:');
  for (const reason of results.decision.reasons) {
    console.log(`  ${reason}`);
  }
  console.log('\n' + '='.repeat(80));

  // Cleanup
  await baselineEngine.shutdown();
  await variantEngine.shutdown();

  console.log('\nTest complete!');
}

main().catch((error) => {
  console.error('Error running A/B test:', error);
  process.exit(1);
});
