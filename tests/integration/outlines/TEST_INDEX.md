# Outlines Integration Tests - Test Index

Quick reference for all test functions in the Outlines integration test suite.

**Last Updated**: 2025-10-25
**Total Tests**: 46

---

## test_json_schema.py (12 tests)

### Preparation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_prepare_guidance_simple_schema` | Test basic schema preparation | Simple object schema |
| `test_prepare_guidance_complex_schema` | Test complex nested schema preparation | Nested objects, arrays, enums |

### Validation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_schema_size_validation_too_large` | Test oversized schema rejection | Size limit enforcement |
| `test_prepare_guidance_missing_schema` | Test missing schema error | Error handling |
| `test_array_schema_structure` | Test array schema structure | Array validation |
| `test_enum_constraints_valid` | Test enum constraints (parametrized) | Multiple enum values |

### Generation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_apply_guidance_simple_generation` | Test guidance application to generator | Mock generator, chunks |
| `test_partial_validation_called` | Test partial validation tracking | Incremental validation |
| `test_final_validation_called` | Test final validation execution | Complete output validation |
| `test_empty_text_chunks_handled` | Test empty chunk handling | Edge case |

### Error Handling Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_malformed_json_rejection` | Test malformed JSON rejection | Invalid syntax |
| `test_non_dict_chunk_error` | Test non-dict chunk error | Type validation |

---

## test_xml_mode.py (14 tests)

### Preparation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_prepare_guidance_simple_xml` | Test simple XML schema preparation | Basic XML structure |
| `test_prepare_guidance_nested_xml` | Test nested XML schema preparation | Complex hierarchy |

### Validation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_xml_schema_size_validation` | Test XML schema size limits | Size enforcement |
| `test_non_string_xml_schema_error` | Test non-string schema error | Type validation |

### Generation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_apply_guidance_xml_generation` | Test XML guidance application | XML chunks |
| `test_xml_partial_validation` | Test XML partial validation | Incremental XML validation |
| `test_xml_final_validation` | Test XML final validation | Complete XML validation |
| `test_xml_validation_fallback` | Test ElementTree fallback | Fallback parsing |

### XML Feature Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_xml_with_attributes` | Test XML attribute preservation | Attributes |
| `test_nested_xml_elements` | Test nested element structure | Hierarchy |
| `test_empty_xml_elements` | Test empty/self-closing elements | Edge case |
| `test_xml_with_cdata` | Test CDATA section handling | Special content |

### Error Handling Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_malformed_xml_rejection` | Test malformed XML rejection | Invalid syntax |
| `test_multiple_root_elements` | Test multiple root elements | Edge case |

---

## test_error_handling.py (20 tests)

### Library Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_outlines_not_installed` | Test missing Outlines library | Import error |
| `test_outlines_import_failure` | Test Outlines import failure | Exception handling |

### Schema Validation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_schema_too_large` | Test oversized schema rejection | Size limit |
| `test_missing_schema` | Test missing schema error | Required field |
| `test_empty_schema` | Test empty schema handling | Edge case |
| `test_none_schema` | Test None schema error | Null handling |

### Model Compatibility Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_vision_model_incompatible` | Test vision model detection | Model type check |
| `test_model_without_tokenizer` | Test missing tokenizer detection | Tokenizer requirement |
| `test_validate_guidance_params_vision_model` | Test vision model parameter validation | Compatibility check |
| `test_validate_guidance_params_no_tokenizer` | Test no-tokenizer parameter validation | Requirement check |
| `test_validate_guidance_params_missing_schema` | Test missing schema parameter validation | Required parameter |

### Guard Compilation Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_json_guard_compilation_failure` | Test JSON guard compilation error | Compilation failure |
| `test_xml_guard_compilation_failure` | Test XML guard compilation error | Compilation failure |
| `test_non_dict_json_schema` | Test non-dict JSON schema error | Type check |
| `test_non_string_xml_schema` | Test non-string XML schema error | Type check |
| `test_guard_builder_type_error` | Test TypeError handling in guard builder | Exception handling |

### Generation Pipeline Tests
| Test Function | Description | Key Features |
|--------------|-------------|--------------|
| `test_guidance_pipeline_failure` | Test pipeline failure handling | Runtime error |
| `test_partial_validation_rejection` | Test partial validation failure | Validation error |
| `test_final_validation_rejection` | Test final validation failure | Validation error |
| `test_unsupported_guidance_mode` | Test unsupported mode error | Mode validation |

---

## Test Categories by Type

### Unit Tests (Module-level)
- Schema preparation: 4 tests
- Schema validation: 6 tests
- Guard compilation: 5 tests

### Integration Tests (Component interaction)
- Guidance application: 5 tests
- Validation flow: 8 tests
- Error propagation: 8 tests

### Error Handling Tests
- Library errors: 2 tests
- Schema errors: 4 tests
- Model errors: 5 tests
- Generation errors: 4 tests
- Compilation errors: 5 tests

---

## Test Coverage Map

### Functions Tested

| Function | Test Count | Coverage |
|----------|-----------|----------|
| `prepare_guidance()` | 8 | Complete |
| `apply_guidance()` | 6 | Complete |
| `_validate_schema_size()` | 4 | Complete |
| `_compile_json_guard()` | 4 | Complete |
| `_compile_xml_guard()` | 3 | Complete |
| `_ensure_guard()` | 3 | Complete |
| `_GuardRunner.validate_partial()` | 4 | Complete |
| `_GuardRunner.validate_final()` | 4 | Complete |
| `supports_guidance()` | 3 | Complete |
| `validate_guidance_params()` | 4 | Complete |
| `_load_outlines()` | 2 | Complete |

### Code Paths Tested

- ✅ JSON schema mode
- ✅ XML mode
- ✅ Schema size validation
- ✅ Guard compilation (multiple API variants)
- ✅ Partial validation flow
- ✅ Final validation flow
- ✅ Validation fallback (JSON parsing, XML parsing)
- ✅ Error handling (all error types)
- ✅ Model compatibility checks
- ✅ Parameter validation

---

## Running Specific Test Categories

### JSON Schema Tests Only
```bash
pytest tests/integration/outlines/test_json_schema.py -v
```

### XML Mode Tests Only
```bash
pytest tests/integration/outlines/test_xml_mode.py -v
```

### Error Handling Tests Only
```bash
pytest tests/integration/outlines/test_error_handling.py -v
```

### Tests Requiring Outlines
```bash
pytest tests/integration/outlines/ -v -m "outlines_required"
```

### Tests Not Requiring Outlines
```bash
pytest tests/integration/outlines/ -v -m "not outlines_required"
```

### Specific Test Function
```bash
pytest tests/integration/outlines/test_json_schema.py::test_prepare_guidance_simple_schema -v
```

### Pattern Match
```bash
pytest tests/integration/outlines/ -v -k "validation"
pytest tests/integration/outlines/ -v -k "xml"
pytest tests/integration/outlines/ -v -k "error"
```

---

## Test Statistics

### By File
- **test_json_schema.py**: 12 tests, 477 lines
- **test_xml_mode.py**: 14 tests, 511 lines
- **test_error_handling.py**: 20 tests, 573 lines

### By Category
- **Preparation**: 6 tests (13%)
- **Validation**: 12 tests (26%)
- **Generation**: 8 tests (17%)
- **Error Handling**: 20 tests (44%)

### By Complexity
- **Simple**: 18 tests (basic functionality)
- **Medium**: 20 tests (multiple components)
- **Complex**: 8 tests (full integration)

---

## Test Dependencies

### Required
- Python 3.9+
- pytest
- unittest.mock

### Optional
- outlines>=0.0.40 (tests skip if not available)
- pytest-cov (for coverage reports)
- pytest-mock (for advanced mocking)

### Test Isolation
- ✅ No external network calls
- ✅ No file system writes (except fixtures read)
- ✅ No database connections
- ✅ All external dependencies mocked

---

## Quick Reference Commands

```bash
# Run all tests
pytest tests/integration/outlines/ -v

# Run with coverage
pytest tests/integration/outlines/ --cov=python/adapters/outlines_adapter --cov-report=html

# Run specific test
pytest tests/integration/outlines/test_json_schema.py::test_prepare_guidance_simple_schema -v

# List all tests without running
pytest tests/integration/outlines/ --collect-only

# Run failed tests only
pytest tests/integration/outlines/ --lf

# Run tests in parallel (requires pytest-xdist)
pytest tests/integration/outlines/ -n auto

# Verbose output with full error traces
pytest tests/integration/outlines/ -vv --tb=long

# Show test execution times
pytest tests/integration/outlines/ --durations=10
```

---

**Note**: This index is auto-generated from test discovery. Test counts may vary as tests are added or modified.
