# Quick Start Guide

**Get started with mlx-serving in 5 minutes**

---

## Prerequisites

- **macOS 26.0+** (Darwin 25.0.0+)
- **Apple Silicon M3 or newer** (M3 Pro/Max/Ultra recommended)
- **Node.js 22.0.0+**
- **Python 3.11-3.12**

---

## Installation

```bash
# Install package
npm install @defai.digital/mlx-serving

# Setup Python environment (one-time)
npm run setup
```

---

## Hello World (30 seconds)

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

// Create engine
const engine = await createEngine();

// Generate text
const generator = engine.generate({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  prompt: 'What is the capital of France?',
  maxTokens: 50,
});

// Stream response
for await (const chunk of generator) {
  process.stdout.write(chunk.text);
}

// Cleanup
await engine.close();
```

**Run it:**
```bash
npx tsx your-file.ts
```

---

## Enable Week 7 Optimizations (2 minutes)

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

**Result**: 2X throughput improvement with zero first-request latency!

---

## Common Use Cases

### Streaming Chat

```typescript
const generator = engine.generate({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  prompt: 'Tell me a story about a robot',
  maxTokens: 200,
  temperature: 0.7,
});

for await (const chunk of generator) {
  console.log(chunk.text);
}
```

### JSON Structured Output

```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

const schema = z.object({
  name: z.string(),
  age: z.number(),
  city: z.string(),
});

const generator = engine.generate({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  prompt: 'Generate a person profile',
  structuredOutput: {
    jsonSchema: zodToJsonSchema(schema),
  },
});

for await (const chunk of generator) {
  console.log(chunk.text); // Valid JSON matching schema
}
```

### Multiple Models

```typescript
// Load multiple models
await engine.loadModel({ model: 'mlx-community/Llama-3.2-3B-Instruct-4bit' });
await engine.loadModel({ model: 'mlx-community/Qwen2.5-7B-Instruct-4bit' });

// Use different models
const response1 = engine.generate({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  prompt: 'Fast response needed',
  maxTokens: 50,
});

const response2 = engine.generate({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  prompt: 'More complex task',
  maxTokens: 200,
});
```

---

## Performance Tips

### 1. Enable Model Preloading
```yaml
# config/runtime.yaml
model_preload:
  enabled: true
```
**Benefit**: Zero first-request latency (vs ~5s cold start)

### 2. Use Adaptive Batching
```yaml
# config/runtime.yaml
batch_queue:
  enabled: true
  adaptive_sizing: true
```
**Benefit**: 10-15% throughput improvement

### 3. Use Smaller Models for Development
```typescript
// Fast for testing (2-3GB RAM)
model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'

// Production (6-8GB RAM)
model: 'mlx-community/Qwen2.5-7B-Instruct-4bit'
```

---

## Troubleshooting

### "Model not found"

**Fix**: Model will auto-download from HuggingFace on first use:
```bash
# Check download progress
ls ~/.cache/huggingface/hub/
```

### "Python module not found"

**Fix**: Run setup again:
```bash
npm run setup
```

### "Metal GPU error"

**Fix**: Ensure you're on M3+ hardware:
```bash
sysctl machdep.cpu.brand_string
# Should show: Apple M3 (or newer)
```

### Slow first request

**Fix**: Enable model preloading (see configuration above)

---

## Next Steps

- **[Performance Guide](./PERFORMANCE.md)** - Enable Week 7 optimizations (2X throughput)
- **[Production Features](./PRODUCTION_FEATURES.md)** - Enterprise features (QoS, canary deployment)
- **[Complete Documentation](./INDEX.md)** - Full documentation hub
- **[Examples](../examples/)** - More code examples

---

## Need Help?

- **Issues**: [GitHub Issues](https://github.com/defai-digital/mlx-serving/issues)
- **Discussions**: [GitHub Discussions](https://github.com/defai-digital/mlx-serving/discussions)
- **Documentation**: [docs/INDEX.md](./INDEX.md)

---

**Last Updated**: 2025-11-10
**Version**: 0.8.0
