# Documentation Index

**mlx-serving** - Production-Grade LLM Serving Engine for Apple Silicon

---

## Quick Navigation

| Document | Description | Size |
|----------|-------------|------|
| **[README.md](../README.md)** | Project overview, quick start, features | 35K |
| **[QUICK_START.md](./QUICK_START.md)** | 5-minute getting started guide | 12K |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Complete architecture, M3+ strategy, distributed design | 18K |
| **[PERFORMANCE.md](./PERFORMANCE.md)** | Week 7 performance optimizations guide | 52K |
| **[PRODUCTION_FEATURES.md](./PRODUCTION_FEATURES.md)** | Enterprise features (TTFT, QoS, canary, feature flags) | 65K |
| **[FEATURE_FLAGS.md](./FEATURE_FLAGS.md)** | Feature flag system reference | 34K |
| **[GUIDES.md](./GUIDES.md)** | User guides (migration, structured output, vision models) | 30K |
| **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** | Common issues and solutions | 22K |
| **[ZOD_SCHEMAS.md](./ZOD_SCHEMAS.md)** | Zod schema validation guide (runtime type safety) | 26K |
| **[DEPLOYMENT.md](./DEPLOYMENT.md)** | Deployment and operations guide | 10K |
| **[INDEX.md](./INDEX.md)** | This document (documentation map) | 6K |

---

## Getting Started

### New Users
1. [QUICK_START.md](./QUICK_START.md) - 5-minute getting started guide
2. [README](../README.md) - Project overview, why M3+?, features
3. [GUIDES.md](./GUIDES.md#quick-reference) - Quick reference commands
4. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues and solutions

### Migrating from mlx-engine
1. [GUIDES.md - Migration Guide](./GUIDES.md#migration-guide) - Complete migration tutorial
2. [Examples](../examples/migration/) - Side-by-side code examples

### Week 7 Performance Optimizations
1. [Model Preloading](./PERFORMANCE.md#model-preloading) - Zero first-request latency
2. [Object Pooling](./PERFORMANCE.md#object-pooling) - 20% GC reduction
3. [Adaptive Batching](./PERFORMANCE.md#adaptive-batching) - Dynamic throughput optimization
4. [FastJsonCodec](./PERFORMANCE.md#fastjsoncodec) - 2-3x faster JSON serialization
5. [Complete Guide →](./PERFORMANCE.md)
6. [Examples →](../examples/performance/) - Working code examples

### Production Features (Phases 2-5)
1. [TTFT Acceleration Pipeline](./PRODUCTION_FEATURES.md#ttft-acceleration-pipeline) - 30-40% TTFT reduction
2. [QoS Monitoring](./PRODUCTION_FEATURES.md#qos-monitoring) - SLO enforcement & auto-remediation
3. [Canary Deployment](./PRODUCTION_FEATURES.md#canary-deployment) - Zero-downtime rollouts
4. [Feature Flags](./FEATURE_FLAGS.md) - Gradual percentage-based rollout
5. [Complete Guide →](./PRODUCTION_FEATURES.md)
6. [Examples →](../examples/production/) - Working code examples

---

## Core Documentation

### Architecture & Strategy

**[ARCHITECTURE.md](./ARCHITECTURE.md)** - Comprehensive architecture guide covering:

1. **Product Vision**
   - Target market (enterprise/research)
   - Key differentiators vs Ollama/llama.cpp/vLLM
   - Market positioning and ROI

2. **M3+ Hardware Strategy**
   - Why M3+ only? (Metal 3.3+, AMX v2, 400+ GB/s UMA)
   - Performance benchmarks (40-50% improvement)
   - M1/M2 support policy (CPU fallback only)

3. **Distributed Architecture**
   - Multi-Mac load distribution (不切分模型)
   - Gateway + Workers + Registry topology
   - 5 key strategies (session affinity, warmup pool, memory governance, micro-batching, circuit breaking)

4. **Technical Specification**
   - Component details (Gateway, Worker, Registry)
   - Communication protocols (gRPC, HTTP/2)
   - Capacity planning formulas

5. **Implementation Roadmap**
   - Phase 1: MVP (4 weeks)
   - Phase 2: Optimization (4 weeks)
   - Phase 3: Scale-out (4 weeks)

### User Guides

**[GUIDES.md](./GUIDES.md)** - Complete user guides covering:

1. **[Migration Guide](./GUIDES.md#migration-guide)**
   - mlx-engine → kr-serve-mlx step-by-step
   - API comparison (snake_case/camelCase)
   - Method mapping and examples
   - Migration time estimates (15 minutes - 8 hours)

2. **[Structured Output with Outlines](./GUIDES.md#structured-output-with-outlines)**
   - JSON schema generation
   - XML mode
   - Regex constraints
   - TypeScript integration (Zod)
   - Performance considerations

3. **[Vision Models](./GUIDES.md#vision-models)**
   - LLaVA, Qwen-VL, Phi-3-Vision
   - Multi-image processing
   - Use cases (captioning, VQA, OCR)
   - Best practices

4. **[Quick Reference](./GUIDES.md#quick-reference)**
   - Essential commands
   - Core API
   - Common parameters
   - Error handling

### Validation & Type Safety

**[ZOD_SCHEMAS.md](./ZOD_SCHEMAS.md)** - Comprehensive Zod schema validation guide:

1. **[Overview & Quick Start](./ZOD_SCHEMAS.md#overview)**
   - Runtime type validation with Zod v3.22.4
   - Type safety and error handling
   - Zero breaking changes (100% backward compatible)

2. **[Schema Reference](./ZOD_SCHEMAS.md#schema-reference)**
   - Model schemas (LoadModelOptions, ModelDescriptor)
   - Generator schemas (GeneratorParams, structured output)
   - Tokenizer schemas (TokenizeRequest, TokenizeResponse)
   - Config schemas (60+ properties, 11 sections)
   - JSON-RPC schemas (request/response validation)
   - Telemetry schemas (OpenTelemetry config)
   - Event schemas (8 event payloads)

3. **[Validation Patterns](./ZOD_SCHEMAS.md#validation-patterns)**
   - Normalize → Validate → Execute pattern
   - .passthrough() for extensibility
   - Union types for shortcuts
   - Cross-field validation with .refine()
   - Recursive types with z.lazy()

4. **[Error Handling](./ZOD_SCHEMAS.md#error-handling)**
   - .safeParse() vs .parse()
   - Error message formatting
   - Converting Zod errors to Engine errors

5. **[Migration Guide](./ZOD_SCHEMAS.md#migration-guide)**
   - Manual validators → Zod (81% code reduction)
   - Migration checklist
   - Best practices

### Operations

**[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment and operations guide:
- System requirements (M3+, macOS 26.0+)
- Installation and setup
- Production deployment patterns
- Monitoring and troubleshooting

---

## Examples

All examples located in [`examples/`](../examples/):

### Performance Examples (Week 7)
- [README](../examples/performance/README.md) - Performance optimization overview
- [01-model-preloading.ts](../examples/performance/01-model-preloading.ts) - Zero first-request latency
- [02-object-pooling.ts](../examples/performance/02-object-pooling.ts) - 20% GC reduction
- [03-adaptive-batching.ts](../examples/performance/03-adaptive-batching.ts) - Dynamic throughput optimization

### Production Examples (Phases 2-5)
- [README](../examples/production/README.md) - Enterprise features overview
- [01-qos-monitoring.ts](../examples/production/01-qos-monitoring.ts) - SLO enforcement & remediation
- [02-canary-deployment.ts](../examples/production/02-canary-deployment.ts) - Zero-downtime rollouts
- [03-feature-flags.ts](../examples/production/03-feature-flags.ts) - Gradual rollout control

### Basic Examples
- [01-hello-world.ts](../examples/basic/01-hello-world.ts) - Simplest example
- [02-with-engine-context.ts](../examples/basic/02-with-engine-context.ts) - Context manager pattern

### Structured Output Examples
- [README](../examples/structured/README.md) - Overview
- [json_schema_example.py](../examples/structured/json_schema_example.py) - JSON schema
- [xml_mode_example.py](../examples/structured/xml_mode_example.py) - XML generation
- [typescript_example.ts](../examples/structured/typescript_example.ts) - Type-safe generation

### Migration Examples
- [from-mlx-engine.md](../examples/migration/from-mlx-engine.md) - Migration guide
- [01-before-mlx-engine.py](../examples/migration/01-before-mlx-engine.py) - Python code
- [02-after-kr-mlx-lm-typescript.ts](../examples/migration/02-after-kr-mlx-lm-typescript.ts) - TypeScript equivalent

### Vision Examples
- [llava_example.py](../examples/vision/llava_example.py) - LLaVA image captioning
- [multi_image_example.py](../examples/vision/multi_image_example.py) - Multiple images

---

## API Reference

### TypeScript API

**Core Interfaces** (Located in [`src/types/`](../src/types/)):
- `Engine` - Main engine interface
- `ModelDescriptor` - Model configuration
- `GeneratorParams` - Generation parameters
- `GeneratorChunk` - Streaming chunks
- `VisionGeneratorParams` - Vision model parameters

**Public API** (Located in [`src/api/`](../src/api/)):
- `createEngine()` - Factory function
- `withEngine()` - Context manager helper
- Dual API support (camelCase + snake_case)

**Validation Schemas** (Located in [`src/types/schemas/`](../src/types/schemas/)):
- See [ZOD_SCHEMAS.md](./ZOD_SCHEMAS.md) for complete schema reference
- 9 schema modules covering all API boundaries
- Runtime type validation with Zod v3.22.4
- Type inference: `z.infer<typeof Schema>`

### Python Runtime

**Python Modules** (Located in [`python/`](../python/)):
- `runtime.py` - JSON-RPC server over stdio
- `models/loader.py` - Model loading (MLX, mlx-lm)
- `models/generator.py` - Text generation
- `models/vision_loader.py` - Vision model support
- `adapters/outlines_adapter.py` - Structured output (Outlines)

---

## Configuration

### Core Configuration Files

| File | Purpose |
|------|---------|
| [`config/runtime.yaml`](../config/runtime.yaml) | Runtime configuration (timeouts, limits, defaults) |
| [`package.json`](../package.json) | NPM package metadata and scripts |
| [`tsconfig.json`](../tsconfig.json) | TypeScript compiler configuration |
| [`vitest.config.ts`](../vitest.config.ts) | Test framework configuration |
| `automatosx.config.json` | AutomatosX agent configuration (development only, not in repository) |

### Environment Configuration

- Development: `NODE_ENV=development`
- Test: `NODE_ENV=test`
- Production: `NODE_ENV=production`

See [config/runtime.yaml](../config/runtime.yaml) for environment-specific overrides.

---

## Testing

### Test Organization

```
tests/
├── unit/               # Unit tests (mocked Python bridge)
│   ├── bridge/        # IPC layer tests
│   ├── core/          # Core services tests
│   └── adapters/      # Adapter tests
├── integration/       # Integration tests (real Python runtime)
│   ├── bridge.test.ts
│   ├── outlines/      # Structured output tests
│   └── vision/        # Vision model tests
└── security/          # Security tests (CVE coverage)
```

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm test:watch

# Coverage report
npm test:coverage

# Specific test suite
npm vitest run tests/integration/bridge.test.ts
```

**Test Status**: 512/512 passing (100%)
- All tests passing with Week 7 optimizations
- Complete test coverage for performance features
- Production ready

---

## Architecture Overview

### Project Structure

```
kr-serve-mlx/
├── docs/                   # Documentation (you are here)
│   ├── ARCHITECTURE.md     # Complete architecture guide
│   ├── GUIDES.md          # User guides (migration, outlines, vision)
│   ├── DEPLOYMENT.md      # Deployment guide
│   ├── INDEX.md           # This file
│   └── archive/           # Historical documents
├── src/                   # TypeScript source code
│   ├── api/               # Public API layer
│   ├── core/              # Core services (model manager, generator factory)
│   ├── bridge/            # Python IPC (JSON-RPC over stdio)
│   ├── adapters/          # Provider adapters
│   ├── types/             # TypeScript type definitions
│   │   └── schemas/       # Zod validation schemas (9 modules)
│   └── utils/             # Utilities (logger, validators)
├── python/                # Python runtime
│   ├── runtime.py         # JSON-RPC server
│   ├── models/            # Model loading and generation
│   ├── adapters/          # Outlines integration
│   └── validators.py      # Input validation
├── examples/              # Usage examples
│   ├── basic/
│   ├── structured/
│   ├── migration/
│   └── vision/
├── tests/                 # Test suite
│   ├── unit/
│   ├── integration/
│   └── security/
├── config/                # Configuration files
├── benchmarks/            # Performance benchmarks
└── .automatosx/           # AutomatosX agent definitions (development only, not in repository)

```

### Communication Flow

```
TypeScript API (src/api/engine.ts)
         ↓
Core Services (src/core/)
         ↓
Python Bridge (src/bridge/jsonrpc-transport.ts)
         ↓ JSON-RPC over stdio (<1ms IPC)
         ↓
Python Runtime (python/runtime.py)
         ↓
MLX Framework (mlx-lm, mlx-vlm, outlines)
```

---

## External Resources

### Dependencies

**Core Libraries**:
- [MLX](https://github.com/ml-explore/mlx) - Apple's ML framework for Apple Silicon
- [mlx-lm](https://github.com/ml-explore/mlx-examples) - Language model inference (MIT)
- [Outlines](https://outlines-dev.github.io/outlines/) - Structured generation (Apache 2.0)
- [mlx-vlm](https://github.com/Blaizzy/mlx-vlm) - Vision-language models (MIT)

**Compatible Projects**:
- [mlx-engine](https://github.com/lmstudio-ai/mlx-engine) - Original Python engine (kr-serve-mlx is API-compatible)

### Community

- **Homepage**: https://github.com/defai-digital/kr-serve-mlx
- **Issues**: [GitHub Issues](https://github.com/defai-digital/kr-serve-mlx/issues)
- **Discussions**: [GitHub Discussions](https://github.com/defai-digital/kr-serve-mlx/discussions)
- **NPM Package**: [@knowrag/kr-serve-mlx](https://www.npmjs.com/package/@knowrag/kr-serve-mlx)

---

## Contributing

### For Developers

**Start Here**:
1. [CLAUDE.md](../CLAUDE.md) - Complete development guide
2. [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
3. [PROJECT_STATUS.md](../PROJECT_STATUS.md) - Current implementation status

**Development Workflow**:
```bash
# Setup
npm install
npm prepare:python

# Development
npm dev                # Watch mode
npm test:watch         # Test watch mode

# Quality checks
npm typecheck          # TypeScript type checking
npm lint               # ESLint (max 0 warnings)
npm format             # Prettier formatting

# Build
npm build              # Build ESM + CJS to dist/
```

### Code Standards

- **TypeScript Strict Mode**: Zero `any` types
- **Test Coverage**: 80%+ (lines/functions), 75%+ (branches)
- **ESLint**: Max 0 warnings, `no-explicit-any` is error
- **Prettier**: Auto-format on save
- **Commit Messages**: Professional style, no AI attribution

See [CLAUDE.md](../CLAUDE.md) for complete coding standards.

---

## Support & Troubleshooting

### Quick Troubleshooting

**Installation Issues**:
- Ensure macOS 26.0+ and M3+ hardware
- Run `npm prepare:python` to setup Python environment
- Verify: `.kr-mlx-venv/bin/python -c "import mlx; print(mlx.__version__)"`

**Runtime Errors**:
- Check Python bridge: `echo '{"jsonrpc":"2.0","id":1,"method":"runtime/info"}' | PYTHONPATH=./python .kr-mlx-venv/bin/python python/runtime.py`
- Enable verbose logging: `createEngine({ verbose: true })`
- Monitor Python stderr: `engine.on('stderr', console.error)`

**Performance Issues**:
- Verify M3+ hardware: `sysctl machdep.cpu.brand_string`
- Check Metal version: System Requirements in [ARCHITECTURE.md](./ARCHITECTURE.md#m3-hardware-strategy)
- Review capacity planning: [ARCHITECTURE.md - Capacity Planning](./ARCHITECTURE.md#capacity-planning)

### Getting Help

1. **Check Documentation**: [GUIDES.md](./GUIDES.md), [ARCHITECTURE.md](./ARCHITECTURE.md)
2. **Search Issues**: [GitHub Issues](https://github.com/defai-digital/kr-serve-mlx/issues)
3. **Ask Questions**: [GitHub Discussions](https://github.com/defai-digital/kr-serve-mlx/discussions)
4. **Report Bugs**: [New Issue](https://github.com/defai-digital/kr-serve-mlx/issues/new)

---

## Archive

Historical documents (for reference only):
- [CORE-ISSUES-RESOLVED.md](./archive/CORE-ISSUES-RESOLVED.md) - Bug fix history (18 bugs resolved)

---

**Document Version**: 2.2
**Last Updated**: 2025-11-10
**Documentation Files**: 11 active files
**Maintained By**: mlx-serving Team

**Phase 3 Complete**: All documentation modernized with Week 7 and Phase 2-5 features
