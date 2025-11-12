# Migration Example: From mlx-engine to kr-serve-mlx

## Original Python Code (mlx-engine)

```python
# original_code.py
from mlx_engine import Engine

def main():
    # Initialize engine
    engine = Engine()

    # Load model
    engine.load_model("meta-llama/Llama-3.1-8B-Instruct")

    # Generate text
    prompt = "Explain machine learning in one sentence:"
    for token in engine.generate(
        prompt=prompt,
        max_tokens=30,
        temperature=0.7
    ):
        print(token, end="", flush=True)

    print()  # New line

if __name__ == "__main__":
    main()
```

## Migrated TypeScript Code (kr-serve-mlx)

### Option 1: Using snake_case (Python-compatible)

```typescript
// migrated_snake_case.ts
import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  // Initialize engine (async!)
  const engine = await createEngine();

  // Load model (async!)
  await engine.load_model({
    model: "meta-llama/Llama-3.1-8B-Instruct"
  });

  // Generate text (async generator!)
  const prompt = "Explain machine learning in one sentence:";
  for await (const chunk of engine.create_generator({
    prompt: prompt,
    max_tokens: 30,
    temperature: 0.7
  })) {
    if (chunk.type === 'token') {
      process.stdout.write(chunk.token);
    }
  }

  console.log(); // New line

  // Clean up (important!)
  await engine.dispose();
}

main().catch(console.error);
```

### Option 2: Using camelCase (TypeScript-native)

```typescript
// migrated_camel_case.ts
import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  const engine = await createEngine();

  await engine.loadModel({
    model: "meta-llama/Llama-3.1-8B-Instruct"
  });

  const prompt = "Explain machine learning in one sentence:";
  for await (const chunk of engine.createGenerator({
    prompt,
    maxTokens: 30,
    temperature: 0.7
  })) {
    if (chunk.type === 'token') {
      process.stdout.write(chunk.token);
    }
  }

  console.log();
  await engine.dispose();
}

main().catch(console.error);
```

## Key Changes

1. **Add `await`** - All operations are async
2. **Use `for await`** - Generator syntax change
3. **Check `chunk.type`** - TypeScript uses discriminated unions
4. **Call `dispose()`** - Explicit cleanup required

## Side-by-Side Comparison

| Python (mlx-engine) | TypeScript (kr-serve-mlx) | Notes |
|---------------------|------------------------|-------|
| `from mlx_engine import Engine` | `import { createEngine } from '@defai.digital/mlx-serving'` | Module import |
| `engine = Engine()` | `const engine = await createEngine()` | Async constructor |
| `engine.load_model("model")` | `await engine.loadModel({ model: "model" })` | Async + object param |
| `for token in engine.generate(...)` | `for await (const chunk of engine.createGenerator(...))` | Async generator |
| `print(token, end="")` | `process.stdout.write(chunk.token)` | Token output |
| (auto cleanup) | `await engine.dispose()` | Explicit cleanup |
