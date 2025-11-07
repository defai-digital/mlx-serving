# kr-serve-mlx User Guides

**Version**: 2.0
**Date**: 2025-10-28

---

## Table of Contents

1. [Migration Guide (mlx-engine → kr-serve-mlx)](#migration-guide)
2. [Structured Output with Outlines](#structured-output-with-outlines)
3. [Vision Models](#vision-models)
4. [Quick Reference](#quick-reference)

---

## Migration Guide

### For Python mlx-engine Users

**kr-serve-mlx provides 100% API compatibility** with mlx-engine while adding TypeScript type safety and async/await support.

### Installation

```bash
# Python mlx-engine (before)
pip install mlx-engine

# TypeScript kr-serve-mlx (after)
npm install @knowrag/kr-serve-mlx
npm prepare:python  # Sets up Python runtime
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

#### TypeScript (kr-serve-mlx) - Python-Compatible

```typescript
import { createEngine } from '@knowrag/kr-serve-mlx';

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

#### TypeScript (kr-serve-mlx) - Native Style

```typescript
import { createEngine } from '@knowrag/kr-serve-mlx';

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

| mlx-engine | kr-serve-mlx (snake_case) | kr-serve-mlx (camelCase) |
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

| mlx-engine | kr-serve-mlx (snake_case) | kr-serve-mlx (camelCase) |
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

**After (kr-serve-mlx)**:
```typescript
import { createEngine } from '@knowrag/kr-serve-mlx';

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

**After (kr-serve-mlx)**:
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
- kr-serve-mlx: All operations are `async` → Use `await`

**Generator Pattern**:
- mlx-engine: `for token in engine.generate()`
- kr-serve-mlx: `for await (const chunk of engine.create_generator())`
  - Check `chunk.type === 'token'` before using `chunk.token`

**Resource Management**:
- mlx-engine: Manual cleanup or context manager
- kr-serve-mlx: Call `await engine.dispose()` or use `withEngine()` helper

**Context Manager Equivalent**:
```typescript
import { withEngine } from '@knowrag/kr-serve-mlx';

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

Outlines is included in kr-serve-mlx:

```bash
npm install @knowrag/kr-serve-mlx
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

kr-serve-mlx supports JSON Schema Draft 7:

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

kr-serve-mlx supports **multi-modal inference** with vision-language models (VLMs) that process both images and text.

**Supported Models**:
- LLaVA (7B, 13B, 34B)
- Qwen-VL (7B, 14B)
- Phi-3-Vision (mini, small, medium)

### Installation

Vision support is included:

```bash
npm install @knowrag/kr-serve-mlx
npm prepare:python

# Verify mlx-vlm
.kr-mlx-venv/bin/python -c "import mlx_vlm; print(mlx_vlm.__version__)"
```

### Quick Start

```typescript
import { createEngine } from '@knowrag/kr-serve-mlx';

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
npm install @knowrag/kr-serve-mlx
npm prepare:python

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
import { createEngine, withEngine } from '@knowrag/kr-serve-mlx';

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

### Links

- [GitHub Repository](https://github.com/defai-digital/kr-serve-mlx)
- [npm Package](https://www.npmjs.com/package/@knowrag/kr-serve-mlx)
- [Full Documentation](./INDEX.md)
- [Architecture Guide](./ARCHITECTURE.md)
- [Deployment Guide](./DEPLOYMENT.md)

---

**Document Version**: 2.0
**Last Updated**: 2025-10-28
**Maintained By**: KnowRAG Studio - kr-serve-mlx Team
