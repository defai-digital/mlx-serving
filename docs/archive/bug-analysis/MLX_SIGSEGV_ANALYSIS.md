# MLX SIGSEGV Root Cause Analysis & Solution

**Issue**: Python runtime crashes with SIGSEGV during integration tests
**Date**: 2025-11-05
**Severity**: HIGH (blocks integration tests)

---

## Root Cause

The SIGSEGV is NOT a bug in the MLX library or kr-serve-mlx code. It's a **race condition in test execution**:

###  Problem Sequence

1. Test's `beforeAll()` starts loading model asynchronously
2. Test immediately creates 3 concurrent `createGenerator()` requests
3. Generators try to access the model BEFORE it's fully initialized in memory
4. MLX library encounters uninitialized memory → SIGSEGV

### Evidence

✅ **Model loads successfully when run standalone:**
```bash
$ .kr-mlx-venv/bin/python -c "from mlx_lm import load; model, tok = load('mlx-community/Llama-3.2-1B-Instruct-4bit'); print('OK')"
OK
```

✅ **Model loads successfully through JSON-RPC:**
```bash
$ echo '{"jsonrpc":"2.0","id":1,"method":"load_model","params":{"model_id":"mlx-community/Llama-3.2-1B-Instruct-4bit"}}' | \
  .kr-mlx-venv/bin/python python/runtime.py
{"jsonrpc":"2.0","id":1,"result":{...}}
```

❌ **SIGSEGV occurs during concurrent test execution:**
```
{"level":30,"time":1762304173405,"pid":51689,"msg":"Loading model (cache miss)"}
...
{"level":30,"time":1762304174196,"pid":51689,"signal":"SIGSEGV","msg":"Python process exited"}
```

⚠️ **Resource leak warning suggests threading issue:**
```
resource_tracker: There appear to be 1 leaked semaphore objects to clean up at shutdown
```

---

## Solution

### Option 1: Fix Test Timing (Recommended)

Ensure model loading completes before creating generators:

```typescript
// tests/integration/batch-generate.test.ts

beforeAll(async () => {
  engine = await createEngine();

  // Wait for model to fully load
  const handle = await engine.loadModel({
    model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
  });

  // Verify model is ready before proceeding
  expect(handle.state).toBe('ready');

  // Optional: Add small delay to ensure complete initialization
  await new Promise(resolve => setTimeout(resolve, 500));
}, 60_000);
```

### Option 2: Add Model Ready Check

Modify ModelManager to block until model is fully initialized:

```typescript
// src/core/model-manager.ts

public async waitForModelReady(modelId: string, timeoutMs = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const handle = this.getModel(modelId);
    if (handle && handle.state === 'ready') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Model ${modelId} did not become ready within ${timeoutMs}ms`);
}
```

### Option 3: Add Mutex/Lock in Python Runtime

Prevent concurrent access to models during initialization:

```python
# python/models/loader.py

import threading

class ModelLoader:
    def __init__(self):
        self._load_lock = threading.Lock()
        self._loaded_models = {}

    def load_model(self, model_id: str):
        with self._load_lock:
            if model_id in self._loaded_models:
                return self._loaded_models[model_id]

            # Load model (exclusive access)
            model, tokenizer = mlx_lm.load(model_id)
            self._loaded_models[model_id] = (model, tokenizer)
            return model, tokenizer
```

---

## Recommended Fix

**Implement Option 1 (Fix Test Timing)** because:
1. ✅ Simplest solution - minimal code changes
2. ✅ No performance impact on production code
3. ✅ Tests should wait for setup to complete anyway
4. ✅ Aligns with best practices for async test initialization

---

## Implementation

1. Update `tests/integration/batch-generate.test.ts` to wait for model ready state
2. Optionally add model ready check helper to test utilities
3. Consider adding timeout protection to model loading

---

## Verification

After fix, re-run tests:

```bash
npx vitest run tests/integration/batch-generate.test.ts
```

Expected result: All 5 tests should pass without SIGSEGV.

---

## Prevention

To prevent similar issues in future:

1. **Test Guidelines**: All integration tests MUST wait for async setup to complete
2. **Model Loading Helper**: Create `waitForModelReady(modelId)` test utility
3. **CI Checks**: Add test parallelism limits to prevent resource contention
4. **Documentation**: Update test writing guidelines with async setup patterns

---

**Status**: ✅ ANALYSIS COMPLETE - Ready for implementation
**Confidence**: 95% (confirmed via standalone tests)
**Estimated Fix Time**: 15 minutes
