# MLX Model Downloader

Download and manage MLX-optimized models from Hugging Face [mlx-community](https://huggingface.co/mlx-community).

---

## Features

- ✅ **Download MLX models** from Hugging Face mlx-community (3,174+ models)
- ✅ **Progress tracking** with real-time download progress
- ✅ **Automatic caching** in `~/.cache/huggingface/hub`
- ✅ **Model search** and filtering
- ✅ **Cache management** - list, clear, inspect cached models
- ✅ **TypeScript & Python APIs** - use from code or CLI
- ✅ **Quantization detection** - automatically detects 4bit, 8bit, etc.

---

## Quick Start

### CLI Usage

```bash
# Download a model
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit

# List available models
mlx-download list --filter llama --limit 10

# Show cached models
mlx-download cache --list

# Clear specific model from cache
mlx-download cache --clear-model mlx-community/Llama-3.2-3B-Instruct-4bit
```

### TypeScript API

```typescript
import { MLXModelDownloader } from '@defai.digital/mlx-serving';

const downloader = new MLXModelDownloader();

// Download a model
const modelInfo = await downloader.download('mlx-community/Llama-3.2-3B-Instruct-4bit');
console.log('Model path:', modelInfo.path);

// List available models
const models = await downloader.list({ filter: 'llama', limit: 10 });
console.log(`Found ${models.length} models`);

// Get cached models
const cached = await downloader.getCachedModels();
console.log(`${cached.length} models in cache`);
```

### Python API

```python
from python.model_downloader import MLXModelDownloader

downloader = MLXModelDownloader()

# Download a model
model_info = downloader.download_model('mlx-community/Llama-3.2-3B-Instruct-4bit')
print(f"Model path: {model_info.path}")

# List available models
models = downloader.list_mlx_models(filter_str='llama', limit=10)
print(f"Found {len(models)} models")

# Get cached models
cached = downloader.get_cached_models()
print(f"{len(cached)} models in cache")
```

---

## Installation

### Requirements

- **Python**: 3.11+ with `huggingface-hub` installed
- **Node.js**: 22+ (for TypeScript/CLI usage)
- **Hugging Face Account**: Optional, for private models

### Install Dependencies

```bash
# Python dependencies
pip install huggingface-hub>=0.34.0

# Or use the project's Python environment
npm run prepare:python
```

---

## CLI Reference

### Download Command

Download a model from mlx-community:

```bash
mlx-download <repo-id> [options]
```

**Arguments:**
- `<repo-id>`: Repository ID (e.g., `mlx-community/Llama-3.2-3B-Instruct-4bit`)

**Options:**
- `--cache-dir <path>`: Cache directory (default: `~/.cache/huggingface/hub`)
- `--local-dir <path>`: Download to specific directory
- `--force`: Force re-download even if cached
- `--token <token>`: Hugging Face API token
- `--quiet`: Suppress output

**Examples:**

```bash
# Download Llama 3.2 3B (4-bit quantized)
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit

# Download to specific directory
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit --local-dir ./models

# Force re-download
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit --force
```

---

### List Command

List available MLX models:

```bash
mlx-download list [options]
```

**Options:**
- `--filter <text>`: Filter by model name (case-insensitive)
- `--limit <number>`: Max models to show (default: 50)
- `--sort <field>`: Sort by `downloads`, `likes`, or `created` (default: `downloads`)
- `--json`: Output as JSON
- `--token <token>`: Hugging Face API token

**Examples:**

```bash
# List top 10 Llama models
mlx-download list --filter llama --limit 10

# List by likes
mlx-download list --sort likes --limit 20

# Get JSON output
mlx-download list --filter qwen --json > models.json
```

---

### Cache Command

Manage cached models:

```bash
mlx-download cache [options]
```

**Options:**
- `--list`: List cached models (default)
- `--clear`: Clear all cached models
- `--clear-model <repo-id>`: Clear specific model
- `--cache-dir <path>`: Cache directory
- `--json`: Output as JSON

**Examples:**

```bash
# List cached models
mlx-download cache --list

# Clear specific model
mlx-download cache --clear-model mlx-community/Llama-3.2-3B-Instruct-4bit

# Clear all models
mlx-download cache --clear

# Get cache info as JSON
mlx-download cache --list --json
```

---

## TypeScript API Reference

### MLXModelDownloader Class

Main downloader class for TypeScript:

```typescript
import { MLXModelDownloader } from '@defai.digital/mlx-serving';

const downloader = new MLXModelDownloader(pythonPath?);
```

**Constructor:**
- `pythonPath` (optional): Path to Python executable (default: `python3` or `$PYTHON_PATH`)

---

### download()

Download a model from Hugging Face:

```typescript
async download(repoId: string, options?: DownloadOptions): Promise<ModelInfo>
```

**Parameters:**
- `repoId`: Repository ID (e.g., `"mlx-community/Llama-3.2-3B-Instruct-4bit"`)
- `options`: Download options

**DownloadOptions:**
```typescript
interface DownloadOptions {
  localDir?: string;           // Local directory to download to
  allowPatterns?: string[];    // File patterns to download (e.g., ["*.safetensors"])
  ignorePatterns?: string[];   // File patterns to ignore
  forceDownload?: boolean;     // Force re-download
  cacheDir?: string;           // Cache directory
  token?: string;              // Hugging Face API token
  onProgress?: (msg: string) => void;  // Progress callback
}
```

**Returns:** `ModelInfo`
```typescript
interface ModelInfo {
  repo_id: string;       // Repository ID
  path: string;          // Local path to model
  size_bytes: number;    // Total size in bytes
  files: string[];       // List of files
  quantization?: string; // Detected quantization (e.g., "4bit")
}
```

**Example:**

```typescript
const modelInfo = await downloader.download(
  'mlx-community/Llama-3.2-3B-Instruct-4bit',
  {
    onProgress: (msg) => console.log(msg),
    forceDownload: false
  }
);

console.log(`Downloaded to: ${modelInfo.path}`);
console.log(`Size: ${modelInfo.size_bytes} bytes`);
console.log(`Quantization: ${modelInfo.quantization}`);
```

---

### list()

List available MLX models:

```typescript
async list(options?: ListOptions): Promise<MLXModelEntry[]>
```

**ListOptions:**
```typescript
interface ListOptions {
  filter?: string;                          // Filter model names
  limit?: number;                           // Max models to return
  sort?: 'downloads' | 'likes' | 'created'; // Sort field
  token?: string;                           // API token
}
```

**Returns:** `MLXModelEntry[]`
```typescript
interface MLXModelEntry {
  repo_id: string;      // Repository ID
  downloads: number;    // Download count
  likes: number;        // Like count
  tags: string[];       // Model tags
  created_at?: string;  // Creation date
}
```

**Example:**

```typescript
const models = await downloader.list({
  filter: 'llama',
  limit: 10,
  sort: 'downloads'
});

models.forEach(m => {
  console.log(`${m.repo_id} - ${m.downloads.toLocaleString()} downloads`);
});
```

---

### getCachedModels()

Get list of cached models:

```typescript
async getCachedModels(cacheDir?: string): Promise<ModelInfo[]>
```

**Example:**

```typescript
const cached = await downloader.getCachedModels();

const totalSize = cached.reduce((sum, m) => sum + m.size_bytes, 0);
console.log(`Cache size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);

cached.forEach(m => {
  console.log(`${m.repo_id} - ${(m.size_bytes / 1024 / 1024).toFixed(2)} MB`);
});
```

---

### clearCache()

Clear cached models:

```typescript
async clearCache(repoId?: string, cacheDir?: string): Promise<void>
```

**Parameters:**
- `repoId` (optional): Specific model to clear (default: clear all)
- `cacheDir` (optional): Cache directory

**Examples:**

```typescript
// Clear specific model
await downloader.clearCache('mlx-community/Llama-3.2-3B-Instruct-4bit');

// Clear all models
await downloader.clearCache();
```

---

### Helper Functions

#### downloadModel()

Shortcut function to download a model:

```typescript
import { downloadModel } from '@defai.digital/mlx-serving';

const model = await downloadModel('mlx-community/Llama-3.2-3B-Instruct-4bit');
console.log('Downloaded to:', model.path);
```

#### listMLXModels()

Shortcut function to list models:

```typescript
import { listMLXModels } from '@defai.digital/mlx-serving';

const models = await listMLXModels({ filter: 'llama', limit: 10 });
models.forEach(m => console.log(m.repo_id));
```

---

## Python API Reference

### MLXModelDownloader Class

```python
from python.model_downloader import MLXModelDownloader

downloader = MLXModelDownloader(
    cache_dir=None,   # Optional cache directory
    token=None,       # Optional HF token
    verbose=True      # Print progress
)
```

### download_model()

Download a model:

```python
model_info = downloader.download_model(
    repo_id='mlx-community/Llama-3.2-3B-Instruct-4bit',
    local_dir=None,           # Optional local directory
    allow_patterns=None,       # Optional file patterns to include
    ignore_patterns=None,      # Optional file patterns to exclude
    force_download=False       # Force re-download
)

print(f"Path: {model_info.path}")
print(f"Size: {model_info.size_bytes} bytes")
print(f"Quantization: {model_info.quantization}")
```

### list_mlx_models()

List available models:

```python
models = downloader.list_mlx_models(
    filter_str='llama',   # Optional filter
    limit=50,              # Max models
    sort='downloads'       # Sort field
)

for model in models:
    print(f"{model['repo_id']} - {model['downloads']:,} downloads")
```

### get_cached_models()

List cached models:

```python
cached = downloader.get_cached_models()

for model in cached:
    print(f"{model.repo_id} - {model.size_bytes / 1024 / 1024:.2f} MB")
```

### clear_cache()

Clear cached models:

```python
# Clear specific model
downloader.clear_cache(repo_id='mlx-community/Llama-3.2-3B-Instruct-4bit')

# Clear all models
downloader.clear_cache()
```

---

## Environment Variables

### HF_TOKEN

Hugging Face API token for accessing private models:

```bash
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxx
mlx-download mlx-community/private-model
```

### PYTHON_PATH

Custom Python executable path:

```bash
export PYTHON_PATH=/usr/local/bin/python3.11
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit
```

---

## Popular MLX Models

### Llama Models

```bash
# Llama 3.2 3B (4-bit)
mlx-download mlx-community/Llama-3.2-3B-Instruct-4bit

# Llama 3.1 8B (4-bit)
mlx-download mlx-community/Meta-Llama-3.1-8B-Instruct-4bit

# Llama 3.1 70B (4-bit)
mlx-download mlx-community/Meta-Llama-3.1-70B-Instruct-4bit
```

### Qwen Models

```bash
# Qwen 2.5 7B (4-bit)
mlx-download mlx-community/Qwen2.5-7B-Instruct-4bit

# Qwen 2.5 14B (4-bit)
mlx-download mlx-community/Qwen2.5-14B-Instruct-4bit
```

### Mistral Models

```bash
# Mistral 7B (4-bit)
mlx-download mlx-community/Mistral-7B-Instruct-v0.3-4bit

# Mixtral 8x7B (4-bit)
mlx-download mlx-community/Mixtral-8x7B-Instruct-v0.1-4bit
```

---

## Cache Location

Models are cached in:

```
~/.cache/huggingface/hub/
└── models--mlx-community--Llama-3.2-3B-Instruct-4bit/
    └── snapshots/
        └── <hash>/
            ├── config.json
            ├── tokenizer.json
            ├── weights.safetensors
            └── ...
```

You can customize the cache directory with `--cache-dir` or `CACHE_DIR` environment variable.

---

## Troubleshooting

### Model Not Found

```bash
❌ Error: Model not found: mlx-community/NonExistentModel
```

**Solution:** Check the model exists on https://huggingface.co/mlx-community

### Permission Denied

```bash
❌ Error: Permission denied accessing private model
```

**Solution:** Set your Hugging Face token:
```bash
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxx
```

### Python Not Found

```bash
❌ Error: Failed to spawn Python process
```

**Solution:** Install Python 3.11+ or set `PYTHON_PATH`:
```bash
export PYTHON_PATH=/usr/local/bin/python3
```

### Missing huggingface-hub

```bash
❌ Error: huggingface_hub not installed
```

**Solution:**
```bash
pip install huggingface-hub>=0.34.0
```

---

## Advanced Usage

### Download Specific Files Only

Download only safetensors files:

```typescript
const model = await downloader.download('mlx-community/Llama-3.2-3B-Instruct-4bit', {
  allowPatterns: ['*.safetensors', '*.json'],
  ignorePatterns: ['*.bin', '*.pt']
});
```

### Custom Cache Directory

Use a custom cache location:

```typescript
const downloader = new MLXModelDownloader();
const model = await downloader.download('mlx-community/Llama-3.2-3B-Instruct-4bit', {
  cacheDir: '/mnt/models/cache'
});
```

### Progress Tracking

Track download progress:

```typescript
const model = await downloader.download('mlx-community/Llama-3.2-3B-Instruct-4bit', {
  onProgress: (message) => {
    console.log(`Progress: ${message}`);
  }
});
```

---

## Contributing

Found a bug or have a feature request? Please open an issue at:
https://github.com/defai-digital/mlx-serving/issues

---

## License

Elastic License 2.0 - See [LICENSE](../LICENSE) for details

---

## See Also

- [Hugging Face MLX Community](https://huggingface.co/mlx-community)
- [huggingface_hub Documentation](https://huggingface.co/docs/huggingface_hub)
- [MLX Framework](https://github.com/ml-explore/mlx)
- [mlx-lm](https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm)

---

<div align="center">

**MLX Model Downloader**

Part of mlx-serving v0.1.0-alpha.0

Download and manage 3,174+ MLX models from Hugging Face

</div>
