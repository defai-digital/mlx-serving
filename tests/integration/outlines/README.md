# Outlines Integration Tests

End-to-end tests for the Outlines adapter in kr-mlx-lm.

## Test Structure

```
tests/integration/outlines/
├── __init__.py                 # Package marker
├── conftest.py                 # Pytest configuration and shared fixtures
├── README.md                   # This file
├── test_json_schema.py         # JSON schema mode tests
├── test_xml_mode.py            # XML mode tests
├── test_error_handling.py      # Error scenario tests
└── fixtures/                   # Test data
    ├── simple_schema.json      # Simple JSON schema
    ├── complex_schema.json     # Complex nested schema
    ├── array_schema.json       # Array schema
    ├── enum_schema.json        # Enum constraints schema
    ├── simple.xml              # Simple XML example
    └── nested.xml              # Nested XML example
```

## Running Tests

### Run all Outlines tests
```bash
cd /Users/akiralam/Desktop/defai/kr-mlx-lm
pytest tests/integration/outlines/ -v
```

### Run specific test file
```bash
pytest tests/integration/outlines/test_json_schema.py -v
pytest tests/integration/outlines/test_xml_mode.py -v
pytest tests/integration/outlines/test_error_handling.py -v
```

### Run specific test
```bash
pytest tests/integration/outlines/test_json_schema.py::test_prepare_guidance_simple_schema -v
```

### Run with coverage
```bash
pytest tests/integration/outlines/ --cov=python/adapters/outlines_adapter --cov-report=html
```

### Skip tests requiring Outlines library
```bash
pytest tests/integration/outlines/ -v -m "not outlines_required"
```

## Test Categories

### JSON Schema Tests (`test_json_schema.py`)

Tests for JSON schema-guided generation:

- **Simple schemas**: Basic object schemas with string/integer types
- **Complex schemas**: Nested objects, arrays, and enums
- **Partial validation**: Incremental validation during generation
- **Final validation**: Complete output validation
- **Error handling**: Malformed JSON rejection

**Key test cases:**
- `test_prepare_guidance_simple_schema`: Basic schema preparation
- `test_schema_size_validation_too_large`: Oversized schema rejection
- `test_partial_validation_called`: Incremental validation tracking
- `test_final_validation_called`: Final validation verification
- `test_malformed_json_rejection`: Invalid JSON handling

### XML Mode Tests (`test_xml_mode.py`)

Tests for XML schema-guided generation:

- **Simple XML**: Basic XML element structures
- **Nested elements**: Complex hierarchical XML
- **Attributes**: XML attribute handling
- **CDATA sections**: Special XML content
- **Validation fallback**: ElementTree parsing fallback

**Key test cases:**
- `test_prepare_guidance_simple_xml`: Basic XML schema setup
- `test_xml_partial_validation`: Incremental XML validation
- `test_malformed_xml_rejection`: Invalid XML handling
- `test_xml_with_attributes`: Attribute preservation

### Error Handling Tests (`test_error_handling.py`)

Tests for error scenarios:

- **Library not installed**: Outlines missing error handling
- **Invalid schemas**: Oversized, malformed, or missing schemas
- **Incompatible models**: Vision models, models without tokenizers
- **Compilation failures**: Guard compilation errors
- **Validation failures**: Partial and final validation rejections

**Key test cases:**
- `test_outlines_not_installed`: Missing library handling
- `test_vision_model_incompatible`: Vision model detection
- `test_json_guard_compilation_failure`: Guard compilation errors
- `test_partial_validation_rejection`: Partial validation failures

## Test Fixtures

### JSON Schemas

**simple_schema.json**: Person object with name and age
```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string"},
    "age": {"type": "integer"}
  },
  "required": ["name", "age"]
}
```

**complex_schema.json**: User profile with nested objects and enums

**array_schema.json**: Shopping cart with items array

**enum_schema.json**: Configuration with enum constraints

### XML Schemas

**simple.xml**: Person XML structure

**nested.xml**: Company with nested employees and location

## Mock Strategy

Tests use mocking to avoid external dependencies:

1. **Outlines library**: Mocked when testing without installation
2. **MLX generator**: Mock generator functions for controlled output
3. **Model handles**: Mock model metadata and tokenizers
4. **Guard objects**: Mock validation methods for testing flows

## Test Requirements

### Required for all tests:
- pytest
- Python 3.9+
- Mock/unittest.mock

### Required for Outlines integration tests:
- outlines >= 0.0.40 (optional, tests skip if not available)
- orjson (optional, falls back to json)

### Install test dependencies:
```bash
pip install pytest pytest-cov pytest-mock
```

### Install Outlines (optional):
```bash
pip install outlines>=0.0.40
```

## Writing New Tests

### Template for JSON schema test:
```python
def test_my_feature(simple_schema, mock_model_handle):
    """
    Test description

    Verifies:
    - Point 1
    - Point 2
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    # Test assertions
    assert condition
```

### Template for XML mode test:
```python
def test_xml_feature(simple_xml_schema, mock_model_handle):
    """
    Test description

    Verifies:
    - Point 1
    - Point 2
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    # Test assertions
    assert condition
```

## Best Practices

1. **Use descriptive test names**: `test_<feature>_<scenario>`
2. **Add docstrings**: Explain what the test verifies
3. **Use parametrize**: For testing multiple similar cases
4. **Mock external dependencies**: Keep tests fast and isolated
5. **Test both success and failure**: Cover happy and error paths
6. **Keep tests independent**: No shared state between tests
7. **Use fixtures**: Share common setup via pytest fixtures

## Debugging Tests

### Run with verbose output:
```bash
pytest tests/integration/outlines/test_json_schema.py -vv -s
```

### Run with debugger:
```bash
pytest tests/integration/outlines/test_json_schema.py --pdb
```

### Show all test output:
```bash
pytest tests/integration/outlines/ -v --capture=no
```

### Run only failed tests:
```bash
pytest tests/integration/outlines/ --lf
```

## CI/CD Integration

These tests are designed to run in CI/CD pipelines:

- **Fast execution**: Mock dependencies for speed
- **Isolated**: No external service dependencies
- **Skip gracefully**: Skip Outlines-specific tests if library not installed
- **Clear output**: Descriptive assertions and error messages

## Coverage Goals

Target coverage for `python/adapters/outlines_adapter.py`:

- **Lines**: > 90%
- **Branches**: > 85%
- **Functions**: 100%

Check coverage:
```bash
pytest tests/integration/outlines/ --cov=python/adapters/outlines_adapter --cov-report=term-missing
```

## Known Limitations

1. Tests mock Outlines library behavior - actual Outlines integration should be tested manually
2. Guard compilation is mocked - real schema compilation not tested
3. MLX generator interaction is mocked - end-to-end MLX flow requires integration tests with real models

## Future Enhancements

- [ ] Add performance benchmarks for guidance overhead
- [ ] Test with real Outlines library (optional integration tests)
- [ ] Add stress tests for large schemas
- [ ] Test concurrent guidance applications
- [ ] Add benchmarks for partial vs final validation overhead
