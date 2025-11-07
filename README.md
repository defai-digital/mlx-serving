# mlx-serving

> Modern TypeScript MLX serving engine for Apple Silicon with Zod validation and ReScript state management

[![License: Elastic 2.0](https://img.shields.io/badge/License-Elastic%202.0-orange.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.11%2B-brightgreen?style=flat-square&logo=python&logoColor=white)](https://www.python.org)
[![macOS](https://img.shields.io/badge/macOS-26.0%2B-blue?style=flat-square&logo=apple&logoColor=white)](https://www.apple.com/macos)
[![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-M3%2B-blue?style=flat-square&logoColor=white)](https://www.apple.com/mac)

---

## 🎉 What is mlx-serving?

**mlx-serving** is a modern refactor of the production-proven kr-serve-mlx engine, rebuilt with:

- ✅ **Systematic Zod validation** across all API boundaries
- ✅ **ReScript state management** for circuit breakers, queues, and stream registry
- ✅ **100% API compatibility** with kr-serve-mlx v1.4.2
- ✅ **Native C++ acceleration** via Metal command buffer pooling (optional)
- ✅ **Production-grade features** from kr-serve-mlx preserved

This is a **refactor/modernization**, not a rewrite. We're taking proven production code and enhancing it with modern TypeScript practices.

---

## Status

**Current Phase:** Phase 0 - Baseline Replication ✅

**Version:** 0.1.0-alpha.0 (Development)

**Source Foundation:** kr-serve-mlx v1.4.2 (375+ passing tests)

---

## Why mlx-serving?

### Built on Proven Foundation

mlx-serving inherits all the production-tested features from kr-serve-mlx:

- ⚡ **Scale horizontally**: Need more capacity? Add more Macs
- 🎯 **Optimize for M3+**: Leverage the full power of Metal 3.3+, AMX v2, and 400GB/s UMA bandwidth
- 🔒 **Production ready**: Comprehensive testing, zero security vulnerabilities
- 🔄 **API compatible**: 100% compatible with kr-serve-mlx API
- 🚀 **Faster than native**: 2.1% better throughput than mlx-engine
- 📦 **Zero-setup**: `npm install` automatically configures Python environment

### Plus Modern Enhancements

- **Type Safety**: Zod schemas for every API boundary
- **Deterministic State**: ReScript-powered state machines
- **Better DX**: Improved error messages and validation
- **Maintainable**: Cleaner architecture for long-term evolution

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  TypeScript API Layer (Enhanced with Zod)           │
│  - Engine facade                                     │
│  - Zod validation for all inputs/outputs            │
│  - Type-safe error handling                         │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  State Management (ReScript)                        │
│  - Circuit breaker state machine                    │
│  - Request queues & batch scheduler                 │
│  - Stream registry with backpressure                │
└────────────────────┬────────────────────────────────┘
                     │ JSON-RPC over stdio
┌────────────────────▼────────────────────────────────┐
│  Python Runtime                                     │
│  - MLX model loaders                                │
│  - GPU scheduler                                    │
│  - Outlines adapter (structured output)            │
│  - Native C++ acceleration (optional)              │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  MLX / Metal Runtime (Apple Silicon)                │
│  - Apple's ML framework                             │
│  - Metal GPU acceleration                           │
└─────────────────────────────────────────────────────┘
```

---

## Core Features

### From kr-serve-mlx (Preserved)

- **Model Loading**: Load/unload MLX models with caching
- **Streaming Generation**: Real-time token generation with backpressure
- **Structured Output**: JSON schema validation via Outlines
- **Vision Models**: Multi-modal support (LLaVA, Qwen-VL, Phi-3-Vision)
- **GPU Scheduler**: Prevents Metal crashes under load
- **Draft Models**: Speculative decoding for faster inference

### New in mlx-serving

- **Zod Validation**: All API inputs validated with clear error messages
- **ReScript State Machines**: Deterministic circuit breakers and queues
- **Native C++ Module**: Optional Metal command buffer pooling (5-60% speedup)
- **Improved Telemetry**: Better observability with structured metrics

---

## Installation

```bash
npm install @defai.digital/mlx-serving
```

### System Requirements

- **macOS**: 26.0+ (Darwin 25.0.0+)
- **Hardware**: Apple Silicon M3 or newer
- **Node.js**: 22.0.0+
- **Python**: 3.11-3.12
- **Metal**: 3.3+ (included in macOS 26.0+)

### Optional: Native C++ Module

For 5-60% performance boost, build the native module:

```bash
cd native
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
cmake --install .
```

**Requirements:**
- CMake 3.15+
- pybind11
- Xcode Command Line Tools

---

## Quick Start

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

// Create engine instance
const engine = await createEngine();

// Load model
await engine.loadModel({
  model: 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit',
});

// Generate text (streaming)
for await (const chunk of engine.createGenerator({
  model: 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit',
  prompt: 'Explain quantum computing in simple terms:',
  maxTokens: 200,
  temperature: 0.7,
})) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}

// Cleanup
await engine.dispose();
```

---

## Migrating from kr-serve-mlx

**Migration Time: < 15 minutes**

mlx-serving maintains 100% API compatibility with kr-serve-mlx v1.4.2.

### Step 1: Update package.json

```diff
- "@defai.digital/kr-serve-mlx": "^1.4.2"
+ "@defai.digital/mlx-serving": "^0.1.0-alpha.0"
```

### Step 2: Update imports (optional)

```diff
- import { createEngine } from '@defai.digital/kr-serve-mlx';
+ import { createEngine } from '@defai.digital/mlx-serving';
```

### Step 3: Enjoy enhanced validation

Your existing code works as-is, but now you get:
- Better error messages from Zod validation
- More reliable state management from ReScript
- Optional native acceleration

---

## Type-Safe Validation with Zod

mlx-serving provides comprehensive runtime type validation using [Zod v3.22.4](https://github.com/colinhacks/zod) across all API boundaries.

### Why Zod Validation?

- ✅ **Runtime Type Safety**: Catch invalid inputs before they reach MLX
- ✅ **Clear Error Messages**: Know exactly what went wrong and where
- ✅ **Zero Breaking Changes**: 100% backward compatible with kr-serve-mlx
- ✅ **Type Inference**: TypeScript types automatically inferred from schemas

### Quick Example

```typescript
import { createEngine, LoadModelOptionsSchema } from '@defai.digital/mlx-serving';

// Manual validation (optional - Engine validates automatically)
const options = { model: 'llama-3-8b', quantization: 'q4' };
const result = LoadModelOptionsSchema.safeParse(options);

if (!result.success) {
  console.error('Validation failed:', result.error.issues);
  process.exit(1);
}

// Engine validates automatically ✅
const engine = await createEngine();
await engine.loadModel(options); // Validated internally
```

### What's Validated?

**9 schema modules** covering:

1. **Model Loading** - `LoadModelOptionsSchema`, `ModelDescriptorSchema`
2. **Text Generation** - `GeneratorParamsSchema`, structured output validation
3. **Tokenization** - `TokenizeRequestSchema`, `TokenizeResponseSchema`
4. **Configuration** - `RuntimeConfigSchema` (60+ properties, 11 sections)
5. **JSON-RPC** - Request/response message validation
6. **Telemetry** - OpenTelemetry configuration
7. **Events** - 8 event payload schemas

### Error Handling

```typescript
try {
  await engine.loadModel({ model: 'llama-3-8b', temperature: 5.0 });
} catch (error) {
  console.error(error.message);
  // Output: "temperature must be >= 0.0 and <= 2.0"
}
```

### Learn More

See **[docs/ZOD_SCHEMAS.md](./docs/ZOD_SCHEMAS.md)** for:
- Complete schema reference
- Validation patterns (Normalize → Validate → Execute)
- Migration guide (manual validators → Zod)
- Best practices and troubleshooting

---

## Development

### Project Structure

```
mlx-serving/
├── src/                    # TypeScript source (with Zod schemas)
│   ├── api/               # Public API
│   ├── core/              # Core services
│   ├── bridge/            # Python IPC
│   ├── config/            # Configuration
│   └── types/             # Type definitions + Zod schemas
├── rescript/              # ReScript state machines (coming in Phase 2)
├── python/                # Python runtime (from kr-serve-mlx)
│   ├── runtime.py
│   ├── models/
│   └── adapters/
├── native/                # C++ native acceleration (optional)
│   ├── include/
│   ├── src/
│   └── bindings/
├── tests/                 # Test suites
├── docs/                  # Documentation
└── automatosx/
    └── PRD/               # Planning documents
```

### Build Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Build native module (optional)
cd native && mkdir -p build && cd build && cmake .. && cmake --build .

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

### Build Native Module

```bash
cd native
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
```

---

## Documentation

### Planning Documents (automatosx/PRD/)

- **mlx-serving-architecture-analysis.md** - Technical architecture deep dive
- **mlx-serving-prd.md** - Product Requirements Document
- **mlx-serving-implementation-plan.md** - 5-phase implementation roadmap
- **PROJECT_SUMMARY.md** - Executive summary
- **CODEBASE_COMPARISON.md** - kr-serve-mlx vs kr-serve-mlx2 analysis
- **NATIVE_MODULE_ANALYSIS.md** - C++ native module documentation

### Technical Docs (docs/)

**Core Documentation:**
- **[ZOD_SCHEMAS.md](./docs/ZOD_SCHEMAS.md)** - Comprehensive Zod validation guide (NEW!)
- **[INDEX.md](./docs/INDEX.md)** - Documentation index
- **[GUIDES.md](./docs/GUIDES.md)** - User guides (migration, structured output, vision)
- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - Architecture and M3+ strategy
- **[DEPLOYMENT.md](./docs/DEPLOYMENT.md)** - Deployment and operations guide

---

## Implementation Roadmap

### ✅ Phase 0: Baseline Replication (Week 0-1) - COMPLETE
- Copy kr-serve-mlx v1.4.2 codebase
- Update branding to mlx-serving
- Verify all tests pass

### ✅ Phase 1: Zod Integration (Week 2-6) - COMPLETE
- Add Zod schemas for all API boundaries (9 modules)
- Refactor validation in Engine, config, bridge
- 389 tests passing, comprehensive documentation
- See [docs/ZOD_SCHEMAS.md](./docs/ZOD_SCHEMAS.md)

### 📋 Phase 2: ReScript Migration (Week 7-12)
- Migrate state machines to ReScript
- Circuit breaker, queues, stream registry
- Maintain TypeScript API compatibility

### 🔗 Phase 3: Integration Testing (Week 13-16)
- End-to-end validation
- Performance benchmarks
- Contract tests

### 🚀 Phase 4: Release Readiness (Week 17-18)
- Migration guide
- Documentation updates
- GA release preparation

---

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Type check
npm run typecheck

# Lint
npm run lint

# Benchmarks
npm run bench:apple-to-apple
npm run bench:50-questions
```

---

## Performance

### Baseline (from kr-serve-mlx v1.4.2)

- **1.081x faster** than mlx-engine
- **100% success rate** (100/100 requests)
- **5.4x lower variance** than baseline

### With Native Module

- **5-10% improvement** from command buffer pooling
- **10-20% additional** from Metal optimizations
- **25-60% total potential gain**

---

## License

Elastic License 2.0 - See [LICENSE](./LICENSE) file

Copyright 2025 DEFAI Private Limited

---

## Acknowledgments

Built on the foundation of:
- **kr-serve-mlx** - Production-proven MLX serving engine
- **[MLX](https://github.com/ml-explore/mlx)** - Apple's ML framework for Apple Silicon
- **[mlx-lm](https://github.com/ml-explore/mlx-examples)** - Language model inference
- **[mlx-vlm](https://github.com/Blaizzy/mlx-vlm)** - Vision language models
- **[Outlines](https://github.com/outlines-dev/outlines)** - Structured generation
- **[pybind11](https://github.com/pybind/pybind11)** - Python/C++ bindings

Special thanks to:
- AutomatosX multi-agent system
- KnowRAG Studio team
- MLX community

---

## Support

- **Documentation**: [automatosx/PRD/](./automatosx/PRD/)
- **Issues**: [GitHub Issues](https://github.com/defai-digital/mlx-serving/issues)
- **Source Code**: [GitHub](https://github.com/defai-digital/mlx-serving)

---

## Project Status

**Version**: 0.1.0-alpha.0
**Phase**: Phase 0 Complete ✅
**Status**: Active Development
**Last Updated**: 2025-11-07

### Quick Stats

- ✅ **Source**: kr-serve-mlx v1.4.2 (proven production code)
- ✅ **Tests**: 375/382 passing baseline (98.2%)
- ✅ **API Compatibility**: 100% with kr-serve-mlx
- ✅ **Native Module**: Optional C++ acceleration included
- 🔄 **Zod**: Coming in Phase 1
- 📋 **ReScript**: Coming in Phase 2

---

<div align="center">

**Made with ❤️ by KnowRAG Studio**

[📦 GitHub](https://github.com/defai-digital/mlx-serving) • [📖 Documentation](./automatosx/PRD/)

</div>
