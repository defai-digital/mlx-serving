# Documentation Index

**kr-serve-mlx** - Production-Grade LLM Serving Engine for Apple Silicon

---

## Quick Navigation

| Document | Description | Size |
|----------|-------------|------|
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Complete architecture, M3+ strategy, distributed design | 18K |
| **[GUIDES.md](./GUIDES.md)** | User guides (migration, structured output, vision models) | 17K |
| **[DEPLOYMENT.md](./DEPLOYMENT.md)** | Deployment and operations guide | 10K |
| **[INDEX.md](./INDEX.md)** | This document (documentation map) | 4K |

---

## Getting Started

### New Users
1. [README](../README.md) - Project overview, why M3+?, quick start
2. [GETTING_STARTED](../GETTING_STARTED.md) - Detailed setup guide
3. [GUIDES.md](./GUIDES.md#quick-reference) - Quick reference commands

### Migrating from mlx-engine
1. [GUIDES.md - Migration Guide](./GUIDES.md#migration-guide) - Complete migration tutorial
2. [Examples](../examples/migration/) - Side-by-side code examples

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

### Operations

**[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment and operations guide:
- System requirements (M3+, macOS 26.0+)
- Installation and setup
- Production deployment patterns
- Monitoring and troubleshooting

---

## Examples

All examples located in [`examples/`](../examples/):

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
| [`automatosx.config.json`](../automatosx.config.json) | AutomatosX agent configuration |

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

**Test Status**: 229/252 passing (90.9%)
- Environment-independent: 229 passing
- Vision tests: Require MLX + GPU (14 tests)
- Known issues: batch-queue tests (unhandled rejections, under investigation)

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
└── .automatosx/           # AutomatosX agent definitions

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

**Document Version**: 2.0
**Last Updated**: 2025-10-28
**Documentation Reduced**: 14 files → 4 active files (71% reduction)
**Maintained By**: KnowRAG Studio - kr-serve-mlx Team
