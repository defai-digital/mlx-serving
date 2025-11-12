# Installation Improvement Proposal

## Problem Analysis

**User Feedback**: Python developers find installation difficult because:
1. Python environment setup fails during npm install
2. They prefer `pip install` workflow they're familiar with
3. Automatic venv creation conflicts with their existing Python environments
4. No direct Python package available

---

## Proposed Solution: Multi-Package Approach

Provide **two separate packages** for different user types:

### 1. Python Package (pip) - For Python Developers

```bash
pip install mlx-serving
```

**Benefits**:
- ✅ Familiar pip workflow for Python developers
- ✅ Use existing Python environment (no forced venv)
- ✅ Direct Python imports: `from mlx_serving import MLXEngine`
- ✅ No Node.js required for Python-only usage
- ✅ Published to PyPI.org

**Package Structure**:
```
mlx-serving/  (Python package on PyPI)
├── setup.py
├── pyproject.toml
├── mlx_serving/
│   ├── __init__.py
│   ├── runtime.py
│   ├── models/
│   └── adapters/
└── requirements.txt
```

**Usage**:
```python
from mlx_serving import MLXEngine

engine = MLXEngine()
engine.load_model("mlx-community/Llama-3.2-3B-Instruct-4bit")

for token in engine.generate("Hello, world!", max_tokens=50):
    print(token, end="", flush=True)
```

---

### 2. npm Package (TypeScript) - For Node.js/TypeScript Developers

```bash
npm install @defai.digital/mlx-serving
```

**Benefits**:
- ✅ TypeScript-first API with full type safety
- ✅ Automatic Python environment setup (optional)
- ✅ Production features (QoS, canary, A/B testing)
- ✅ Better for building web services and APIs

**Improved Installation**:

**Option A: Automatic (default)**
```bash
npm install @defai.digital/mlx-serving
# Automatically sets up Python venv
```

**Option B: Use existing Python environment**
```bash
# Skip automatic venv creation
npm install @defai.digital/mlx-serving --ignore-scripts

# Use your own Python environment
export MLX_SERVING_PYTHON_PATH=/path/to/your/python

# Install Python dependencies manually
pip install mlx-lm mlx-vlm outlines
```

**Option C: Use Python package**
```bash
# Install Python package first
pip install mlx-serving

# Then install npm package (skips Python setup)
npm install @defai.digital/mlx-serving
# Detects existing mlx-serving installation
```

---

## Implementation Plan

### Phase 1: Create Python Package (Week 1)

**Tasks**:
1. Create `setup.py` and `pyproject.toml`
2. Restructure Python code for standalone usage
3. Add Python-native API (no TypeScript bridge needed)
4. Publish to PyPI as `mlx-serving`
5. Update README with pip installation instructions

**Files to Create**:
- `setup.py` - Package metadata
- `pyproject.toml` - Modern Python packaging
- `mlx_serving/__init__.py` - Main Python API
- `mlx_serving/cli.py` - Command-line interface

**Example setup.py**:
```python
from setuptools import setup, find_packages

setup(
    name="mlx-serving",
    version="1.0.0",
    packages=find_packages(),
    install_requires=[
        "mlx>=0.4.0",
        "mlx-lm>=0.0.8",
        "mlx-vlm>=0.0.3",
        "outlines>=0.0.34",
    ],
    python_requires=">=3.11,<3.13",
    entry_points={
        "console_scripts": [
            "mlx-serve=mlx_serving.cli:main",
        ],
    },
)
```

---

### Phase 2: Improve npm Installation (Week 1)

**Tasks**:
1. Detect if Python package already installed
2. Add `--ignore-scripts` support
3. Better error messages with solutions
4. Add environment variable configuration

**Improved postinstall.cjs**:
```javascript
// Check if mlx-serving Python package is already installed
function checkPythonPackage() {
  const result = spawnSync('python3', ['-c',
    'import mlx_serving; print(mlx_serving.__version__)'],
    { stdio: 'pipe', encoding: 'utf8' }
  );

  if (result.status === 0) {
    console.log('✓ Found mlx-serving Python package:', result.stdout.trim());
    console.log('  Skipping venv creation.\n');
    return true;
  }
  return false;
}

// Check for custom Python path
function getCustomPythonPath() {
  return process.env.MLX_SERVING_PYTHON_PATH || null;
}
```

**Better Error Messages**:
```javascript
if (!pythonCmd) {
  console.error('❌ Python 3.11+ not found.');
  console.error('\n📚 Installation Options:\n');
  console.error('Option 1: Install Python (recommended for Node.js developers)');
  console.error('  macOS:  brew install python@3.12');
  console.error('  Web:    https://www.python.org/downloads/\n');
  console.error('Option 2: Use pip package (recommended for Python developers)');
  console.error('  pip install mlx-serving');
  console.error('  npm install @defai.digital/mlx-serving --ignore-scripts\n');
  return false;
}
```

---

### Phase 3: Documentation Update (Week 1)

**Update README.md**:

```markdown
## Installation

### For Python Developers

```bash
pip install mlx-serving
```

### For TypeScript/Node.js Developers

```bash
npm install @defai.digital/mlx-serving
```

### Advanced Installation

**Use existing Python environment:**
```bash
npm install @defai.digital/mlx-serving --ignore-scripts
export MLX_SERVING_PYTHON_PATH=/path/to/python
pip install mlx-lm mlx-vlm outlines
```

**Homebrew (macOS):**
```bash
# Coming soon
brew install mlx-serving
```
```

---

## Benefits of This Approach

### For Python Developers
- ✅ No forced npm/Node.js installation
- ✅ Familiar pip workflow
- ✅ Use existing Python environments
- ✅ Direct Python imports
- ✅ Lightweight (no TypeScript overhead)

### For TypeScript Developers
- ✅ Keep current npm workflow
- ✅ Automatic setup still works
- ✅ Full TypeScript type safety
- ✅ Production features (QoS, canary, etc.)

### For Both
- ✅ Can use both packages together
- ✅ Clear separation of concerns
- ✅ Better error messages
- ✅ More flexible installation options

---

## Migration Path

### Existing npm Users
No changes needed! Current installation continues to work:
```bash
npm install @defai.digital/mlx-serving
```

### New Python Users
Can now use pip:
```bash
pip install mlx-serving
```

### Mixed Users
Can use both:
```bash
pip install mlx-serving  # Python package
npm install @defai.digital/mlx-serving --ignore-scripts  # TypeScript package
```

---

## Alternative: Homebrew Formula (Bonus)

For macOS users, we could also provide:

```bash
brew tap defai-digital/mlx-serving
brew install mlx-serving
```

**Benefits**:
- One-command installation
- Handles Python dependencies automatically
- macOS-native experience
- Updates via `brew upgrade`

**Homebrew Formula Example**:
```ruby
class MlxServing < Formula
  desc "Production-grade LLM serving engine for Apple Silicon"
  homepage "https://github.com/defai-digital/mlx-serving"
  url "https://github.com/defai-digital/mlx-serving/archive/v1.0.0.tar.gz"

  depends_on "python@3.12"
  depends_on "node"

  def install
    # Install Python package
    venv = virtualenv_create(libexec, "python3.12")
    venv.pip_install resources

    # Install npm package
    system "npm", "install", "-g", "--production"

    bin.install_symlink libexec/"bin/mlx-serve"
  end
end
```

---

## Recommended Action

**Priority 1 (This Week)**:
1. ✅ Create Python pip package
2. ✅ Publish to PyPI as `mlx-serving`
3. ✅ Update npm postinstall to detect Python package
4. ✅ Update README with both installation methods

**Priority 2 (Next Week)**:
1. Create Homebrew formula
2. Add Docker image (for non-macOS CI/CD)
3. Create installation troubleshooting guide

**Priority 3 (Future)**:
1. Standalone binary (optional)
2. Windows support (WSL)

---

## Questions to Consider

1. **Package naming**: Should Python package be `mlx-serving` or `mlx_serving`?
   - Recommendation: `mlx-serving` (matches npm, Python allows hyphens)

2. **Version sync**: Should Python and npm versions match?
   - Recommendation: Yes, use same version number

3. **Feature parity**: Should Python package have all TypeScript features?
   - Recommendation: Core features yes, production features (canary, A/B) optional

4. **Maintenance**: Who maintains Python package?
   - Recommendation: Same team, automated releases

---

## Success Metrics

- [ ] 50% reduction in installation-related issues
- [ ] Both Python and npm downloads tracked
- [ ] Installation success rate > 95%
- [ ] Time to first successful inference < 5 minutes

---

---

## Additional Issue: User Onboarding

**New User Error Reported**:
```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

This happens when users try to run example code with `npx tsx` because they don't have proper project setup.

### Solution: Quick Start Templates

Provide ready-to-use starter templates:

**1. Create Starter Templates**:
```bash
npx create-mlx-app my-app
# or
npm init mlx-app my-app
```

**2. Add package.json template** to README:
```json
{
  "name": "my-mlx-app",
  "type": "module",  // ← Important! Enables ESM
  "scripts": {
    "start": "tsx index.ts"
  },
  "dependencies": {
    "@defai.digital/mlx-serving": "^1.0.0"
  }
}
```

**3. Provide working examples**:
```typescript
// index.ts - Working example with proper async handling
import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  const engine = await createEngine();

  await engine.loadModel({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
  });

  for await (const chunk of engine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'Hello!',
    maxTokens: 50
  })) {
    process.stdout.write(chunk.text);
  }

  await engine.dispose();
}

main().catch(console.error);
```

---

**What do you think? Should we proceed with:**
1. ✅ **Python pip package** (solves Python developer friction)
2. ✅ **Better error messages** in npm postinstall
3. ✅ **Quick start templates** (solves onboarding issues)
4. ⏳ **Homebrew formula** (optional, future enhancement)
