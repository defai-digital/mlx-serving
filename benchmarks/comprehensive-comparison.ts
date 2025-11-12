#!/usr/bin/env tsx
/**
 * Comprehensive Benchmark Comparison
 *
 * Compares mlx-serving vs mlx-engine across multiple models
 * with multiple iterations and statistical analysis
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface BenchmarkResult {
  model: string;
  engine: string;
  iteration: number;
  throughput: number;
  ttft: number;
  totalTime: number;
  successRate: number;
}

interface AggregatedResults {
  model: string;
  engine: string;
  avgThroughput: number;
  avgTTFT: number;
  avgTotalTime: number;
  avgSuccessRate: number;
  stdDevThroughput: number;
  iterations: number;
}

const MODELS = [
  {
    name: 'Llama 3.1 70B',
    id: 'mlx-community/Meta-Llama-3.1-70B-Instruct-4bit',
  },
  {
    name: 'Qwen 3 30B',
    id: 'mlx-community/Qwen2.5-32B-Instruct-4bit',
  },
];

const ENGINES = ['mlx-serving', 'mlx-engine'];
const ITERATIONS = 3;
const QUESTIONS = 100;
const MAX_TOKENS = 100;

const results: BenchmarkResult[] = [];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Comprehensive Benchmark: mlx-serving vs mlx-engine     ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

console.log(`Configuration:`);
console.log(`  Models: ${MODELS.map((m) => m.name).join(', ')}`);
console.log(`  Engines: ${ENGINES.join(', ')}`);
console.log(`  Questions per run: ${QUESTIONS}`);
console.log(`  Max tokens: ${MAX_TOKENS}`);
console.log(`  Iterations per combination: ${ITERATIONS}`);
console.log(`  Total benchmarks: ${MODELS.length * ENGINES.length * ITERATIONS}\n`);

let totalCompleted = 0;
const totalBenchmarks = MODELS.length * ENGINES.length * ITERATIONS;

for (const model of MODELS) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`MODEL: ${model.name}`);
  console.log(`${'='.repeat(80)}\n`);

  for (const engine of ENGINES) {
    console.log(`\n${'-'.repeat(60)}`);
    console.log(`Engine: ${engine}`);
    console.log(`${'-'.repeat(60)}\n`);

    for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
      totalCompleted++;
      const progress = ((totalCompleted / totalBenchmarks) * 100).toFixed(1);

      console.log(`[${totalCompleted}/${totalBenchmarks} - ${progress}%] Running iteration ${iteration}/${ITERATIONS}...`);

      const outputFile = path.join(
        __dirname,
        '..',
        'results',
        'comparison',
        `${model.name.replace(/\s+/g, '-').toLowerCase()}-${engine}-iter${iteration}.json`
      );

      // Ensure output directory exists
      const outputDir = path.dirname(outputFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      try {
        const command = `npx tsx ${path.join(__dirname, 'flexible-benchmark.ts')} \
          --model "${model.id}" \
          --questions ${QUESTIONS} \
          --max-tokens ${MAX_TOKENS} \
          --compare ${engine} \
          --output "${outputFile}"`;

        console.log(`  Command: ${command.substring(0, 100)}...`);
        console.log(`  Starting at ${new Date().toISOString()}`);

        const startTime = Date.now();
        execSync(command, {
          stdio: 'inherit',
          cwd: path.join(__dirname, '..'),
          timeout: 1800000, // 30 minutes max per benchmark
        });
        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000 / 60).toFixed(1);

        console.log(`  ✅ Completed in ${duration} minutes`);

        // Parse results
        if (fs.existsSync(outputFile)) {
          const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));

          // Extract metrics based on engine
          let throughput = 0;
          let ttft = 0;
          let totalTime = 0;
          let successRate = 1.0;

          if (engine === 'mlx-serving') {
            throughput = data.mlxServing?.metrics?.avgThroughput || 0;
            ttft = data.mlxServing?.metrics?.avgTTFT || 0;
            totalTime = data.mlxServing?.totalTime || 0;
            successRate = data.mlxServing?.successRate || 1.0;
          } else {
            throughput = data.mlxEngine?.metrics?.avgThroughput || 0;
            ttft = data.mlxEngine?.metrics?.avgTTFT || 0;
            totalTime = data.mlxEngine?.totalTime || 0;
            successRate = data.mlxEngine?.successRate || 1.0;
          }

          results.push({
            model: model.name,
            engine,
            iteration,
            throughput,
            ttft,
            totalTime,
            successRate,
          });

          console.log(`  📊 Results: ${throughput.toFixed(2)} tok/s, TTFT: ${ttft.toFixed(0)}ms\n`);
        }
      } catch (error) {
        console.error(`  ❌ Failed: ${error instanceof Error ? error.message : String(error)}\n`);
        // Record failure but continue
        results.push({
          model: model.name,
          engine,
          iteration,
          throughput: 0,
          ttft: 0,
          totalTime: 0,
          successRate: 0,
        });
      }
    }
  }
}

// Calculate aggregated statistics
console.log('\n\n' + '='.repeat(80));
console.log('AGGREGATING RESULTS');
console.log('='.repeat(80) + '\n');

const aggregated: AggregatedResults[] = [];

for (const model of MODELS) {
  for (const engine of ENGINES) {
    const engineResults = results.filter((r) => r.model === model.name && r.engine === engine);

    if (engineResults.length === 0) continue;

    const throughputs = engineResults.map((r) => r.throughput);
    const ttfts = engineResults.map((r) => r.ttft);
    const totalTimes = engineResults.map((r) => r.totalTime);
    const successRates = engineResults.map((r) => r.successRate);

    const avgThroughput = throughputs.reduce((sum, v) => sum + v, 0) / throughputs.length;
    const avgTTFT = ttfts.reduce((sum, v) => sum + v, 0) / ttfts.length;
    const avgTotalTime = totalTimes.reduce((sum, v) => sum + v, 0) / totalTimes.length;
    const avgSuccessRate = successRates.reduce((sum, v) => sum + v, 0) / successRates.length;

    // Calculate standard deviation for throughput
    const variance = throughputs.reduce((sum, v) => sum + Math.pow(v - avgThroughput, 2), 0) / throughputs.length;
    const stdDevThroughput = Math.sqrt(variance);

    aggregated.push({
      model: model.name,
      engine,
      avgThroughput,
      avgTTFT,
      avgTotalTime,
      avgSuccessRate,
      stdDevThroughput,
      iterations: engineResults.length,
    });
  }
}

// Print results table
console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('║                            BENCHMARK RESULTS                                 ║');
console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

console.log('┌─────────────────┬───────────────┬──────────────┬────────────┬──────────────┬───────────┐');
console.log('│ Model           │ Engine        │ Throughput   │ Std Dev    │ TTFT         │ Success   │');
console.log('│                 │               │ (tok/s)      │ (tok/s)    │ (ms)         │ Rate      │');
console.log('├─────────────────┼───────────────┼──────────────┼────────────┼──────────────┼───────────┤');

for (const model of MODELS) {
  const modelResults = aggregated.filter((r) => r.model === model.name);

  for (let i = 0; i < modelResults.length; i++) {
    const result = modelResults[i];
    const modelName = i === 0 ? model.name.padEnd(15) : ' '.repeat(15);
    const engine = result.engine.padEnd(13);
    const throughput = result.avgThroughput.toFixed(2).padStart(12);
    const stdDev = result.stdDevThroughput.toFixed(2).padStart(10);
    const ttft = result.avgTTFT.toFixed(0).padStart(12);
    const successRate = (result.avgSuccessRate * 100).toFixed(1).padStart(9);

    console.log(`│ ${modelName} │ ${engine} │ ${throughput} │ ${stdDev} │ ${ttft} │ ${successRate}% │`);
  }

  if (model !== MODELS[MODELS.length - 1]) {
    console.log('├─────────────────┼───────────────┼──────────────┼────────────┼──────────────┼───────────┤');
  }
}

console.log('└─────────────────┴───────────────┴──────────────┴────────────┴──────────────┴───────────┘\n');

// Calculate and print performance comparison
console.log('Performance Comparison:\n');

for (const model of MODELS) {
  const servingResult = aggregated.find((r) => r.model === model.name && r.engine === 'mlx-serving');
  const engineResult = aggregated.find((r) => r.model === model.name && r.engine === 'mlx-engine');

  if (servingResult && engineResult) {
    const throughputDiff = ((servingResult.avgThroughput / engineResult.avgThroughput - 1) * 100).toFixed(2);
    const ttftDiff = ((servingResult.avgTTFT / engineResult.avgTTFT - 1) * 100).toFixed(2);

    console.log(`${model.name}:`);
    console.log(`  Throughput: mlx-serving is ${throughputDiff}% ${Number(throughputDiff) >= 0 ? 'faster' : 'slower'} than mlx-engine`);
    console.log(`  TTFT: mlx-serving is ${ttftDiff}% ${Number(ttftDiff) >= 0 ? 'slower' : 'faster'} than mlx-engine`);
    console.log('');
  }
}

// Save aggregated results
const summaryFile = path.join(__dirname, '..', 'results', 'comparison', 'summary.json');
fs.writeFileSync(summaryFile, JSON.stringify({ aggregated, raw: results }, null, 2));
console.log(`\n✅ Results saved to ${summaryFile}`);

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║           BENCHMARK SUITE COMPLETED                      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
