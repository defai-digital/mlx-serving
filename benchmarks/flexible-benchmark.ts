#!/usr/bin/env tsx
/**
 * Flexible Benchmark Tool for mlx-serving vs mlx-engine
 *
 * CLI tool for benchmarking any MLX model with customizable parameters:
 * - Model selection (any HuggingFace MLX model)
 * - Question count (1-10000+)
 * - Comparison mode (mlx-serving, mlx-engine, or both)
 * - Custom temperature, max tokens, etc.
 *
 * Usage:
 *   tsx benchmarks/flexible-benchmark.ts \
 *     --model "mlx-community/gemma-2-27b-it-4bit" \
 *     --questions 200 \
 *     --compare both \
 *     --output results/gemma-27b-200q.json
 *
 * Examples:
 *   # Quick test
 *   tsx benchmarks/flexible-benchmark.ts --model llama-3.2-3b-instruct-4bit --questions 10
 *
 *   # Full benchmark comparison
 *   tsx benchmarks/flexible-benchmark.ts --model gemma-2-27b-it-4bit --questions 200 --compare both
 *
 *   # mlx-serving only with custom params
 *   tsx benchmarks/flexible-benchmark.ts --model qwen-2.5-7b-4bit --questions 100 --max-tokens 200 --temp 0.8
 */

import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createEngine } from '../dist/index.js';
import {
  calculateStatistics,
  formatNumber,
  formatDuration,
  getSystemInfo,
  createProgressBar,
} from './utils.js';

// =============================================================================
// Types
// =============================================================================

interface BenchmarkConfig {
  model: string;
  modelPath?: string;
  questionCount: number;
  maxTokens: number;
  temperature: number;
  topP?: number;
  seed?: number;
  compareMode: 'mlx-serving' | 'mlx-engine' | 'both';
  outputPath?: string;
  verbose: boolean;
  sequential: boolean; // true = sequential, false = concurrent
}

interface QuestionResult {
  questionIndex: number;
  question: string;
  ttftMs: number;
  latencyMs: number;
  tokens: number;
  tokensPerSec: number;
  output: string;
  success: boolean;
  error?: string;
}

interface EngineResults {
  engineName: string;
  modelId: string;
  modelLoadTimeMs: number;
  totalTimeMs: number;
  totalTokens: number;
  completed: number;
  failed: number;
  questions: QuestionResult[];
  statistics: {
    latency: ReturnType<typeof calculateStatistics>;
    ttft: ReturnType<typeof calculateStatistics>;
    tokensPerSec: ReturnType<typeof calculateStatistics>;
    tokensPerRequest: ReturnType<typeof calculateStatistics>;
  };
}

interface BenchmarkReport {
  config: BenchmarkConfig;
  timestamp: string;
  systemInfo: ReturnType<typeof getSystemInfo>;
  mlxServing?: EngineResults;
  mlxEngine?: EngineResults;
  comparison?: {
    speedup: number; // mlx-serving throughput / mlx-engine throughput
    ttftSpeedup: number;
    latencySpeedup: number;
    winner: 'mlx-serving' | 'mlx-engine' | 'tie';
  };
}

// =============================================================================
// Question Generation
// =============================================================================

/**
 * Format prompt with Gemma 2 chat template
 * Gemma 2 models require specific chat formatting to generate proper responses
 * Format: <bos><start_of_turn>user\n{question}<end_of_turn>\n<start_of_turn>model\n
 */
function formatChatPrompt(question: string, modelId: string): string {
  // Check if this is a Gemma 2 model
  if (modelId.toLowerCase().includes('gemma-2') || modelId.toLowerCase().includes('gemma2')) {
    return `<bos><start_of_turn>user\n${question}<end_of_turn>\n<start_of_turn>model\n`;
  }

  // For other models, return raw question
  return question;
}

/**
 * Generate diverse questions for benchmarking
 */
function generateQuestions(count: number): string[] {
  const templates = [
    // Factual questions
    'What is {}?',
    'Explain {} in simple terms.',
    'Describe the key features of {}.',
    'What are the benefits of using {}?',
    'How does {} work?',
    'What are common applications of {}?',
    'Compare {} with traditional approaches.',
    'What is the history of {}?',
    'What are common misconceptions about {}?',
    'How can someone learn {}?',

    // Creative prompts
    'Write a short poem about {}.',
    'Create a story involving {}.',
    'Describe {} from the perspective of a child.',
    'Explain {} using an analogy.',
    'Write a haiku about {}.',

    // Technical questions
    'What are the technical challenges of {}?',
    'How is {} implemented?',
    'What algorithms are used in {}?',
    'What are the limitations of {}?',
    'How can {} be optimized?',

    // Practical questions
    'How do I get started with {}?',
    'What tools are needed for {}?',
    'What are best practices for {}?',
    'What problems does {} solve?',
    'When should I use {}?',
  ];

  const topics = [
    // Technology
    'quantum computing', 'artificial intelligence', 'machine learning',
    'deep learning', 'neural networks', 'natural language processing',
    'computer vision', 'reinforcement learning', 'blockchain', 'cryptography',
    'cloud computing', 'edge computing', 'distributed systems', 'microservices',
    'containerization', 'kubernetes', 'serverless computing', 'DevOps',
    'continuous integration', 'test-driven development',

    // Science
    'quantum mechanics', 'relativity theory', 'string theory', 'dark matter',
    'black holes', 'exoplanets', 'astrobiology', 'genetics', 'CRISPR',
    'biotechnology', 'nanotechnology', 'materials science', 'chemistry',
    'physics', 'astronomy', 'cosmology', 'particle physics',

    // Energy & Environment
    'renewable energy', 'solar power', 'wind energy', 'hydroelectric power',
    'geothermal energy', 'nuclear fusion', 'battery technology', 'electric vehicles',
    'climate change', 'carbon capture', 'sustainable agriculture', 'recycling',
    'green architecture', 'conservation', 'biodiversity', 'ocean cleanup',

    // Data & Analytics
    'data science', 'big data', 'data visualization', 'statistical analysis',
    'predictive modeling', 'data mining', 'business intelligence', 'analytics',
    'time series analysis', 'regression analysis', 'clustering algorithms',

    // Security & Privacy
    'cybersecurity', 'encryption', 'zero-knowledge proofs', 'privacy-preserving ML',
    'secure multi-party computation', 'differential privacy', 'threat modeling',
    'vulnerability assessment', 'penetration testing', 'security auditing',

    // Emerging Tech
    'augmented reality', 'virtual reality', 'mixed reality', 'metaverse',
    'brain-computer interfaces', 'biometric authentication', 'smart cities',
    'Internet of Things', 'autonomous vehicles', '5G networks', '6G technology',
    'quantum internet', 'neuromorphic computing', 'DNA computing',
  ];

  const questions: string[] = [];
  let topicIndex = 0;
  let templateIndex = 0;

  for (let i = 0; i < count; i++) {
    const template = templates[templateIndex % templates.length];
    const topic = topics[topicIndex % topics.length];
    questions.push(template.replace('{}', topic));

    topicIndex++;
    if (topicIndex % topics.length === 0) {
      templateIndex++;
    }
  }

  return questions;
}

// =============================================================================
// mlx-serving Benchmark
// =============================================================================

async function benchmarkMLXServing(
  config: BenchmarkConfig,
  questions: string[]
): Promise<EngineResults> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Benchmarking mlx-serving');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const engine = await createEngine({
    telemetry: { enabled: false },
    rpcTimeout: 300000, // 5 minutes for large models like Gemma 27B
  });

  try {
    // Load model
    console.log(`Loading model: ${config.model}...`);
    const loadStart = Date.now();
    await engine.loadModel({
      model: config.model,
      maxTokens: config.maxTokens,
    });
    const modelLoadTimeMs = Date.now() - loadStart;
    console.log(`✓ Model loaded in ${formatDuration(modelLoadTimeMs)}\n`);

    // Run benchmark
    const startTime = Date.now();
    const results: QuestionResult[] = [];
    let totalTokens = 0;
    let completed = 0;
    let failed = 0;

    console.log(`Running ${questions.length} questions...\n`);

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      const requestStart = Date.now();
      let firstTokenTime: number | null = null;
      let tokenCount = 0;
      let output = '';
      let success = false;
      let error: string | undefined;

      try {
        // Send raw question - chat template formatting is now handled automatically
        // by the Python runtime using tokenizer.apply_chat_template() for correct formatting
        for await (const chunk of engine.createGenerator({
          model: config.model,
          prompt: question,  // Raw question - template applied in Python
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          topP: config.topP,
        })) {
          if (chunk.type === 'token') {
            // Filter out padding tokens (<pad>, token_id 0)
            if (chunk.token === '<pad>' || chunk.token.trim() === '') {
              continue;
            }

            if (firstTokenTime === null) {
              firstTokenTime = Date.now() - requestStart;
            }
            output += chunk.token;
            tokenCount++;
          }
        }

        const latencyMs = Date.now() - requestStart;
        const tokensPerSec = latencyMs > 0 ? (tokenCount / latencyMs) * 1000 : 0;

        results.push({
          questionIndex: i,
          question,
          ttftMs: firstTokenTime || 0,
          latencyMs,
          tokens: tokenCount,
          tokensPerSec,
          output,
          success: true,
        });

        totalTokens += tokenCount;
        completed++;
        success = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        results.push({
          questionIndex: i,
          question,
          ttftMs: 0,
          latencyMs: Date.now() - requestStart,
          tokens: 0,
          tokensPerSec: 0,
          output: '',
          success: false,
          error,
        });
        failed++;
        if (config.verbose) {
          console.error(`✗ Question ${i + 1} failed: ${error}`);
        }
      }

      // Progress update
      if ((i + 1) % Math.max(1, Math.floor(questions.length / 10)) === 0 || i === questions.length - 1) {
        console.log(createProgressBar(i + 1, questions.length));
      }
    }

    const totalTimeMs = Date.now() - startTime;

    console.log(`\n✓ Completed ${completed}/${questions.length} requests`);
    if (failed > 0) {
      console.log(`✗ Failed: ${failed} requests`);
    }

    // Calculate statistics
    const successfulResults = results.filter((r) => r.success);
    const latencies = successfulResults.map((r) => r.latencyMs);
    const ttfts = successfulResults.map((r) => r.ttftMs);
    const throughputs = successfulResults.map((r) => r.tokensPerSec);
    const tokenCounts = successfulResults.map((r) => r.tokens);

    const statistics = {
      latency: calculateStatistics(latencies.length > 0 ? latencies : [0]),
      ttft: calculateStatistics(ttfts.length > 0 ? ttfts : [0]),
      tokensPerSec: calculateStatistics(throughputs.length > 0 ? throughputs : [0]),
      tokensPerRequest: calculateStatistics(tokenCounts.length > 0 ? tokenCounts : [0]),
    };

    return {
      engineName: 'mlx-serving',
      modelId: config.model,
      modelLoadTimeMs,
      totalTimeMs,
      totalTokens,
      completed,
      failed,
      questions: results,
      statistics,
    };
  } finally {
    await engine.dispose();
  }
}

// =============================================================================
// mlx-engine Benchmark (Python)
// =============================================================================

async function benchmarkMLXEngine(
  config: BenchmarkConfig,
  questions: string[]
): Promise<EngineResults> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔧 Benchmarking mlx-engine (Python)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Create Python benchmark script
  const pythonScript = `
import sys
import json
import time
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

# Configuration
model_id = "${config.model}"
max_tokens = ${config.maxTokens}
temperature = ${config.temperature}
top_p = ${config.topP || 1.0}
questions = ${JSON.stringify(questions)}

# Format prompt with tokenizer's chat template (recommended approach)
def format_chat_prompt(question, model_id, tokenizer):
    """Format prompt using tokenizer.apply_chat_template for proper generation.
    This is the recommended approach as it uses the model's built-in chat template
    and avoids subtle spacing/whitespace issues that can cause padding token loops.
    """
    if 'gemma-2' in model_id.lower() or 'gemma2' in model_id.lower():
        # Use tokenizer's apply_chat_template for accurate formatting
        messages = [{"role": "user", "content": question}]
        try:
            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
        except Exception as e:
            # Fallback to manual template if apply_chat_template fails
            print(f"Warning: apply_chat_template failed ({e}), using manual template", file=sys.stderr)
            return f"<bos><start_of_turn>user\\n{question}<end_of_turn>\\n<start_of_turn>model\\n"
    return question

results = {
    "engineName": "mlx-engine",
    "modelId": model_id,
    "questions": [],
    "totalTokens": 0,
    "completed": 0,
    "failed": 0
}

try:
    # Load model
    print(f"Loading model: {model_id}...", file=sys.stderr)
    load_start = time.time()
    model, tokenizer = load(model_id)
    model_load_time = (time.time() - load_start) * 1000
    results["modelLoadTimeMs"] = model_load_time
    print(f"✓ Model loaded in {model_load_time:.2f}ms\\n", file=sys.stderr)

    # Create sampler with temperature and top_p
    sampler = make_sampler(temp=temperature, top_p=top_p)

    # Run benchmark
    benchmark_start = time.time()

    for i, question in enumerate(questions):
        request_start = time.time()
        question_result = {
            "questionIndex": i,
            "question": question,
            "success": False
        }

        try:
            # Format prompt with chat template using tokenizer
            formatted_prompt = format_chat_prompt(question, model_id, tokenizer)

            # Generate using sampler for temperature control
            response = generate(
                model=model,
                tokenizer=tokenizer,
                prompt=formatted_prompt,
                max_tokens=max_tokens,
                sampler=sampler,
                verbose=False
            )

            latency_ms = (time.time() - request_start) * 1000
            token_count = len(tokenizer.encode(response))
            tokens_per_sec = (token_count / latency_ms) * 1000 if latency_ms > 0 else 0

            question_result.update({
                "ttftMs": 0,  # mlx-engine doesn't provide TTFT
                "latencyMs": latency_ms,
                "tokens": token_count,
                "tokensPerSec": tokens_per_sec,
                "output": response,
                "success": True
            })

            results["totalTokens"] += token_count
            results["completed"] += 1

        except Exception as e:
            question_result.update({
                "ttftMs": 0,
                "latencyMs": (time.time() - request_start) * 1000,
                "tokens": 0,
                "tokensPerSec": 0,
                "output": "",
                "error": str(e)
            })
            results["failed"] += 1

        results["questions"].append(question_result)

        # Progress
        if (i + 1) % max(1, len(questions) // 10) == 0:
            progress = (i + 1) / len(questions) * 100
            print(f"Progress: {i + 1}/{len(questions)} ({progress:.0f}%)", file=sys.stderr)

    results["totalTimeMs"] = (time.time() - benchmark_start) * 1000

    # Output results as JSON
    print(json.dumps(results))

except Exception as e:
    print(f"ERROR: {str(e)}", file=sys.stderr)
    sys.exit(1)
`;

  // Write Python script to temp file
  const scriptPath = '/tmp/mlx-engine-benchmark.py';
  await writeFile(scriptPath, pythonScript);

  // Run Python script with virtual environment Python
  return new Promise<EngineResults>((resolve, reject) => {
    const pythonPath = '.kr-mlx-venv/bin/python';
    const python = spawn(pythonPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (config.verbose) {
        process.stderr.write(text);
      }
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}\n${stderr}`));
        return;
      }

      try {
        const results = JSON.parse(stdout);

        // Calculate statistics
        const successfulResults = results.questions.filter((r: QuestionResult) => r.success);
        const latencies = successfulResults.map((r: QuestionResult) => r.latencyMs);
        const ttfts = successfulResults.map((r: QuestionResult) => r.ttftMs);
        const throughputs = successfulResults.map((r: QuestionResult) => r.tokensPerSec);
        const tokenCounts = successfulResults.map((r: QuestionResult) => r.tokens);

        results.statistics = {
          latency: calculateStatistics(latencies.length > 0 ? latencies : [0]),
          ttft: calculateStatistics(ttfts.length > 0 ? ttfts : [0]),
          tokensPerSec: calculateStatistics(throughputs.length > 0 ? throughputs : [0]),
          tokensPerRequest: calculateStatistics(tokenCounts.length > 0 ? tokenCounts : [0]),
        };

        resolve(results);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err}\n${stdout}`));
      }
    });
  });
}

// =============================================================================
// Reporting
// =============================================================================

function printReport(report: BenchmarkReport): void {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    BENCHMARK RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Configuration:');
  console.log(`  Model:          ${report.config.model}`);
  console.log(`  Questions:      ${report.config.questionCount}`);
  console.log(`  Max Tokens:     ${report.config.maxTokens}`);
  console.log(`  Temperature:    ${report.config.temperature}`);
  console.log(`  Compare Mode:   ${report.config.compareMode}`);
  console.log(`  Timestamp:      ${report.timestamp}`);
  console.log('');

  console.log('System Info:');
  console.log(`  Platform:       ${report.systemInfo.platform} ${report.systemInfo.arch}`);
  console.log(`  Node.js:        ${report.systemInfo.nodeVersion}`);
  console.log(`  CPUs:           ${report.systemInfo.cpus}`);
  console.log(`  Memory:         ${formatNumber(report.systemInfo.totalMemoryMB, 0)} MB`);
  console.log('');

  if (report.mlxServing) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('mlx-serving Results:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    printEngineResults(report.mlxServing);
  }

  if (report.mlxEngine) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('mlx-engine Results:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    printEngineResults(report.mlxEngine);
  }

  if (report.comparison) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Comparison:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Throughput Speedup:     ${formatNumber(report.comparison.speedup, 2)}x`);
    console.log(`  TTFT Speedup:           ${formatNumber(report.comparison.ttftSpeedup, 2)}x`);
    console.log(`  Latency Speedup:        ${formatNumber(report.comparison.latencySpeedup, 2)}x`);
    console.log(`  Winner:                 ${report.comparison.winner.toUpperCase()} 🏆`);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

function printEngineResults(results: EngineResults): void {
  const totalThroughput = results.totalTimeMs > 0
    ? (results.totalTokens / results.totalTimeMs) * 1000
    : 0;

  console.log(`  Model Load Time:        ${formatDuration(results.modelLoadTimeMs)}`);
  console.log(`  Total Time:             ${formatDuration(results.totalTimeMs)}`);
  console.log(`  Total Tokens:           ${results.totalTokens}`);
  console.log(`  Completed:              ${results.completed}/${results.completed + results.failed}`);
  console.log(`  Success Rate:           ${formatNumber((results.completed / (results.completed + results.failed)) * 100, 1)}%`);
  console.log(`  Overall Throughput:     ${formatNumber(totalThroughput, 2)} tokens/sec`);
  console.log('');
  console.log('  Latency Statistics (ms):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.latency.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.latency.median, 2)}`);
  console.log(`    P95:                  ${formatNumber(results.statistics.latency.p95, 2)}`);
  console.log(`    P99:                  ${formatNumber(results.statistics.latency.p99, 2)}`);
  console.log(`    Min/Max:              ${formatNumber(results.statistics.latency.min, 2)} / ${formatNumber(results.statistics.latency.max, 2)}`);
  console.log('');
  console.log('  TTFT Statistics (ms):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.ttft.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.ttft.median, 2)}`);
  console.log(`    P95:                  ${formatNumber(results.statistics.ttft.p95, 2)}`);
  console.log('');
  console.log('  Throughput Statistics (tokens/sec):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.tokensPerSec.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.tokensPerSec.median, 2)}`);
  console.log(`    P95:                  ${formatNumber(results.statistics.tokensPerSec.p95, 2)}`);
  console.log('');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  // Parse command-line arguments
  const { values } = parseArgs({
    options: {
      model: {
        type: 'string',
        short: 'm',
        default: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      },
      questions: {
        type: 'string',
        short: 'q',
        default: '100',
      },
      'max-tokens': {
        type: 'string',
        default: '100',
      },
      temperature: {
        type: 'string',
        short: 't',
        default: '0.7',
      },
      'top-p': {
        type: 'string',
      },
      compare: {
        type: 'string',
        short: 'c',
        default: 'mlx-serving',
      },
      output: {
        type: 'string',
        short: 'o',
      },
      verbose: {
        type: 'boolean',
        short: 'v',
        default: false,
      },
      sequential: {
        type: 'boolean',
        default: true,
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
  });

  if (values.help) {
    console.log(`
Flexible Benchmark Tool for mlx-serving vs mlx-engine

Usage:
  tsx benchmarks/flexible-benchmark.ts [options]

Options:
  -m, --model <model>          Model to benchmark (HuggingFace ID)
                               Default: mlx-community/Llama-3.2-3B-Instruct-4bit
  -q, --questions <count>      Number of questions to test
                               Default: 100
  --max-tokens <count>         Maximum tokens per generation
                               Default: 100
  -t, --temperature <value>    Temperature for generation (0.0-2.0)
                               Default: 0.7
  --top-p <value>              Top-p sampling parameter
  -c, --compare <mode>         Compare mode: mlx-serving, mlx-engine, or both
                               Default: mlx-serving
  -o, --output <path>          Output JSON file path
                               Default: results/benchmark-<timestamp>.json
  -v, --verbose                Verbose output
  --sequential                 Sequential execution (vs concurrent)
                               Default: true
  -h, --help                   Show this help message

Examples:
  # Quick test (10 questions, mlx-serving only)
  tsx benchmarks/flexible-benchmark.ts -q 10

  # Compare both engines with 200 questions
  tsx benchmarks/flexible-benchmark.ts -m mlx-community/gemma-2-27b-it-4bit -q 200 -c both

  # Custom parameters
  tsx benchmarks/flexible-benchmark.ts -q 50 --max-tokens 200 -t 0.8 --top-p 0.95

  # Save results to specific file
  tsx benchmarks/flexible-benchmark.ts -q 100 -c both -o my-benchmark.json
`);
    process.exit(0);
  }

  const config: BenchmarkConfig = {
    model: values.model as string,
    questionCount: parseInt(values.questions as string, 10),
    maxTokens: parseInt(values['max-tokens'] as string, 10),
    temperature: parseFloat(values.temperature as string),
    topP: values['top-p'] ? parseFloat(values['top-p'] as string) : undefined,
    compareMode: (values.compare as 'mlx-serving' | 'mlx-engine' | 'both') || 'mlx-serving',
    outputPath: values.output as string,
    verbose: values.verbose as boolean,
    sequential: values.sequential as boolean,
  };

  // Validation
  if (config.questionCount < 1 || config.questionCount > 100000) {
    console.error('Error: Question count must be between 1 and 100000');
    process.exit(1);
  }

  if (config.temperature < 0 || config.temperature > 2) {
    console.error('Error: Temperature must be between 0.0 and 2.0');
    process.exit(1);
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          MLX BENCHMARK TOOL - Flexible Comparison             ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Generate questions
  console.log(`Generating ${config.questionCount} diverse questions...`);
  const questions = generateQuestions(config.questionCount);
  console.log(`✓ Generated ${questions.length} questions\n`);

  // Run benchmarks
  const report: BenchmarkReport = {
    config,
    timestamp: new Date().toISOString(),
    systemInfo: await getSystemInfo(),
  };

  try {
    if (config.compareMode === 'mlx-serving' || config.compareMode === 'both') {
      report.mlxServing = await benchmarkMLXServing(config, questions);
    }

    if (config.compareMode === 'mlx-engine' || config.compareMode === 'both') {
      report.mlxEngine = await benchmarkMLXEngine(config, questions);
    }

    // Calculate comparison
    if (report.mlxServing && report.mlxEngine) {
      const servingThroughput = report.mlxServing.statistics.tokensPerSec.mean;
      const engineThroughput = report.mlxEngine.statistics.tokensPerSec.mean;
      const speedup = servingThroughput / engineThroughput;

      const servingTTFT = report.mlxServing.statistics.ttft.mean;
      const engineTTFT = report.mlxEngine.statistics.ttft.mean || servingTTFT;
      const ttftSpeedup = engineTTFT / servingTTFT;

      const servingLatency = report.mlxServing.statistics.latency.mean;
      const engineLatency = report.mlxEngine.statistics.latency.mean;
      const latencySpeedup = engineLatency / servingLatency;

      report.comparison = {
        speedup,
        ttftSpeedup,
        latencySpeedup,
        winner: speedup > 1.05 ? 'mlx-serving' : speedup < 0.95 ? 'mlx-engine' : 'tie',
      };
    }

    // Print report
    printReport(report);

    // Save to file
    const outputPath = config.outputPath || `results/benchmark-${Date.now()}.json`;
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`✓ Results saved to: ${outputPath}\n`);

  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
