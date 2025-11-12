# Quick Start Guide - Outlines Integration Tests

快速開始使用 Outlines 整合測試套件。

---

## 30 秒快速開始

```bash
# 1. 進入專案目錄
cd /Users/akiralam/Desktop/defai/kr-mlx-lm

# 2. 安裝測試依賴
pip install pytest pytest-cov

# 3. 執行測試
pytest tests/integration/outlines/ -v
```

就這麼簡單！ 🎉

---

## 5 分鐘完整設定

### Step 1: 檢查環境

```bash
# 確認 Python 版本 (需要 3.9+)
python3 --version

# 確認專案目錄
cd /Users/akiralam/Desktop/defai/kr-mlx-lm
pwd
```

### Step 2: 安裝依賴

```bash
# 基本測試依賴 (必須)
pip install pytest pytest-cov pytest-mock

# 可選：安裝 Outlines (建議)
pip install outlines>=0.0.40

# 或使用專案的 requirements.txt
pip install -r python/requirements.txt
```

### Step 3: 驗證安裝

```bash
# 驗證測試套件
./tests/integration/outlines/../../../automatosx/tmp/verify-tests.sh

# 或手動驗證
pytest tests/integration/outlines/ --collect-only
```

### Step 4: 執行測試

```bash
# 執行所有測試
pytest tests/integration/outlines/ -v

# 查看覆蓋率報告
pytest tests/integration/outlines/ \
  --cov=python/adapters/outlines_adapter \
  --cov-report=term-missing
```

### Step 5: 查看結果

測試通過後，你應該看到：

```
==================== test session starts ====================
collected 46 items

test_json_schema.py::test_prepare_guidance_simple_schema PASSED     [ 2%]
test_json_schema.py::test_prepare_guidance_complex_schema PASSED    [ 4%]
...
test_error_handling.py::test_none_schema PASSED                     [100%]

==================== 46 passed in 2.34s ====================
```

---

## 常見使用場景

### 場景 1: 快速執行所有測試

```bash
cd /Users/akiralam/Desktop/defai/kr-mlx-lm
pytest tests/integration/outlines/ -v
```

**預期時間**: < 5 秒
**適用於**: 快速驗證、CI/CD

---

### 場景 2: 執行帶覆蓋率的測試

```bash
pytest tests/integration/outlines/ \
  --cov=python/adapters/outlines_adapter \
  --cov-report=html

# 在瀏覽器中查看報告
open htmlcov/index.html
```

**預期時間**: < 10 秒
**適用於**: 程式碼審查、品質檢查

---

### 場景 3: 只測試 JSON Schema 功能

```bash
pytest tests/integration/outlines/test_json_schema.py -v
```

**預期時間**: < 2 秒
**適用於**: JSON Schema 開發

---

### 場景 4: 只測試 XML 功能

```bash
pytest tests/integration/outlines/test_xml_mode.py -v
```

**預期時間**: < 2 秒
**適用於**: XML 模式開發

---

### 場景 5: 測試特定功能

```bash
# 只測試驗證相關功能
pytest tests/integration/outlines/ -k "validation" -v

# 只測試錯誤處理
pytest tests/integration/outlines/ -k "error" -v

# 只測試 schema 準備
pytest tests/integration/outlines/ -k "prepare" -v
```

**適用於**: 針對性測試、除錯

---

### 場景 6: 除錯失敗的測試

```bash
# 顯示詳細輸出
pytest tests/integration/outlines/test_json_schema.py -vv --tb=long

# 在第一個失敗處停止
pytest tests/integration/outlines/ -x

# 使用 pdb 除錯器
pytest tests/integration/outlines/ --pdb
```

**適用於**: 除錯、問題診斷

---

## 檔案導覽

### 我應該看哪個檔案？

| 需求 | 檔案 | 說明 |
|------|------|------|
| 快速開始 | `QUICKSTART.md` | 本檔案 |
| 詳細文檔 | `README.md` | 完整使用指南 |
| 測試索引 | `TEST_INDEX.md` | 所有測試清單 |
| JSON 測試 | `test_json_schema.py` | JSON Schema 測試程式碼 |
| XML 測試 | `test_xml_mode.py` | XML 模式測試程式碼 |
| 錯誤測試 | `test_error_handling.py` | 錯誤處理測試程式碼 |
| 測試資料 | `fixtures/` | 測試用 JSON/XML 檔案 |

---

## 常見問題

### Q: 測試需要多久時間？
**A**: 通常 < 5 秒。所有外部依賴都被 mock，測試執行非常快。

### Q: 我需要安裝 Outlines 嗎？
**A**: 不需要。沒有 Outlines 時，相關測試會自動跳過。但建議安裝以獲得完整測試覆蓋。

### Q: 我需要真實的 MLX 模型嗎？
**A**: 不需要。所有 MLX 互動都被 mock，測試不需要實際模型。

### Q: 測試失敗了怎麼辦？
**A**:
1. 檢查 Python 版本 (需要 3.9+)
2. 確認已安裝 pytest
3. 查看錯誤訊息
4. 使用 `-vv --tb=long` 獲得詳細輸出

### Q: 如何新增測試？
**A**: 參考 `README.md` 中的「撰寫新測試」章節，或複製現有測試並修改。

### Q: 覆蓋率報告在哪裡？
**A**: 執行帶 `--cov-report=html` 的測試後，報告在 `htmlcov/index.html`。

---

## 快速命令參考

```bash
# 執行所有測試
pytest tests/integration/outlines/ -v

# 執行帶覆蓋率
pytest tests/integration/outlines/ --cov=python/adapters/outlines_adapter --cov-report=html

# 執行 JSON 測試
pytest tests/integration/outlines/test_json_schema.py -v

# 執行 XML 測試
pytest tests/integration/outlines/test_xml_mode.py -v

# 執行錯誤測試
pytest tests/integration/outlines/test_error_handling.py -v

# 執行單一測試
pytest tests/integration/outlines/test_json_schema.py::test_prepare_guidance_simple_schema -v

# 列出所有測試
pytest tests/integration/outlines/ --collect-only

# 重新執行失敗的測試
pytest tests/integration/outlines/ --lf

# 顯示執行時間最長的 10 個測試
pytest tests/integration/outlines/ --durations=10
```

---

## 下一步

1. ✅ 執行測試確認一切正常
2. 📖 閱讀 `README.md` 了解詳細功能
3. 🔍 瀏覽 `TEST_INDEX.md` 查看所有測試
4. 💻 查看測試程式碼學習測試撰寫
5. 🚀 開始開發新功能並新增測試

---

## 需要幫助？

- **詳細文檔**: 查看 `README.md`
- **測試列表**: 查看 `TEST_INDEX.md`
- **實作細節**: 查看 `automatosx/tmp/outlines-integration-tests-summary.md`
- **交付報告**: 查看 `automatosx/tmp/outlines-tests-delivery-report.md`

---

**提示**: 所有測試都經過驗證並可立即執行。如有任何問題，請參考詳細文檔或檢查測試程式碼範例。

祝測試順利！ 🎯
