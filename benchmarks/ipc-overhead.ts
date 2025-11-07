/**
 * IPC Overhead Benchmark
 *
 * Measures serialization/deserialization performance comparing JSON and MessagePack.
 * Tests IPC overhead across different payload sizes and message types.
 */

import { performance } from 'node:perf_hooks';
import { JsonCodec } from '../src/bridge/serializers.js';
import { MessagePackCodec } from '../src/bridge/msgpack-codec.js';
import {
  calculateStatistics,
  formatNumber,
  formatBytes,
  getSystemInfo,
  createProgressBar,
  calculateCompressionRatio,
} from './utils.js';
import type { IpcBenchmarkResult, BenchmarkConfig } from './types.js';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id?: string | number;
}

interface BenchmarkPayload {
  name: string;
  messageCount: number;
  buildMessages: () => JsonRpcMessage[];
}

/**
 * Create benchmark payloads of different sizes
 */
const PAYLOADS: BenchmarkPayload[] = [
  {
    name: 'Small (stream.chunk)',
    messageCount: 100,
    buildMessages: () =>
      Array.from({ length: 100 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        method: 'stream.chunk',
        params: {
          stream_id: 'test-stream',
          token: `token-${i}`,
          token_id: i,
          logprob: Math.random() * -5,
          is_final: false,
        },
      })),
  },
  {
    name: 'Medium (tokenize)',
    messageCount: 50,
    buildMessages: () =>
      Array.from({ length: 50 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        method: 'tokenize',
        id: i,
        params: {
          model_id: 'llama-3.2-3b-instruct',
          text: 'The quick brown fox jumps over the lazy dog. '.repeat(10),
          add_special_tokens: true,
        },
      })),
  },
  {
    name: 'Large (load_model response)',
    messageCount: 10,
    buildMessages: () =>
      Array.from({ length: 10 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        method: 'load_model',
        id: i,
        params: {
          model_path: '/path/to/models/llama-3.2-3b-instruct',
          model_id: 'llama-3.2-3b-instruct',
          adapter_path: null,
          tokenizer_config: {
            chat_template: '{{ bos_token }}{{ messages }}{{ eos_token }}',
            eos_token: '<|end_of_text|>',
            bos_token: '<|begin_of_text|>',
          },
          quantization: { bits: 4, group_size: 64 },
          trust_remote_code: false,
          lazy: true,
        },
      })),
  },
];

/**
 * Measure codec performance for a payload
 */
function measureCodecPerformance(
  name: string,
  messages: JsonRpcMessage[],
  encodeFn: (msg: JsonRpcMessage) => Buffer,
  decodeFn: (buf: Buffer) => JsonRpcMessage,
  samples: number
): { encodeTimings: number[]; decodeTimings: number[]; totalBytes: number } {
  const encodeTimings: number[] = [];
  const decodeTimings: number[] = [];
  let totalBytes = 0;

  // Run samples
  for (let sample = 0; sample < samples; sample++) {
    const encoded: Buffer[] = [];

    // Encode
    const encodeStart = performance.now();
    for (const message of messages) {
      const buffer = encodeFn(message);
      encoded.push(buffer);
    }
    encodeTimings.push(performance.now() - encodeStart);

    // Calculate bytes (only on first sample)
    if (sample === 0) {
      totalBytes = encoded.reduce((sum, buf) => sum + buf.byteLength, 0);
    }

    // Decode
    const decodeStart = performance.now();
    for (const buffer of encoded) {
      decodeFn(buffer);
    }
    decodeTimings.push(performance.now() - decodeStart);
  }

  return { encodeTimings, decodeTimings, totalBytes };
}

/**
 * Run IPC overhead benchmark
 */
export async function runIpcBenchmark(config: BenchmarkConfig = {}): Promise<IpcBenchmarkResult[]> {
  const { samples = 100, verbose = false } = config;

  const jsonCodec = new JsonCodec();
  const msgpackCodec = new MessagePackCodec();

  const results: IpcBenchmarkResult[] = [];

  console.log('\n=== IPC Overhead Benchmark ===\n');
  console.log(`Samples per test: ${samples}`);
  console.log(`System: ${getSystemInfo().platform} ${getSystemInfo().arch}`);
  console.log(`Node.js: ${getSystemInfo().nodeVersion}`);
  console.log('');

  for (const payload of PAYLOADS) {
    if (verbose) {
      console.log(`\nTesting: ${payload.name} (${payload.messageCount} messages)`);
    }

    const messages = payload.buildMessages();

    // Test JSON
    const jsonResult = measureCodecPerformance(
      'JSON',
      messages,
      (msg) => jsonCodec.encode(msg),
      (buf) => jsonCodec.decode<JsonRpcMessage>(buf),
      samples
    );

    const jsonStats = {
      encodeStats: calculateStatistics(jsonResult.encodeTimings),
      decodeStats: calculateStatistics(jsonResult.decodeTimings),
      totalBytes: jsonResult.totalBytes,
      avgPayloadSizeBytes: jsonResult.totalBytes / messages.length,
    };

    // Test MessagePack
    const msgpackResult = measureCodecPerformance(
      'MessagePack',
      messages,
      (msg) => msgpackCodec.encode(msg),
      (buf) => msgpackCodec.decode<JsonRpcMessage>(buf),
      samples
    );

    const msgpackStats = {
      encodeStats: calculateStatistics(msgpackResult.encodeTimings),
      decodeStats: calculateStatistics(msgpackResult.decodeTimings),
      totalBytes: msgpackResult.totalBytes,
      avgPayloadSizeBytes: msgpackResult.totalBytes / messages.length,
      compressionRatio: calculateCompressionRatio(msgpackResult.totalBytes, jsonResult.totalBytes),
    };

    results.push(
      {
        name: `${payload.name} - JSON`,
        timestamp: new Date().toISOString(),
        samples,
        codec: 'JSON',
        durationMs: jsonStats.encodeStats.mean + jsonStats.decodeStats.mean,
        ...jsonStats,
      },
      {
        name: `${payload.name} - MessagePack`,
        timestamp: new Date().toISOString(),
        samples,
        codec: 'MessagePack',
        durationMs: msgpackStats.encodeStats.mean + msgpackStats.decodeStats.mean,
        ...msgpackStats,
      }
    );

    if (verbose) {
      console.log(`  JSON:        ${formatBytes(jsonResult.totalBytes)}`);
      console.log(`  MessagePack: ${formatBytes(msgpackResult.totalBytes)}`);
      console.log(
        `  Compression: ${((1 - msgpackResult.totalBytes / jsonResult.totalBytes) * 100).toFixed(1)}% smaller`
      );
    }
  }

  return results;
}

/**
 * Format IPC benchmark results as console table
 */
export function formatIpcResults(results: IpcBenchmarkResult[]): void {
  console.log('\n=== IPC Benchmark Results ===\n');

  // Group results by payload type
  const grouped = new Map<string, IpcBenchmarkResult[]>();
  for (const result of results) {
    const key = result.name.split(' - ')[0];
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(result);
  }

  for (const [payloadType, payloadResults] of grouped) {
    console.log(`\n${payloadType}:`);
    console.log(
      '  ' +
        ['Codec', 'Encode (ms)', 'Decode (ms)', 'Total (ms)', 'Size', 'Compression']
          .map((h) => h.padEnd(14))
          .join(' ')
    );
    console.log('  ' + '-'.repeat(90));

    for (const result of payloadResults) {
      const encodeAvg = result.encodeStats.mean;
      const decodeAvg = result.decodeStats.mean;
      const totalAvg = encodeAvg + decodeAvg;
      const compression = result.compressionRatio ? `${result.compressionRatio.toFixed(2)}x` : '-';

      console.log(
        '  ' +
          [
            result.codec.padEnd(14),
            formatNumber(encodeAvg, 3, 12),
            formatNumber(decodeAvg, 3, 12),
            formatNumber(totalAvg, 3, 12),
            formatBytes(result.totalBytes).padEnd(14),
            compression.padEnd(14),
          ].join(' ')
      );
    }
  }

  // Summary
  console.log('\n=== Performance Summary ===\n');

  const jsonResults = results.filter((r) => r.codec === 'JSON');
  const msgpackResults = results.filter((r) => r.codec === 'MessagePack');

  const jsonAvgEncode = jsonResults.reduce((sum, r) => sum + r.encodeStats.mean, 0) / jsonResults.length;
  const msgpackAvgEncode = msgpackResults.reduce((sum, r) => sum + r.encodeStats.mean, 0) / msgpackResults.length;

  const jsonAvgDecode = jsonResults.reduce((sum, r) => sum + r.decodeStats.mean, 0) / jsonResults.length;
  const msgpackAvgDecode = msgpackResults.reduce((sum, r) => sum + r.decodeStats.mean, 0) / msgpackResults.length;

  const speedup = ((jsonAvgEncode + jsonAvgDecode) / (msgpackAvgEncode + msgpackAvgDecode)).toFixed(2);

  console.log(`Average Encode (JSON):        ${formatNumber(jsonAvgEncode, 3)} ms`);
  console.log(`Average Encode (MessagePack): ${formatNumber(msgpackAvgEncode, 3)} ms`);
  console.log(`Average Decode (JSON):        ${formatNumber(jsonAvgDecode, 3)} ms`);
  console.log(`Average Decode (MessagePack): ${formatNumber(msgpackAvgDecode, 3)} ms`);
  console.log(`\nMessagePack is ${speedup}x faster than JSON on average`);

  // Check if IPC overhead target is met
  const msgpackP95 = msgpackResults.reduce((sum, r) => sum + r.decodeStats.p95, 0) / msgpackResults.length;
  const targetMet = msgpackP95 < 1.0;

  console.log(`\nIPC Overhead Target (< 1ms p95): ${targetMet ? '✓ PASSED' : '✗ FAILED'}`);
  console.log(`Actual p95: ${formatNumber(msgpackP95, 3)} ms`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const results = await runIpcBenchmark({ samples: 100, verbose: true });
  formatIpcResults(results);

  // Export results as JSON
  const outputPath = new URL('./results/ipc-overhead.json', import.meta.url);
  const fs = await import('fs/promises');
  await fs.mkdir(new URL('./results', import.meta.url), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nResults exported to: ${outputPath.pathname}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
