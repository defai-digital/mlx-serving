#!/usr/bin/env tsx
/**
 * Comprehensive benchmark suite for v0.11.0 release
 * Tests 4 models × 3 runs × 2 engines = 24 total benchmarks
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface BenchmarkResult {
  model: string;
  run: number;
  engine: string;
  throughput: number;
  totalTime: number;
  modelLoadTime: number;
  successRate: number;
}

const MODELS = [
  { name: 'Gemma 2 27B', id: 'mlx-community/gemma-2-27b-it-4bit' },
  { name: 'Llama 3.2 3B', id: 'mlx-community/Llama-3.2-3B-Instruct-4bit' },
  { name: 'Llama 3.1 70B', id: 'mlx-community/Meta-Llama-3.1-70B-Instruct-4bit' },
  { name: 'Qwen 3 30B', id: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit' },
];

const QUESTIONS = 100;
const RUNS_PER_MODEL = 3;
const OUTPUT_DIR = 'results/comprehensive';

async function runBenchmark(
  modelId: string,
  modelName: string,
  run: number
): Promise<{ serving: BenchmarkResult; engine: BenchmarkResult }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${modelName} - Run ${run}/3`);
  console.log(`${'='.repeat(60)}\n`);

  const outputPath = path.join(
    OUTPUT_DIR,
    `${modelName.replace(/\s+/g, '_')}_run${run}.json`
  );

  try {
    // Run benchmark
    execSync(
      `npx tsx benchmarks/flexible-benchmark.ts --model "${modelId}" --questions ${QUESTIONS} --compare both --max-tokens 100 --output "${outputPath}"`,
      { stdio: 'inherit', timeout: 600000 }
    );

    // Read results
    const results = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

    return {
      serving: {
        model: modelName,
        run,
        engine: 'mlx-serving',
        throughput: results.mlxServing.totalTokens / (results.mlxServing.totalTimeMs / 1000),
        totalTime: results.mlxServing.totalTimeMs / 1000,
        modelLoadTime: results.mlxServing.modelLoadTimeMs / 1000,
        successRate: (results.mlxServing.completed / (results.mlxServing.completed + results.mlxServing.failed)) * 100,
      },
      engine: {
        model: modelName,
        run,
        engine: 'mlx-engine',
        throughput: results.mlxEngine.totalTokens / (results.mlxEngine.totalTimeMs / 1000),
        totalTime: results.mlxEngine.totalTimeMs / 1000,
        modelLoadTime: results.mlxEngine.modelLoadTimeMs / 1000,
        successRate: (results.mlxEngine.completed / (results.mlxEngine.completed + results.mlxEngine.failed)) * 100,
      },
    };
  } catch (error) {
    console.error(`Benchmark failed for ${modelName} run ${run}:`, error);
    throw error;
  }
}

function calculateAverage(results: BenchmarkResult[]): {
  throughput: number;
  totalTime: number;
  modelLoadTime: number;
  successRate: number;
} {
  return {
    throughput: results.reduce((sum, r) => sum + r.throughput, 0) / results.length,
    totalTime: results.reduce((sum, r) => sum + r.totalTime, 0) / results.length,
    modelLoadTime: results.reduce((sum, r) => sum + r.modelLoadTime, 0) / results.length,
    successRate: results.reduce((sum, r) => sum + r.successRate, 0) / results.length,
  };
}

function printResultsTable(allResults: BenchmarkResult[]): void {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              v0.11.0-alpha.1 COMPREHENSIVE BENCHMARK RESULTS                   ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Group by model
  const byModel = new Map<string, BenchmarkResult[]>();
  for (const result of allResults) {
    if (!byModel.has(result.model)) {
      byModel.set(result.model, []);
    }
    byModel.get(result.model)!.push(result);
  }

  console.log('┌────────────────────┬─────────────┬───────────────┬──────────────┬──────────┬─────────────┐');
  console.log('│ Model              │ Engine      │ Throughput    │ Total Time   │ Load Time│ Success     │');
  console.log('│                    │             │ (tok/s)       │ (seconds)    │ (seconds)│ Rate        │');
  console.log('├────────────────────┼─────────────┼───────────────┼──────────────┼──────────┼─────────────┤');

  for (const [modelName, results] of byModel) {
    const servingResults = results.filter((r) => r.engine === 'mlx-serving');
    const engineResults = results.filter((r) => r.engine === 'mlx-engine');

    const servingAvg = calculateAverage(servingResults);
    const engineAvg = calculateAverage(engineResults);

    const speedup = ((servingAvg.throughput / engineAvg.throughput - 1) * 100).toFixed(2);

    // MLX-Serving row
    console.log(
      `│ ${modelName.padEnd(18)} │ mlx-serving │ ${servingAvg.throughput.toFixed(2).padStart(13)} │ ${servingAvg.totalTime.toFixed(2).padStart(12)} │ ${servingAvg.modelLoadTime.toFixed(2).padStart(8)} │ ${servingAvg.successRate.toFixed(0).padStart(6)}%     │`
    );

    // MLX-Engine row
    console.log(
      `│ ${' '.repeat(18)} │ mlx-engine  │ ${engineAvg.throughput.toFixed(2).padStart(13)} │ ${engineAvg.totalTime.toFixed(2).padStart(12)} │ ${engineAvg.modelLoadTime.toFixed(2).padStart(8)} │ ${engineAvg.successRate.toFixed(0).padStart(6)}%     │`
    );

    // Speedup row
    console.log(
      `│ ${' '.repeat(18)} │ Speedup     │ ${(speedup.startsWith('-') ? '' : '+') + speedup}%${' '.repeat(8)} │              │          │             │`
    );
    console.log('├────────────────────┼─────────────┼───────────────┼──────────────┼──────────┼─────────────┤');
  }

  console.log('└────────────────────┴─────────────┴───────────────┴──────────────┴──────────┴─────────────┘');
  console.log('');
  console.log('Configuration: 100 questions × 100 max tokens × 3 runs (averaged)');
  console.log('Platform: Apple M3 Max, 128GB RAM, macOS 26.0');
  console.log('');
}

async function main() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allResults: BenchmarkResult[] = [];

  const startTime = Date.now();

  for (const model of MODELS) {
    for (let run = 1; run <= RUNS_PER_MODEL; run++) {
      try {
        const { serving, engine } = await runBenchmark(model.id, model.name, run);
        allResults.push(serving, engine);

        // Save intermediate results
        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'intermediate-results.json'),
          JSON.stringify(allResults, null, 2)
        );
      } catch (error) {
        console.error(`Failed to run benchmark for ${model.name} run ${run}`);
        // Continue with next benchmark
      }
    }
  }

  const elapsedTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  // Print final results table
  printResultsTable(allResults);

  console.log(`Total benchmark time: ${elapsedTime} minutes`);
  console.log(`\nResults saved to: ${OUTPUT_DIR}/`);

  // Save final results
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'final-results.json'),
    JSON.stringify(allResults, null, 2)
  );
}

main().catch(console.error);
