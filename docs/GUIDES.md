# mlx-serving User Guides

**Version**: 2.1
**Date**: 2025-11-10

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Week 7 Performance Optimizations](#week-7-performance-optimizations)
3. [Production Features (Phases 2-5)](#production-features-phases-2-5)
4. [Migration Guide (mlx-engine → mlx-serving)](#migration-guide)
5. [Structured Output with Outlines](#structured-output-with-outlines)
6. [Vision Models](#vision-models)
7. [Quick Reference](#quick-reference)

---

## Quick Start

**Get started with mlx-serving in 5 minutes**

See [QUICK_START.md](./QUICK_START.md) for the fastest path to using mlx-serving.

### Installation

```bash
npm install @defai.digital/mlx-serving
# Python environment is automatically set up via postinstall
```

> **Note**: The postinstall script automatically configures the Python environment. You don't need to run `npm run setup` manually.

### Understanding Generation Methods

mlx-serving provides two methods for text generation:

#### Streaming with `createGenerator()` (Real-time Output)

Use `createGenerator()` when you want to process tokens as they're generated:

```typescript
const generator = engine.createGenerator({
  prompt: "Hello",
  maxTokens: 50
});

for await (const chunk of generator) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token); // Process each token in real-time
  }
}
```

**Best for**: Chat interfaces, streaming responses, progressive UI updates

#### Non-Streaming with `generate()` (Complete Response)

Use `generate()` when you want the complete text all at once:

```typescript
const text = await engine.generate({
  prompt: "Hello",
  maxTokens: 50
});

console.log(text); // Complete response as string
```

**Best for**: Structured output (JSON, XML), batch processing, when you need the full response before continuing

> **Important**: When using structured output with `guidance` (JSON schema, regex, etc.), you must use `generate()` as it returns the complete validated result.

### Hello World Example

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

// Load the model first
await engine.loadModel({ model: 'mlx-community/Llama-3.2-3B-Instruct-4bit' });

// Stream tokens in real-time
const generator = engine.createGenerator({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  prompt: 'What is the capital of France?',
  maxTokens: 50,
});

for await (const chunk of generator) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}

console.log('\n'); // New line after streaming

// Clean shutdown
await engine.shutdown();
```

**Run**: `npx tsx your-file.ts`

---

## Week 7 Performance Optimizations

**Benchmark-driven optimizations for production workloads**

Complete guide: [PERFORMANCE.md](./PERFORMANCE.md)

### Key Features

1. **[Model Preloading](./PERFORMANCE.md#model-preloading)** - Zero first-request latency (104x faster)
2. **[Object Pooling](./PERFORMANCE.md#object-pooling)** - 20% GC reduction
3. **[Adaptive Batching](./PERFORMANCE.md#adaptive-batching)** - 10-15% throughput improvement
4. **[FastJsonCodec](./PERFORMANCE.md#fastjsoncodec)** - 2-3x faster JSON serialization

### Quick Configuration

Edit `config/runtime.yaml`:

```yaml
# Model Preloading: Zero first-request latency
model_preload:
  enabled: true
  models:
    - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"
      warmup_requests: 3
      max_tokens: 10

# Adaptive Batching: 10-15% throughput boost
batch_queue:
  enabled: true
  adaptive_sizing: true
```

**Performance Gains**:
- **TTFT**: 12.5% faster
- **Throughput**: 20% improvement
- **First Request**: 104x faster (5,200ms → 50ms with preloading)

### Examples

- [Model Preloading Example](../examples/performance/01-model-preloading.ts)
- [Object Pooling Example](../examples/performance/02-object-pooling.ts)
- [Adaptive Batching Example](../examples/performance/03-adaptive-batching.ts)

See [examples/performance/](../examples/performance/) for complete code examples.

---

## Production Features (Phases 2-5)

**Enterprise-grade production features**

Complete guide: [PRODUCTION_FEATURES.md](./PRODUCTION_FEATURES.md)

### Key Features

1. **[TTFT Acceleration Pipeline](./PRODUCTION_FEATURES.md#ttft-acceleration-pipeline)** - 30-40% TTFT reduction
   - Tokenizer warm queue (20-30ms improvement)
   - First-token speculation (50-100ms for repeated prompts)
   - KV cache prefetch (experimental)

2. **[QoS Monitoring](./PRODUCTION_FEATURES.md#qos-monitoring)** - SLO enforcement & auto-remediation
   - Real-time SLO monitoring (TTFT P99, throughput)
   - Policy-based remediation (scale up/down, reject requests)
   - TDigest percentile tracking

3. **[Canary Deployment](./PRODUCTION_FEATURES.md#canary-deployment)** - Zero-downtime rollouts
   - Hash-based traffic splitting
   - Automatic rollback on violations
   - Progressive rollout (1% → 10% → 50% → 100%)

4. **[Feature Flags](./FEATURE_FLAGS.md)** - Gradual percentage-based rollout
   - Deterministic hash routing
   - Independent sub-feature control
   - Emergency kill switch

### Quick Configuration

Edit `config/feature-flags.yaml`:

```yaml
# TTFT Pipeline
ttft_pipeline:
  enabled: true
  rollout_percentage: 100
  warmup_queue:
    enabled: true

# QoS Monitoring
qos_monitor:
  enabled: true
  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false

# Canary Deployment
canary:
  enabled: true
  rolloutPercentage: 10  # 10% canary traffic
```

### Examples

- [QoS Monitoring Example](../examples/production/01-qos-monitoring.ts)
- [Canary Deployment Example](../examples/production/02-canary-deployment.ts)
- [Feature Flags Example](../examples/production/03-feature-flags.ts)

See [examples/production/](../examples/production/) for complete code examples.

---

## Migration Guide

### For Python mlx-engine Users

**mlx-serving provides 100% API compatibility** with mlx-engine while adding TypeScript type safety and async/await support.

### Installation

```bash
# Python mlx-engine (before)
pip install mlx-engine

# TypeScript mlx-serving (after)
npm install @defai.digital/mlx-serving
npm run setup  # Sets up Python runtime
```

### Basic Usage Comparison

#### Python (mlx-engine)

```python
from mlx_engine import Engine

engine = Engine()
model = engine.load_model("meta-llama/Llama-3.1-8B-Instruct")

for token in engine.generate(prompt="Hello"):
    print(token, end="", flush=True)
```

#### TypeScript (mlx-serving) - Python-Compatible

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

await engine.load_model({
  model: "meta-llama/Llama-3.1-8B-Instruct"
});

for await (const chunk of engine.create_generator({ prompt: "Hello" })) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}

await engine.dispose();
```

#### TypeScript (mlx-serving) - Native Style

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

await engine.loadModel({
  model: "meta-llama/Llama-3.1-8B-Instruct"
});

for await (const chunk of engine.createGenerator({ prompt: "Hello" })) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}

await engine.dispose();
```

### Parameter Mapping

**Full snake_case compatibility** for mlx-engine users:

| mlx-engine | mlx-serving (snake_case) | mlx-serving (camelCase) |
|------------|--------------------------|-------------------------|
| `max_tokens` | `max_tokens` ✅ | `maxTokens` |
| `top_p` | `top_p` ✅ | `topP` |
| `presence_penalty` | `presence_penalty` ✅ | `presencePenalty` |
| `frequency_penalty` | `frequency_penalty` ✅ | `frequencyPenalty` |
| `repetition_penalty` | `repetition_penalty` ✅ | `repetitionPenalty` |
| `stop_sequences` | `stop_sequences` ✅ | `stopSequences` |
| `stop_token_ids` | `stop_token_ids` ✅ | `stopTokenIds` |
| `add_bos` | `add_bos` ✅ | `addBos` |

**Aliases supported**:
- `stream` → `streaming`
- `model_id` → `model`
- `add_special_tokens` → `addBos`

### Method Mapping

| mlx-engine | mlx-serving (snake_case) | mlx-serving (camelCase) |
|------------|--------------------------|-------------------------|
| `load_model()` | `load_model()` | `loadModel()` |
| `unload_model()` | `unload_model()` | `unloadModel()` |
| `load_draft_model()` | `load_draft_model()` | `loadDraftModel()` |
| `unload_draft_model()` | `unload_draft_model()` | `unloadDraftModel()` |
| `is_draft_model_compatible()` | `is_draft_model_compatible()` | `isDraftModelCompatible()` |
| `generate()` | `create_generator()` | `createGenerator()` |
| `tokenize()` | `tokenize()` | `tokenize()` |
| `load_vision_model()` | `load_vision_model()` | `loadVisionModel()` |
| `generate_vision()` | `create_vision_generator()` | `createVisionGenerator()` |

### Migration Examples

#### Example 1: Basic Text Generation

**Before (mlx-engine)**:
```python
from mlx_engine import Engine

engine = Engine()
engine.load_model({"model": "llama-8b", "max_tokens": 100})

for token in engine.generate({"prompt": "Hello", "temperature": 0.7}):
    print(token, end="")
```

**After (mlx-serving)**:
```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();
await engine.load_model({ model: "llama-8b", max_tokens: 100 });

for await (const chunk of engine.create_generator({
  prompt: "Hello",
  temperature: 0.7
})) {
  if (chunk.type === 'token') process.stdout.write(chunk.token);
}

await engine.dispose();
```

#### Example 2: Draft Model (Speculative Decoding)

**Before (mlx-engine)**:
```python
engine.load_model({"model": "llama-70b"})
engine.load_draft_model({"model": "llama-8b"})

for token in engine.generate({"prompt": "Explain AI"}):
    print(token, end="")
```

**After (mlx-serving)**:
```typescript
await engine.load_model({ model: "llama-70b" });
await engine.load_draft_model({ model: "llama-8b" });

for await (const chunk of engine.create_generator({ prompt: "Explain AI" })) {
  if (chunk.type === 'token') process.stdout.write(chunk.token);
}
```

### Key Differences

**Async/Await**:
- mlx-engine: Synchronous API
- mlx-serving: All operations are `async` → Use `await`

**Generator Pattern**:
- mlx-engine: `for token in engine.generate()`
- mlx-serving: `for await (const chunk of engine.create_generator())`
  - Check `chunk.type === 'token'` before using `chunk.token`

**Resource Management**:
- mlx-engine: Manual cleanup or context manager
- mlx-serving: Call `await engine.dispose()` or use `withEngine()` helper

**Context Manager Equivalent**:
```typescript
import { withEngine } from '@defai.digital/mlx-serving';

const result = await withEngine(async (engine) => {
  await engine.load_model({ model: "llama-8b" });
  
  let text = '';
  for await (const chunk of engine.create_generator({ prompt: "Hi" })) {
    if (chunk.type === 'token') text += chunk.token;
  }
  
  return text;  // Engine auto-disposed after this
});
```

### Migration Time Estimate

- **Simple projects** (1-2 models, basic generation): **15-30 minutes**
- **Medium projects** (multiple models, advanced features): **1-2 hours**
- **Large projects** (complex workflows, custom integrations): **4-8 hours**

**vs Manual rewrite**: 4-8 hours → **Up to 16x faster migration**

---

## Structured Output with Outlines

### Overview

**Structured output** constrains the model to produce valid JSON or XML, guaranteeing format compliance at generation time.

**Use Cases**:
- API responses (guaranteed JSON schema)
- Data extraction from text
- Form filling with type safety
- Integration with typed systems

### Installation

Outlines is included in mlx-serving:

```bash
npm install @defai.digital/mlx-serving
npm prepare:python

# Verify Outlines
.kr-mlx-venv/bin/python -c "import outlines; print(outlines.__version__)"
```

**Requirements**:
- `outlines >= 0.0.40`
- Python 3.11+
- Text-only models (non-vision)

### Quick Start: JSON Schema

```typescript
const engine = await createEngine();
await engine.load_model({ model: "llama-3.1-8b-instruct" });

const userSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    email: { type: "string", format: "email" }
  },
  required: ["name", "age", "email"]
};

const result = await engine.generate({
  model: "llama-3.1-8b-instruct",
  prompt: "Generate a user profile for John Doe, age 30.",
  guidance: {
    mode: "json_schema",
    schema: userSchema
  }
});

// Output guaranteed to match schema:
// {"name": "John Doe", "age": 30, "email": "john.doe@example.com"}
```

### Supported JSON Schema Features

mlx-serving supports JSON Schema Draft 7:

- **Primitive Types**: `string`, `number`, `integer`, `boolean`, `null`
- **Complex Types**: `object`, `array`
- **Constraints**: `required`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`
- **Formats**: `email`, `uri`, `date-time`, `uuid`, etc.
- **Nested Structures**: Objects within objects, arrays of objects

### Examples

#### Simple Product Schema

```typescript
const productSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    price: { type: "number", minimum: 0 },
    in_stock: { type: "boolean" }
  },
  required: ["name", "price"]
};

const result = await engine.generate({
  prompt: "Create a product: MacBook Pro",
  guidance: { mode: "json_schema", schema: productSchema }
});

// Output: {"name": "MacBook Pro", "price": 2399.99, "in_stock": true}
```

#### Nested Object Schema

```typescript
const orderSchema = {
  type: "object",
  properties: {
    order_id: { type: "string" },
    customer: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" }
      },
      required: ["name", "email"]
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product: { type: "string" },
          quantity: { type: "integer", minimum: 1 }
        }
      }
    }
  },
  required: ["order_id", "customer", "items"]
};

const result = await engine.generate({
  prompt: "Create an order for customer Alice with 2 MacBooks",
  guidance: { mode: "json_schema", schema: orderSchema }
});
```

#### Array Schema

```typescript
const todoListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      task: { type: "string" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      completed: { type: "boolean" }
    },
    required: ["task", "priority"]
  }
};

const result = await engine.generate({
  prompt: "Generate 3 todo tasks for today",
  guidance: { mode: "json_schema", schema: todoListSchema }
});
```

### XML Mode

Generate valid XML with DTD or schema constraints:

```typescript
const result = await engine.generate({
  prompt: "Generate an article about AI",
  guidance: {
    mode: "xml",
    schema: `
      <!DOCTYPE article [
        <!ELEMENT article (title, author, content)>
        <!ELEMENT title (#PCDATA)>
        <!ELEMENT author (#PCDATA)>
        <!ELEMENT content (#PCDATA)>
      ]>
    `
  }
});

// Output:
// <article>
//   <title>The Future of AI</title>
//   <author>John Doe</author>
//   <content>Artificial intelligence is transforming...</content>
// </article>
```

### Regex Mode

Constrain output to match a regular expression:

```typescript
const result = await engine.generate({
  prompt: "Generate a phone number",
  guidance: {
    mode: "regex",
    pattern: "\\+1-\\d{3}-\\d{3}-\\d{4}"  // US phone format
  }
});

// Output: +1-415-555-1234
```

### TypeScript Integration

Combine with Zod for end-to-end type safety:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Define schema with Zod
const UserSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
  email: z.string().email(),
  roles: z.array(z.enum(['admin', 'user', 'guest']))
});

type User = z.infer<typeof UserSchema>;

// Convert to JSON Schema for Outlines
const jsonSchema = zodToJsonSchema(UserSchema);

// Generate with type safety
const result = await engine.generate({
  prompt: "Create a user profile for Sarah",
  guidance: { mode: "json_schema", schema: jsonSchema }
});

// Parse and validate
const user: User = UserSchema.parse(JSON.parse(result));
console.log(user.name);  // Type-safe access
```

### Performance Considerations

**Overhead**: Structured output adds **10-20% latency** due to constraint checking.

**Tips**:
- Keep schemas small (< 10KB)
- Use simpler schemas for better performance
- Cache compiled schemas when possible
- Consider trading off schema complexity vs performance

**When NOT to use**:
- Free-form creative writing
- Performance-critical applications
- Very large schemas (> 10KB)

### Best Practices

1. **Start Simple**: Begin with basic schemas, add complexity as needed
2. **Validate Output**: Always parse and validate JSON (use Zod)
3. **Handle Failures**: Wrap in try-catch, model may fail to satisfy complex schemas
4. **Prompt Engineering**: Clear prompts improve schema compliance
5. **Schema Size**: Keep schemas under 10KB for best performance

### Troubleshooting

**Issue**: Generation fails or produces invalid output
- **Solution**: Simplify schema, check for unsupported features

**Issue**: Slow generation (> 2x baseline)
- **Solution**: Reduce schema complexity, consider disabling guidance for non-critical fields

**Issue**: Model ignores schema constraints
- **Solution**: Use stronger prompts, try different model (some models follow schemas better)

---

## Vision Models

### Overview

mlx-serving supports **multi-modal inference** with vision-language models (VLMs) that process both images and text.

**Supported Models**:
- LLaVA (7B, 13B, 34B)
- Qwen-VL (7B, 14B)
- Phi-3-Vision (mini, small, medium)

### Installation

Vision support is included:

```bash
npm install @defai.digital/mlx-serving
npm run setup

# Verify mlx-vlm
.kr-mlx-venv/bin/python -c "import mlx_vlm; print(mlx_vlm.__version__)"
```

### Quick Start

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

// Load vision model
await engine.loadVisionModel({
  model: "llava-hf/llava-1.5-7b-hf"
});

// Generate with image
for await (const chunk of engine.createVisionGenerator({
  prompt: "Describe this image in detail.",
  images: ["/path/to/image.jpg"],
  maxTokens: 200
})) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}

await engine.dispose();
```

### Multiple Images

```typescript
for await (const chunk of engine.createVisionGenerator({
  prompt: "Compare these two images. What are the differences?",
  images: [
    "/path/to/image1.jpg",
    "/path/to/image2.jpg"
  ],
  maxTokens: 300
})) {
  // Process chunks
}
```

### Image Formats

**Supported Formats**:
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)
- BMP (.bmp)

**Loading Methods**:
1. **File Path** (recommended): `"/path/to/image.jpg"`
2. **Base64 String**: `"data:image/jpeg;base64,/9j/4AAQ..."`
3. **URL**: `"https://example.com/image.jpg"`

### Model Recommendations

| Use Case | Model | Memory | Speed | Quality |
|----------|-------|--------|-------|---------|
| **General Purpose** | LLaVA 1.5 7B | 6 GB | Fast | Good |
| **High Quality** | LLaVA 1.6 13B | 10 GB | Medium | Excellent |
| **Chinese + English** | Qwen-VL 7B | 6 GB | Fast | Good |
| **Code + Diagrams** | Phi-3-Vision | 5 GB | Very Fast | Good |

### Best Practices

1. **Image Resolution**: Resize large images (< 2048px) for faster processing
2. **Batch Processing**: Process multiple images sequentially, not in parallel
3. **Context Length**: Vision inputs consume significant context (image ≈ 256 tokens)
4. **Prompt Engineering**: Be specific about what you want to extract from images

### Example Use Cases

**Image Captioning**:
```typescript
const caption = await engine.createVisionGenerator({
  prompt: "Generate a detailed caption for this image.",
  images: ["photo.jpg"]
});
```

**Visual Question Answering**:
```typescript
const answer = await engine.createVisionGenerator({
  prompt: "How many people are in this image?",
  images: ["crowd.jpg"]
});
```

**OCR (Text Extraction)**:
```typescript
const text = await engine.createVisionGenerator({
  prompt: "Extract all text from this document image.",
  images: ["document.jpg"]
});
```

**Image Comparison**:
```typescript
const analysis = await engine.createVisionGenerator({
  prompt: "Compare the before and after images. What changed?",
  images: ["before.jpg", "after.jpg"]
});
```

---

## Quick Reference

### Essential Commands

```bash
# Install
npm install @defai.digital/mlx-serving
npm run setup

# Test installation
echo '{"jsonrpc":"2.0","id":1,"method":"runtime/info"}' | \
  PYTHONPATH=./python .kr-mlx-venv/bin/python python/runtime.py

# Run tests
npm test

# Type check
npm typecheck

# Build
npm build
```

### Core API

```typescript
import { createEngine, withEngine } from '@defai.digital/mlx-serving';

// Basic flow
const engine = await createEngine();
await engine.loadModel({ model: "llama-8b" });

for await (const chunk of engine.createGenerator({ prompt: "Hi" })) {
  if (chunk.type === 'token') console.log(chunk.token);
}

await engine.dispose();

// Context manager style
const result = await withEngine(async (engine) => {
  await engine.loadModel({ model: "llama-8b" });
  return await generateText(engine, "Hello");  // Auto-dispose
});
```

### Common Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `model` | string | Model identifier | Required |
| `prompt` | string | Input text | Required |
| `maxTokens` / `max_tokens` | number | Max output tokens | 512 |
| `temperature` | number | Sampling temperature (0-2) | 0.7 |
| `topP` / `top_p` | number | Nucleus sampling (0-1) | 0.9 |
| `stream` / `streaming` | boolean | Enable streaming | true |
| `stopSequences` / `stop_sequences` | string[] | Stop strings | [] |
| `seed` | number | Random seed | null |

### Error Handling

```typescript
try {
  await engine.loadModel({ model: "invalid-model" });
} catch (error) {
  if (error instanceof EngineError) {
    console.error('Engine error:', error.code, error.message);
  }
}
```

### Debugging

```typescript
// Enable verbose logging
const engine = await createEngine({ verbose: true });

// Monitor Python stderr
engine.on('stderr', (data) => console.error('[Python]', data));

// Check runtime status
const info = engine.getInfo();
console.log('Status:', info.status, 'PID:', info.pid);
```

### Performance Tips

1. **Reuse Engine**: Create once, use multiple times
2. **Batch Requests**: Use micro-batching for concurrent requests (distributed architecture)
3. **Model Caching**: Keep frequently-used models loaded
4. **Stream by Default**: Streaming reduces perceived latency
5. **Monitor Memory**: Use paged KV cache for long contexts

### Additional Resources

- **[Quick Start Guide](./QUICK_START.md)** - 5-minute getting started
- **[Performance Guide](./PERFORMANCE.md)** - Week 7 optimizations (52K)
- **[Production Features](./PRODUCTION_FEATURES.md)** - Enterprise features (65K)
- **[Feature Flags](./FEATURE_FLAGS.md)** - Feature flag system (34K)
- **[Full Documentation](./INDEX.md)** - Documentation hub
- **[Architecture Guide](./ARCHITECTURE.md)** - System architecture
- **[Deployment Guide](./DEPLOYMENT.md)** - Operations guide

**Examples**:
- [Performance Examples](../examples/performance/) - Week 7 optimization examples
- [Production Examples](../examples/production/) - Enterprise feature examples
- [Migration Examples](../examples/migration/) - Migration from mlx-engine

**Links**:
- [GitHub Repository](https://github.com/defai-digital/mlx-serving)
- [npm Package](https://www.npmjs.com/package/@defai.digital/mlx-serving)
- [Issues](https://github.com/defai-digital/mlx-serving/issues)
- [Discussions](https://github.com/defai-digital/mlx-serving/discussions)

---

**Document Version**: 2.1
**Last Updated**: 2025-11-10
**Maintained By**: mlx-serving Team
