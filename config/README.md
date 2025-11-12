# Kr-MLX-LM Configuration

所有配置參數都集中在 YAML 檔案中，完全消除硬編碼。

## 配置檔案結構

```
config/
  ├── runtime.yaml       # 主配置檔案
  ├── production.yaml    # 生產環境覆蓋（可選）
  ├── development.yaml   # 開發環境覆蓋（可選）
  └── test.yaml          # 測試環境覆蓋（可選）
```

## 使用方式

### TypeScript

```typescript
import { getConfig, initializeConfig } from './src/config/loader';

// 方式 1: 使用預設配置（自動載入 config/runtime.yaml）
const config = getConfig();
console.log(config.python_runtime.startup_timeout_ms);

// 方式 2: 明確指定環境
initializeConfig(undefined, 'production');
const config = getConfig();

// 方式 3: 指定自訂配置檔案
initializeConfig('/path/to/custom-config.yaml', 'production');
```

### Python

```python
from python.config_loader import get_config, initialize_config

# 方式 1: 使用預設配置
config = get_config()
print(config.max_buffer_size)

# 方式 2: 明確指定環境
initialize_config(environment='production')
config = get_config()

# 方式 3: 指定自訂配置檔案
initialize_config(config_path='/path/to/custom-config.yaml')
```

## 環境變數

配置系統會自動偵測環境：

- TypeScript: 讀取 `NODE_ENV` (production/development/test)
- Python: 讀取 `PYTHON_ENV` 或 `NODE_ENV`

```bash
# 設置環境
export NODE_ENV=production
export PYTHON_ENV=production

# 運行應用程式（會自動使用 production 配置）
npm start
```

## 配置覆蓋優先順序

1. **Base config** (`runtime.yaml` 基礎配置)
2. **Environment overrides** (`runtime.yaml` 中的 `environments` 區塊)
3. **Custom config file** (如果明確指定)

## 配置參數說明

### `python_runtime`
- **startup_timeout_ms**: Python 進程啟動超時（預設: 30000ms）
- **shutdown_timeout_ms**: 優雅關閉超時（預設: 5000ms）
- **max_restarts**: 最大重啟次數（預設: 3）
- **init_probe_delay_ms**: 初始化探測延遲（預設: 500ms）
- **restart_delay_base_ms**: 重啟延遲基數（預設: 1000ms）

### `python_bridge`
- **max_buffer_size**: stdin buffer 上限（預設: 1MB）
- **stream_queue_size**: 串流 queue 大小（預設: 100）
- **queue_put_max_retries**: Queue backpressure 最大重試（預設: 100）
- **queue_put_backoff_ms**: Backpressure 延遲（預設: 10ms）

### `model`
- **default_context_length**: 預設 context length（預設: 8192）
- **default_quantization**: 預設量化模式（預設: 'none'）

### `performance`
- **enable_batching**: 啟用 IPC batching（未來功能）
- **use_messagepack**: 使用 MessagePack 而非 JSON（未來功能）
- **aggressive_gc**: 強制垃圾回收（預設: false）

### `development`
- **verbose**: 詳細日誌（預設: false）
- **debug**: Debug 模式（預設: false）
- **log_ipc**: 記錄所有 IPC 訊息（預設: false）

## 驗證

配置系統會自動驗證關鍵參數：

- 超時必須 >= 1000ms
- Buffer 大小必須 >= 1024 bytes
- Stream 數量必須 >= 1

如果驗證失敗，會拋出詳細錯誤訊息。

## 範例：自訂生產配置

創建 `config/production.yaml`:

```yaml
# 覆蓋特定參數
python_runtime:
  startup_timeout_ms: 60000  # 大模型需要更長時間
  max_restarts: 5

stream_registry:
  max_active_streams: 50  # 生產環境支援更多並發

development:
  verbose: false
  debug: false
```

然後：

```typescript
// 會自動 deep merge runtime.yaml + production.yaml
initializeConfig(undefined, 'production');
```

## 測試配置

測試環境使用更短的超時以加快測試速度：

```yaml
# config/runtime.yaml 中的 environments.test
test:
  python_runtime:
    startup_timeout_ms: 5000  # 5秒快速測試
    max_restarts: 1
  json_rpc:
    default_timeout_ms: 5000
```

## 遷移指南

### 從 `defaults.ts` 遷移

**之前**:
```typescript
import { PYTHON_RUNTIME } from './config/defaults';
const timeout = PYTHON_RUNTIME.STARTUP_TIMEOUT_MS;
```

**之後**:
```typescript
import { getConfig } from './config/loader';
const timeout = getConfig().python_runtime.startup_timeout_ms;

// 或使用相容性函數
import { getCompatibleConfig } from './config/loader';
const { PYTHON_RUNTIME } = getCompatibleConfig();
const timeout = PYTHON_RUNTIME.STARTUP_TIMEOUT_MS;
```

### 從 `config.py` 遷移

**之前**:
```python
from python.config import MAX_BUFFER_SIZE
```

**之後**:
```python
from python.config_loader import get_config
config = get_config()
buffer_size = config.max_buffer_size

# 或直接使用常量（向後相容）
from python.config_loader import MAX_BUFFER_SIZE
```

## 優勢

✅ **集中管理**: 所有配置在一個 YAML 檔案
✅ **環境區分**: 支援 production/development/test
✅ **類型安全**: TypeScript interface + Python dataclass
✅ **驗證**: 自動驗證參數合法性
✅ **可測試**: 易於注入測試配置
✅ **版本控制**: YAML 檔案易於 diff 和 review
✅ **文檔化**: YAML 支援註釋，自帶文檔
✅ **向後相容**: 提供相容性函數，無需大規模重構
