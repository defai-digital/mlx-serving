# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**mlx-serving** is a modern TypeScript MLX serving engine for Apple Silicon, refactored from kr-serve-mlx v1.4.2 with systematic Zod validation and planned ReScript state management.

**Key Technologies:**
- TypeScript (Node.js 22+, strict mode, NodeNext module resolution)
- Python 3.11+ runtime (MLX model inference via JSON-RPC)
- Zod v3.22.4 for runtime validation
- Vitest for testing
- Apple Silicon M3+ required (Metal 3.3+)

**Current Status:** Phase 1 Complete (Zod Integration + Performance Optimizations) - 389+ tests passing

---

## Essential Commands

### Build & Development
```bash
# Full build (TypeScript → ESM + CJS + DTS)
npm run build

# Type checking only (no build)
npm run typecheck

# Lint (ESLint with max-warnings=0)
npm run lint

# Format code
npm run format

# Watch mode for development
npm run dev
```

### Testing
```bash
# Run all tests (Vitest)
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Coverage report (80% threshold)
npm run test:coverage

# Run specific test file
npx vitest run tests/unit/validation/model-schema.test.ts

# Run tests matching pattern
npx vitest run --grep "LoadModelOptions"
```

### Python Environment Setup
```bash
# Initialize Python virtual environment (.kr-mlx-venv)
npm run setup

# Alternative: Direct script execution
npm run prepare:python

# Setup MLX engine (downloads dependencies)
npm run setup:mlx-engine
```

### Native Module (Optional C++ Acceleration)
```bash
# Build native module (5-60% performance boost)
cd native && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .

# Or use the script
bash scripts/build-native.sh
```

### Benchmarks
```bash
# Flexible benchmark tool (customizable)
npm run bench:flexible

# Quick test (10 questions)
npm run bench:quick

# Comparison test (100 questions, both engines)
npm run bench:compare

# Run specific benchmark
npm run bench:ipc
npm run bench:ttft
npm run bench:throughput

# Run all benchmarks
npm run bench:all

# Generate markdown report
npm run bench:report

# Comparison benchmarks
npm run bench:apple-to-apple
npm run bench:50-questions
npm run bench:100-questions

# Custom flexible benchmark
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --compare both \
  --output results/custom.json
```

---

## Architecture

### High-Level Data Flow

```
TypeScript API (src/api/)
    ↓ Zod validation
State Management (src/core/)
    ↓ JSON-RPC over stdio
Python Runtime (python/)
    ↓ MLX Python bindings
Metal GPU (Apple Silicon)
```

### Directory Structure

```
src/
├── api/              # Public-facing Engine API
│   ├── engine.ts     # Main Engine class (high-level facade)
│   ├── mlx-engine.ts # Simplified MLXEngine wrapper
│   └── errors.ts     # Error types & Zod error conversion
├── bridge/           # TypeScript ↔ Python IPC
│   ├── python-runner.ts      # Python process lifecycle
│   ├── jsonrpc-transport.ts  # JSON-RPC message handling
│   ├── ops-multiplexer.ts    # Request routing
│   └── stream-registry.ts    # Streaming response management
├── core/             # Core services & state management
│   ├── model-manager.ts         # Model loading/unloading
│   ├── batch-queue.ts           # Request batching
│   ├── generate-batcher.ts      # Generation request batching
│   ├── generator-factory.ts     # Generator creation
│   ├── coalescing-registry.ts   # Request coalescing (Phase 1)
│   ├── prompt-cache.ts          # LRU cache with TTL (Phase 1)
│   └── request-deduplicator.ts  # Request deduplication (Phase 1)
├── types/            # TypeScript types & Zod schemas
│   ├── schemas/      # Zod validation schemas (Phase 1)
│   │   ├── common.ts
│   │   ├── model.ts
│   │   ├── generator.ts
│   │   ├── tokenizer.ts
│   │   ├── config.ts
│   │   ├── jsonrpc.ts
│   │   ├── telemetry.ts
│   │   └── events.ts
│   └── *.ts          # TypeScript interfaces
├── config/           # Runtime configuration loader
├── utils/            # Utilities (model downloader, image encoding)
├── telemetry/        # OpenTelemetry integration
└── services/         # High-level services

python/
├── runtime.py        # Main Python JSON-RPC server
├── models/           # MLX model loaders
├── adapters/         # Outlines adapter (structured output)
├── gpu_scheduler.py  # GPU scheduling to prevent crashes
└── native/           # C++ native module bindings (optional)

native/               # C++ acceleration (Metal command buffer pooling)
├── CMakeLists.txt
├── src/              # C++ implementation
├── bindings/         # pybind11 Python bindings
└── include/          # Headers

tests/
├── unit/             # Unit tests (mocked dependencies)
├── integration/      # Integration tests (real Python runtime)
├── security/         # Security/vulnerability tests
├── contracts/        # API contract tests
└── helpers/          # Test utilities
```

### Key Architectural Concepts

**1. JSON-RPC Bridge Pattern**
- TypeScript communicates with Python via JSON-RPC over stdio
- `JsonRpcTransport` handles message serialization/deserialization
- `OpsMultiplexer` routes requests to correct handler
- Streaming responses managed by `StreamRegistry`

**2. Zod Validation (Phase 1 - Complete)**
- All API boundaries validated at runtime with Zod schemas
- Located in `src/types/schemas/`
- See `docs/ZOD_SCHEMAS.md` for comprehensive guide
- Pattern: Normalize → Validate → Execute

**3. State Management**
- Circuit breakers prevent cascading failures
- Request queuing prevents Metal GPU crashes
- Batch queue optimizes throughput
- Stream registry manages backpressure

**4. Model Loading**
- Models cached in `~/.cache/huggingface/hub/`
- `ModelManager` handles load/unload lifecycle
- Support for draft models (speculative decoding)
- Vision models supported (LLaVA, Qwen-VL, Phi-3-Vision)

**5. Performance Optimizations (Phase 1)**
- **Request Deduplication**: Collapses identical concurrent requests into shared Promises (1s TTL)
- **Prompt Cache**: LRU cache with 5-minute TTL for repeated prompts (10k entries)
- **Request Coalescing**: Multiplexes streaming responses to multiple subscribers
- All optimizations feature-flagged and disabled by default

---

## Phase 1 Performance Optimizations

Phase 1 introduces three caching layers to improve throughput on duplicate-heavy workloads:

### 1. Request Deduplicator (`src/core/request-deduplicator.ts`)

**Purpose**: Collapse identical concurrent requests into a shared Promise to avoid redundant Python invocations.

**How it works**:
- Uses SHA256 fingerprinting of request parameters (model, prompt, temperature, etc.)
- Maintains a TTL-based Map<fingerprint, Promise<GenerateResponse>>
- First request creates Promise, concurrent identical requests share it
- 1-second TTL by default
- Automatic rejection propagation prevents cache poisoning

**Configuration** (`config/runtime.yaml`):
```yaml
request_deduplication:
  enabled: false  # Default disabled for safety
  ttl_ms: 1000
  max_entries: 1000
  max_payload_bytes: 1048576  # 1MB
```

**When to use**: High concurrency with duplicate requests (e.g., load testing, rate limiting)

### 2. Prompt Cache (`src/core/prompt-cache.ts`)

**Purpose**: Long-lived cache for completed generation results, providing faster-than-backend responses.

**How it works**:
- LRU eviction with configurable capacity (default: 10k entries)
- Size-aware eviction (tracks tokens + bytes)
- 5-minute TTL by default
- Optional disk persistence for cache survival across restarts
- Automatic cleanup timer removes expired entries

**Configuration** (`config/runtime.yaml`):
```yaml
prompt_cache:
  enabled: false  # Default disabled for safety
  max_entries: 10000
  max_total_tokens: 100000000
  max_total_bytes: 1073741824  # 1GB
  ttl_ms: 300000  # 5 minutes
  cleanup_interval_ms: 30000
  persistence:
    enabled: false
    path: ".cache/prompt-cache.json"
    save_interval_ms: 60000
```

**When to use**: Workloads with frequently repeated prompts (e.g., chatbots, documentation Q&A)

### 3. Request Coalescing Registry (`src/core/coalescing-registry.ts`)

**Purpose**: Multiplex streaming responses from a single backend invocation to multiple subscribers.

**How it works**:
- Tracks in-flight requests by fingerprint
- Shares a single Python inference call across N concurrent clients
- Each subscriber gets its own ReadableStream
- Primary stream chunks broadcast to all active subscribers
- Backpressure-aware with automatic cleanup

**Configuration** (`config/runtime.yaml`):
```yaml
request_coalescing:
  enabled: false  # Default disabled for safety
  max_subscribers: 100
  timeout: 5000  # 5 seconds
```

**When to use**: Multiple clients requesting identical streaming generations simultaneously

### Feature Flags

All Phase 1 optimizations are **disabled by default** for safety. Enable via `config/runtime.yaml`:

```yaml
# Enable all Phase 1 optimizations
request_deduplication:
  enabled: true

prompt_cache:
  enabled: true

request_coalescing:
  enabled: true
```

### Monitoring Performance

Check optimization effectiveness:

```typescript
// Request Deduplicator stats
const dedupStats = deduplicator.getStats();
console.log(`Hit rate: ${dedupStats.hitRate * 100}%`);

// Prompt Cache stats
const cacheStats = promptCache.getStats();
console.log(`Cache hit rate: ${cacheStats.hitRate * 100}%`);
console.log(`Size: ${cacheStats.size} / ${cacheStats.maxEntries}`);

// Coalescing Registry stats
const coalescingStats = coalescingRegistry.getStats();
console.log(`Coalescing ratio: ${coalescingStats.coalescingRatio * 100}%`);
```

### Benchmarking Performance Gains

Use the flexible benchmark tool to measure improvements:

```bash
# Baseline (optimizations disabled)
npx tsx benchmarks/flexible-benchmark.ts \
  --questions 100 \
  --compare mlx-serving

# With optimizations enabled
# (edit config/runtime.yaml first)
npx tsx benchmarks/flexible-benchmark.ts \
  --questions 100 \
  --compare mlx-serving
```

**Expected gains**:
- Request Deduplication: 10-20% on duplicate-heavy workloads
- Prompt Cache: 50-80% on repeated prompts (after warm-up)
- Request Coalescing: 10-30% on concurrent identical requests

---

## Working with Zod Schemas

### Schema Locations
All Zod schemas are in `src/types/schemas/`:
- `model.ts` - LoadModelOptions, ModelDescriptor
- `generator.ts` - GeneratorParams, structured output
- `tokenizer.ts` - TokenizeRequest, TokenizeResponse
- `config.ts` - RuntimeConfig (60+ properties)
- `jsonrpc.ts` - JSON-RPC message validation
- `telemetry.ts` - OpenTelemetry configuration
- `events.ts` - Event payload schemas

### Adding New Validation
1. Define schema in appropriate file under `src/types/schemas/`
2. Export from `src/types/schemas/index.ts`
3. Use `.safeParse()` for validation with error handling
4. Convert Zod errors to EngineClientError via `zodErrorToEngineError()`
5. Add tests in `tests/unit/validation/`

### Validation Pattern
```typescript
import { LoadModelOptionsSchema } from '@/types/schemas/index.js';
import { zodErrorToEngineError } from '@/api/errors.js';

// Validate input
const result = LoadModelOptionsSchema.safeParse(options);
if (!result.success) {
  throw zodErrorToEngineError(result.error, 'VALIDATION_ERROR');
}

// Use validated data
const validated = result.data;
```

---

## Testing Guidelines

### Test Organization
- **Unit tests** (`tests/unit/`) - Mock all external dependencies
- **Integration tests** (`tests/integration/`) - Real Python runtime required
- **Security tests** (`tests/security/`) - Vulnerability testing
- **Contract tests** (`tests/contracts/`) - API compatibility

### Running Integration Tests
Integration tests require Python environment:
```bash
# Setup Python first
npm run setup

# Run all tests (includes integration)
npm test

# Run only integration tests
npx vitest run tests/integration/
```

### Test File Naming
- Unit: `*.test.ts` in `tests/unit/`
- Integration: `*.test.ts` in `tests/integration/`
- Follow existing structure: `tests/unit/validation/model-schema.test.ts`

### Mocking
- Use Vitest's `vi.mock()` for external dependencies
- Mock file: `tests/helpers/mock-runner.ts`
- Always isolate tests with `poolOptions.threads.isolate = true`

---

## Path Aliases

TypeScript path aliases (configured in `tsconfig.json`):
```typescript
import { Engine } from '@/api/engine.js';
import { ModelManager } from '@core/model-manager.js';
import { LoadModelOptionsSchema } from '@types/schemas/index.js';
import { PythonRunner } from '@bridge/python-runner.js';
```

**Important:** Always use `.js` extension in imports (even for `.ts` files) for ESM compatibility.

---

## Python Runtime

### Python Process Lifecycle
1. `PythonRunner` spawns Python subprocess running `python/runtime.py`
2. Communication via JSON-RPC over stdin/stdout
3. Python loads MLX models, performs inference
4. TypeScript receives streaming tokens via JSON-RPC

### Python Environment
- Virtual environment: `.kr-mlx-venv/`
- Dependencies: `python/requirements.txt`
- MLX framework version: >=3.3.0
- Auto-setup on `npm install` via `scripts/postinstall.cjs`

### Debugging Python Runtime
```bash
# Enable Python debug logging
export KR_MLX_LOG_LEVEL=debug

# Run Python runtime directly (for testing)
source .kr-mlx-venv/bin/activate
python python/runtime.py
```

---

## Planning Documents

All planning documents are in `automatosx/PRD/`:
- **mlx-serving-performance-optimization-prd.md** - Performance optimization PRD
- **mlx-serving-performance-optimization-action-plan.md** - Detailed action plan
- **PHASE1-IMPLEMENTATION-GUIDE.md** - Phase 1 caching layer implementation guide
- **PERFORMANCE-OPTIMIZATION-OVERVIEW.md** - Performance optimization overview
- **IMPLEMENTATION-PLAN.md** - Overall implementation plan

**Technical documentation:**
- `docs/ZOD_SCHEMAS.md` - Comprehensive Zod validation guide
- `docs/ARCHITECTURE.md` - Detailed architecture
- `docs/GUIDES.md` - User guides (migration, structured output, vision)
- `docs/DEPLOYMENT.md` - Deployment guide

---

## Common Development Tasks

### Adding a New API Method
1. Add method signature to `src/types/engine.ts` interface
2. Add Zod schema to appropriate file in `src/types/schemas/`
3. Implement in `src/api/engine.ts`
4. Add Python handler in `python/runtime.py` if needed
5. Add tests in `tests/unit/` and `tests/integration/`
6. Update `docs/ZOD_SCHEMAS.md` if new schema added

### Modifying Validation
1. Update schema in `src/types/schemas/`
2. Run `npm run typecheck` to verify types
3. Run `npm test` to verify all tests pass
4. Update tests in `tests/unit/validation/` if needed

### Debugging JSON-RPC Issues
1. Enable debug logging: `export KR_MLX_LOG_LEVEL=debug`
2. Check `src/bridge/jsonrpc-transport.ts` for message handling
3. Check `src/bridge/ops-multiplexer.ts` for request routing
4. Check Python side: `python/runtime.py`

### Performance Optimization
1. Check batch queue settings in `src/core/batch-queue.ts`
2. Enable Phase 1 optimizations in `config/runtime.yaml`:
   - `request_deduplication.enabled: true`
   - `prompt_cache.enabled: true`
   - `request_coalescing.enabled: true`
3. Consider native module: `native/` (5-60% speedup)
4. Profile with: `bash scripts/profile-system.sh`
5. Run benchmarks: `npm run bench:all` or `npm run bench:flexible`
6. Monitor cache stats via telemetry/metrics endpoints

### Running Custom Benchmarks
The flexible benchmark tool allows testing any MLX model with custom parameters:

```bash
# Quick 10-question test
npm run bench:quick

# Compare both engines (100 questions)
npm run bench:compare

# Custom benchmark with specific model
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions 50 \
  --max-tokens 200 \
  --temp 0.7 \
  --compare both

# Save results to file
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --output automatosx/tmp/benchmark-results.json
```

Available flags:
- `--model` or `-m`: Model name or path
- `--questions` or `-q`: Number of questions (1-10000+)
- `--compare` or `-c`: Engine to test (mlx-serving, mlx-engine, or both)
- `--max-tokens`: Max tokens per generation (default: 100)
- `--temp`: Temperature (default: 0.7)
- `--output` or `-o`: Output file path
- `--verbose` or `-v`: Verbose logging

---

## Git Workflow

### Branch Strategy
- Main branch: `main`
- Current status: Phase 1 complete (Zod + Performance), 389+ tests passing

### Commit Message Format
Follow conventional commits:
```
<type>: <description>

Examples:
feat: Add Zod validation for GeneratorParams
fix: Fix race condition in StreamRegistry
docs: Update ZOD_SCHEMAS.md with new examples
test: Add integration tests for vision models
refactor: Simplify error handling in Engine
```

---

## System Requirements

**IMPORTANT:** This project requires:
- **macOS 26.0+** (Darwin 25.0.0+)
- **Apple Silicon M3 or newer** (M3 Pro/Max/Ultra recommended)
- **Node.js 22.0.0+**
- **Python 3.11-3.12**
- **Metal 3.3+** (included in macOS 26.0+)

The package will fail to install on non-Apple Silicon systems.

---

#

# AutomatosX Integration

This project uses [AutomatosX](https://github.com/defai-digital/automatosx) - an AI agent orchestration platform with persistent memory and multi-agent collaboration.

## Quick Start

### Available Commands

```bash
# List all available agents
ax list agents

# Run an agent with a task
ax run <agent-name> "your task description"

# Example: Ask the backend agent to create an API
ax run backend "create a REST API for user management"

# Search memory for past conversations
ax memory search "keyword"

# View system status
ax status
```

### Using AutomatosX in Claude Code

You can interact with AutomatosX agents directly in Claude Code using natural language:

**Natural Language Examples**:
```
"Please work with ax agent backend to implement user authentication"
"Ask the ax security agent to audit this code for vulnerabilities"
"Have the ax quality agent write tests for this feature"
"Use ax agent product to design this new feature"
"Work with ax agent devops to set up the deployment pipeline"
```

Claude Code will understand your intent and invoke the appropriate AutomatosX agent for you. Just describe what you need in natural language - no special commands required!

### Available Agents

This project includes the following specialized agents:

- **backend** (Bob) - Backend development (Go/Rust systems)
- **frontend** (Frank) - Frontend development (React/Next.js/Swift)
- **architecture** (Avery) - System architecture and ADR management
- **fullstack** (Felix) - Full-stack development (Node.js/TypeScript)
- **mobile** (Maya) - Mobile development (iOS/Android, Swift/Kotlin/Flutter)
- **devops** (Oliver) - DevOps and infrastructure
- **security** (Steve) - Security auditing and threat modeling
- **data** (Daisy) - Data engineering and ETL
- **quality** (Queenie) - QA and testing
- **design** (Debbee) - UX/UI design
- **writer** (Wendy) - Technical writing
- **product** (Paris) - Product management
- **cto** (Tony) - Technical strategy
- **ceo** (Eric) - Business leadership
- **researcher** (Rodman) - Research and analysis
- **data-scientist** (Dana) - Machine learning and data science
- **aerospace-scientist** (Astrid) - Aerospace engineering and mission design
- **quantum-engineer** (Quinn) - Quantum computing and algorithms
- **creative-marketer** (Candy) - Creative marketing and content strategy
- **standard** (Stan) - Standards and best practices expert

For a complete list with capabilities, run: `ax list agents --format json`

## Key Features

### 1. Persistent Memory

AutomatosX agents remember all previous conversations and decisions:

```bash
# First task - design is saved to memory
ax run product "Design a calculator with add/subtract features"

# Later task - automatically retrieves the design from memory
ax run backend "Implement the calculator API"
```

### 2. Multi-Agent Collaboration

Agents can delegate tasks to each other automatically:

```bash
ax run product "Build a complete user authentication feature"
# → Product agent designs the system
# → Automatically delegates implementation to backend agent
# → Automatically delegates security audit to security agent
```

### 3. Cross-Provider Support

AutomatosX supports multiple AI providers with automatic fallback:
- **Claude** (Anthropic) - Primary provider for Claude Code users
- **Gemini** (Google) - Alternative provider
- **OpenAI** (GPT) - Alternative provider

Configuration is in `automatosx.config.json`.

## Configuration

### Project Configuration

Edit `automatosx.config.json` to customize:

```json
{
  "providers": {
    "claude-code": {
      "enabled": true,
      "priority": 1
    },
    "gemini-cli": {
      "enabled": true,
      "priority": 2
    }
  },
  "execution": {
    "defaultTimeout": 1500000,  // 25 minutes
    "maxRetries": 3
  },
  "memory": {
    "enabled": true,
    "maxEntries": 10000
  }
}
```

### Agent Customization

Create custom agents in `.automatosx/agents/`:

```bash
ax agent create my-agent --template developer --interactive
```

### Workspace Conventions

**IMPORTANT**: AutomatosX uses specific directories for organized file management. Please follow these conventions when working with agents:

- **`automatosx/PRD/`** - Product Requirements Documents, design specs, and planning documents
  - Use for: Architecture designs, feature specs, technical requirements
  - Example: `automatosx/PRD/auth-system-design.md`

- **`automatosx/tmp/`** - Temporary files, scratch work, and intermediate outputs
  - Use for: Draft code, test outputs, temporary analysis
  - Auto-cleaned periodically
  - Example: `automatosx/tmp/draft-api-endpoints.ts`

**Usage in Claude Code**:
```
"Please save the architecture design to automatosx/PRD/user-auth-design.md"
"Put the draft implementation in automatosx/tmp/auth-draft.ts for review"
"Work with ax agent backend to implement the spec in automatosx/PRD/api-spec.md"
```

These directories are automatically created by `ax setup` and included in `.gitignore` appropriately.

## Memory System

### Search Memory

```bash
# Search for past conversations
ax memory search "authentication"
ax memory search "API design"

# List recent memories
ax memory list --limit 10

# Export memory for backup
ax memory export > backup.json
```

### How Memory Works

- **Automatic**: All agent conversations are saved automatically
- **Fast**: SQLite FTS5 full-text search (< 1ms)
- **Local**: 100% private, data never leaves your machine
- **Cost**: $0 (no API calls for memory operations)

## Advanced Usage

### Parallel Execution (v5.6.0+)

Run multiple agents in parallel for faster workflows:

```bash
ax run product "Design authentication system" --parallel
```

### Resumable Runs (v5.3.0+)

For long-running tasks, enable checkpoints:

```bash
ax run backend "Refactor entire codebase" --resumable

# If interrupted, resume with:
ax resume <run-id>

# List all runs
ax runs list
```

### Streaming Output (v5.6.5+)

See real-time output from AI providers:

```bash
ax run backend "Explain this codebase" --streaming
```

### Spec-Driven Development (v5.8.0+)

For complex projects, use spec-driven workflows:

```bash
# Create spec from natural language
ax spec create "Build authentication with database, API, JWT, and tests"

# Or manually define in .specify/tasks.md
ax spec run --parallel

# Check progress
ax spec status
```

## Troubleshooting

### Common Issues

**"Agent not found"**
```bash
# List available agents
ax list agents

# Make sure agent name is correct
ax run backend "task"  # ✓ Correct
ax run Backend "task"  # ✗ Wrong (case-sensitive)
```

**"Provider not available"**
```bash
# Check system status
ax status

# View configuration
ax config show
```

**"Out of memory"**
```bash
# Clear old memories
ax memory clear --before "2024-01-01"

# View memory stats
ax cache stats
```

### Getting Help

```bash
# View command help
ax --help
ax run --help

# Enable debug mode
ax --debug run backend "task"

# Search memory for similar past tasks
ax memory search "similar task"
```

## Best Practices

1. **Use Natural Language in Claude Code**: Let Claude Code coordinate with agents for complex tasks
2. **Leverage Memory**: Reference past decisions and designs
3. **Start Simple**: Test with small tasks before complex workflows
4. **Review Configurations**: Check `automatosx.config.json` for timeouts and retries
5. **Keep Agents Specialized**: Use the right agent for each task type

## Documentation

- **AutomatosX Docs**: https://github.com/defai-digital/automatosx
- **Agent Directory**: `.automatosx/agents/`
- **Configuration**: `automatosx.config.json`
- **Memory Database**: `.automatosx/memory/memories.db`
- **Workspace**: `automatosx/PRD/` (planning docs) and `automatosx/tmp/` (temporary files)

## Support

- Issues: https://github.com/defai-digital/automatosx/issues
- NPM: https://www.npmjs.com/package/@defai.digital/automatosx


# List all available agents
ax list agents

# Run an agent with a task
ax run <agent-name> "your task description"

# Example: Ask the backend agent to create an API
ax run backend "create a REST API for user management"

# Search memory for past conversations
ax memory search "keyword"

# View system status
ax status
```

### Using AutomatosX in Claude Code

You can interact with AutomatosX agents directly in Claude Code using natural language:

```
"Please work with ax agent backend to implement user authentication"
"Ask the ax security agent to audit this code for vulnerabilities"
"Have the ax quality agent write tests for this feature"
"Use ax agent product to design this new feature"
"Work with ax agent devops to set up the deployment pipeline"
```

### Available Agents

This project includes specialized agents: backend, frontend, architecture, fullstack, mobile, devops, security, data, quality, design, writer, product, cto, ceo, researcher, data-scientist, and more.

For a complete list with capabilities, run: `ax list agents --format json`

### Workspace Conventions

AutomatosX uses specific directories for organized file management:

- **`automatosx/PRD/`** - Product Requirements Documents, design specs, and planning documents
  - Use for: Architecture designs, feature specs, technical requirements
  - Example: `automatosx/PRD/auth-system-design.md`

- **`automatosx/tmp/`** - Temporary files, scratch work, and intermediate outputs
  - Use for: Draft code, test outputs, temporary analysis
  - Auto-cleaned periodically
  - Example: `automatosx/tmp/draft-api-endpoints.ts`

### Documentation

- **AutomatosX Docs**: https://github.com/defai-digital/automatosx
- **Configuration**: `automatosx.config.json`
- **Memory Database**: `.automatosx/memory/memories.db`

---

## Additional Resources

- **GitHub**: https://github.com/defai-digital/mlx-serving
- **Issues**: https://github.com/defai-digital/mlx-serving/issues
- **MLX Framework**: https://github.com/ml-explore/mlx
- **Zod Documentation**: https://zod.dev
