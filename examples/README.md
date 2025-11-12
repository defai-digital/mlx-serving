# Examples

This directory contains examples for using mlx-serving in various scenarios.

## Running Examples from Repository

If you're running examples from the cloned repository (not as an installed package), you need to build the project first:

```bash
# 1. Install dependencies
npm install

# 2. Build the project
npm run build

# 3. Setup Python environment
npm run setup

# 4. Run any example
npx tsx examples/basic/01-hello-world.ts
npx tsx examples/performance/01-model-preloading.ts
npx tsx examples/production/01-qos-monitoring.ts
```

## Running Examples from Installed Package

If you've installed mlx-serving via npm, examples work directly:

```bash
# Install the package
npm install @defai.digital/mlx-serving

# Run examples
npx tsx examples/basic/01-hello-world.ts
```

## Example Categories

### Basic Examples
- **[01-hello-world.ts](./basic/01-hello-world.ts)** - Simplest usage example
- **[02-with-engine-context.ts](./basic/02-with-engine-context.ts)** - Context manager pattern

### Performance Examples
- **[01-model-preloading.ts](./performance/01-model-preloading.ts)** - Zero first-request latency
- **[02-object-pooling.ts](./performance/02-object-pooling.ts)** - Reduce GC pressure
- **[03-adaptive-batching.ts](./performance/03-adaptive-batching.ts)** - Dynamic batching

See [Performance README](./performance/README.md) for detailed performance optimization guides.

### Production Examples
- **[01-qos-monitoring.ts](./production/01-qos-monitoring.ts)** - Quality of Service monitoring
- **[02-canary-deployment.ts](./production/02-canary-deployment.ts)** - Gradual rollout
- **[03-feature-flags.ts](./production/03-feature-flags.ts)** - Feature flag control

See [Production README](./production/README.md) for enterprise features.

### Vision Examples
- **[01-basic-vision-qa.ts](./vision/01-basic-vision-qa.ts)** - Vision-language models
- **[02-image-formats.ts](./vision/02-image-formats.ts)** - Multiple image formats

### Structured Output Examples
- **[json_schema_example.py](./structured/json_schema_example.py)** - JSON schema validation
- **[xml_mode_example.py](./structured/xml_mode_example.py)** - XML structured output

See [Structured README](./structured/README.md) for structured generation guides.

### Migration Examples
- **[from-mlx-engine.md](./migration/from-mlx-engine.md)** - Migration guide from mlx-engine
- **[01-before-mlx-engine.py](./migration/01-before-mlx-engine.py)** - Before migration
- **[02-after-kr-mlx-lm-typescript.ts](./migration/02-after-kr-mlx-lm-typescript.ts)** - After migration

## Troubleshooting

### Error: Cannot find module 'dist/index.js'

**Solution**: Build the project first

```bash
npm run build
```

### Error: Python environment not found

**Solution**: Setup Python environment

```bash
npm run setup
```

### Error: Model not found

**Solution**: Models are downloaded automatically on first use. Ensure you have:
- Internet connection
- Sufficient disk space (models are 2-50GB)

## Additional Resources

- **[Documentation](../docs/INDEX.md)** - Complete documentation
- **[Quick Start](../docs/QUICK_START.md)** - 5-minute getting started
- **[API Reference](../docs/GUIDES.md)** - API guides and usage

---

**Need help?** See [Troubleshooting Guide](../docs/TROUBLESHOOTING.md) or open an [issue](https://github.com/defai-digital/mlx-serving/issues).
