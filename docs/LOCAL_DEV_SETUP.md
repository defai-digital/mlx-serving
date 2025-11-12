# Local Development Setup

This guide keeps the integration environment reproducible and prevents the infrastructure regressions that block our test suite.

## 1. Prerequisites

- **Node.js 22+** (matches `package.json` engines)
- **Python 3.11 or 3.12** – required for the MLX runtime
- **Apple Silicon (arm64)** – MLX only supports macOS on Apple Silicon
- **NATS server binary** – install with `brew install nats-server` and verify via `nats-server --version`
- **Redis server (optional)** – only needed for the distributed cache tests; you can use `brew install redis` or `docker run -p 6379:6379 redis`

## 2. Install JavaScript dependencies

```bash
npm install
```

The published package runs a `postinstall` hook, but the repository skips it for speed. The remaining steps cover the missing pieces.

## 3. Provision the Python runtime

```bash
npm run setup
```

This command runs `scripts/prepare-env.ts` and will:

1. Locate Python 3.12/3.11
2. Create `.mlx-serving-venv`
3. Upgrade `pip` inside the venv
4. Install the MLX requirements from `python/requirements.txt`
5. Verify that `mlx`, `mlx_lm`, and `mlx_vlm` import cleanly

If you need to redo the environment, delete `.mlx-serving-venv/` and rerun `npm run setup`.

## 4. Verify tooling

```bash
# NATS availability (required for distributed tests)
nats-server --version

# Python runtime path used by the bridge
.mlx-serving-venv/bin/python --version
```

Integration tests automatically start an embedded NATS instance on random ports, so simply having the `nats-server` binary on your `$PATH` is enough.

## 5. (Optional) Redis for distributed cache tests

The code now depends on the official `redis` npm client. To exercise the Redis-backed cache end-to-end:

```bash
# Start a local Redis
brew services start redis
# or
docker run --rm -p 6379:6379 redis

# Point the tests at the instance if needed
export REDIS_URL=redis://localhost:6379
npm run test -- tests/integration/distributed-cache.test.ts
```

Without a running Redis instance the cache falls back to its local in-memory mode, so other tests continue to pass.

## 6. Running integration tests

```bash
# Run the entire suite
npm test

# Or target a subset while iterating on infrastructure changes
npm run test -- tests/integration/distributed/controller/controller-worker.test.ts
```

> Automate everything, monitor everything, break nothing. Keeping these steps scripted (`npm run setup`) and documented here prevents the 77-test failure cascade we just fixed.
