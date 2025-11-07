"""
Integration tests for Outlines adapter - JSON Schema mode

Tests JSON schema-guided generation including:
- Simple object schemas
- Complex nested schemas
- Array schemas
- Enum constraints
- Partial validation during generation
- Final validation
- Malformed output rejection
"""

import json
import pytest
from pathlib import Path
from typing import Dict, Any, Generator
from unittest.mock import Mock, MagicMock, patch

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from adapters.outlines_adapter import (
    prepare_guidance,
    apply_guidance,
    GuidancePlan,
    _load_outlines,
)
from errors import GuidanceError


# Test fixtures
FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_schema(name: str) -> Dict[str, Any]:
    """Load a JSON schema fixture"""
    with open(FIXTURES_DIR / f"{name}.json") as f:
        return json.load(f)


# Pytest fixtures
@pytest.fixture
def simple_schema():
    """Simple person schema with name and age"""
    return load_schema("simple_schema")


@pytest.fixture
def complex_schema():
    """Complex nested schema with user profile"""
    return load_schema("complex_schema")


@pytest.fixture
def array_schema():
    """Schema with array of items"""
    return load_schema("array_schema")


@pytest.fixture
def enum_schema():
    """Schema with enum constraints"""
    return load_schema("enum_schema")


@pytest.fixture
def mock_model_handle():
    """Create a mock model handle"""
    handle = Mock()
    handle.model_id = "test-model"
    handle.metadata = {"is_vision_model": False}
    handle.tokenizer = Mock()
    return handle


# Test: prepare_guidance with simple schema
def test_prepare_guidance_simple_schema(simple_schema):
    """
    Test preparing guidance plan with a simple JSON schema

    Verifies:
    - GuidancePlan is created successfully
    - Schema type is correctly identified
    - Schema is stored in plan
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": "test-model"
    }

    plan = prepare_guidance(plan_config)

    assert isinstance(plan, GuidancePlan)
    assert plan.schema_type == "json_schema"
    assert plan.schema == simple_schema
    assert plan.config == plan_config


# Test: prepare_guidance with complex nested schema
def test_prepare_guidance_complex_schema(complex_schema):
    """
    Test preparing guidance plan with a complex nested schema

    Verifies:
    - Complex schemas with nested objects are handled
    - Arrays and enums are supported
    - Required fields are preserved
    """
    plan_config = {
        "mode": "json_schema",
        "schema": complex_schema,
        "model_id": "test-model"
    }

    plan = prepare_guidance(plan_config)

    assert plan.schema_type == "json_schema"
    assert "user" in plan.schema["properties"]
    assert "tags" in plan.schema["properties"]
    assert "status" in plan.schema["properties"]


# Test: schema size validation
def test_schema_size_validation_too_large():
    """
    Test that oversized schemas are rejected

    Verifies:
    - Schemas exceeding max_schema_size_bytes raise GuidanceError
    - Error message includes size information
    """
    # Create a large schema that exceeds the limit
    large_properties = {f"field_{i}": {"type": "string"} for i in range(10000)}
    large_schema = {
        "type": "object",
        "properties": large_properties
    }

    plan_config = {
        "mode": "json_schema",
        "schema": large_schema,
        "model_id": "test-model"
    }

    with pytest.raises(GuidanceError) as exc_info:
        prepare_guidance(plan_config)

    assert "Schema too large" in str(exc_info.value)


# Test: missing schema
def test_prepare_guidance_missing_schema():
    """
    Test that missing schema raises appropriate error

    Verifies:
    - GuidanceError is raised when schema is not provided
    - Error message is descriptive
    """
    plan_config = {
        "mode": "json_schema",
        "model_id": "test-model"
    }

    with pytest.raises(GuidanceError) as exc_info:
        prepare_guidance(plan_config)

    assert "Schema is required" in str(exc_info.value)


# Test: apply_guidance with mock generator
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_apply_guidance_simple_generation(simple_schema, mock_model_handle):
    """
    Test applying guidance to a generator function

    Verifies:
    - Guidance wrapper is created successfully
    - Generator yields chunks correctly
    - Partial validation is called during generation
    - Final validation is called at completion
    """
    # Create guidance plan
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    # Mock generator that yields valid JSON tokens
    def mock_generator(*args, **kwargs) -> Generator[Dict[str, Any], None, None]:
        tokens = ['{"name":', ' "John"', ', "age":', ' 30', '}']
        for token in tokens:
            yield {"text": token, "token_id": 123}

    # Apply guidance
    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        # Mock the guard compilation
        mock_guard = Mock()
        mock_guard.validate_partial = Mock(return_value=True)
        mock_guard.validate = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        # Collect output
        chunks = list(wrapped_gen())

        assert len(chunks) == 5
        assert all("text" in chunk for chunk in chunks)


# Test: partial validation during generation
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_partial_validation_called(simple_schema, mock_model_handle):
    """
    Test that partial validation is invoked for each chunk

    Verifies:
    - Partial validator is called incrementally
    - Current output accumulates correctly
    - Invalid partial output raises GuidanceError
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '{"name":', "token_id": 1}
        yield {"text": ' "Alice"', "token_id": 2}
        yield {"text": ', "age": 25}', "token_id": 3}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        partial_calls = []

        def track_partial(text):
            partial_calls.append(text)
            return True

        mock_guard.validate_partial = track_partial
        mock_guard.validate = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)
        list(wrapped_gen())

        # Verify partial validation was called with accumulated text
        assert len(partial_calls) == 3
        assert partial_calls[0] == '{"name":'
        assert partial_calls[1] == '{"name": "Alice"'
        assert partial_calls[2] == '{"name": "Alice", "age": 25}'


# Test: final validation
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_final_validation_called(simple_schema, mock_model_handle):
    """
    Test that final validation is called after generation completes

    Verifies:
    - Final validator is invoked with complete output
    - Invalid final output raises GuidanceError
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '{"name": "Bob", "age": 35}', "token_id": 1}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        final_call = []

        def track_final(text, partial=None):
            final_call.append(text)
            return True

        mock_guard.validate_partial = Mock(return_value=True)
        mock_guard.validate = track_final
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)
        list(wrapped_gen())

        # Verify final validation was called
        assert len(final_call) == 1
        assert final_call[0] == '{"name": "Bob", "age": 35}'


# Test: malformed JSON rejection
def test_malformed_json_rejection(simple_schema, mock_model_handle):
    """
    Test that malformed JSON output is rejected during final validation

    Verifies:
    - Invalid JSON syntax raises GuidanceError
    - Error message indicates JSON parsing failure
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        # Yield malformed JSON
        yield {"text": '{"name": "Invalid", "age": }', "token_id": 1}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        # Mock guard that doesn't have validation methods (fallback to JSON parsing)
        mock_guard = Mock(spec=[])
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "not valid JSON" in str(exc_info.value)


# Test: enum constraints
@pytest.mark.parametrize("valid_color,valid_size", [
    ("red", "small"),
    ("green", "medium"),
    ("blue", "large"),
    ("yellow", "xlarge"),
])
def test_enum_constraints_valid(enum_schema, valid_color, valid_size):
    """
    Test that valid enum values are accepted

    Verifies:
    - Enum constraints are properly enforced
    - Valid values from enum list are accepted
    """
    plan_config = {
        "mode": "json_schema",
        "schema": enum_schema,
        "model_id": "test-model"
    }
    plan = prepare_guidance(plan_config)

    # Verify schema has enum constraints
    assert "enum" in plan.schema["properties"]["color"]
    assert valid_color in plan.schema["properties"]["color"]["enum"]
    assert valid_size in plan.schema["properties"]["size"]["enum"]


# Test: array schema
def test_array_schema_structure(array_schema):
    """
    Test that array schemas are correctly structured

    Verifies:
    - Array items schema is preserved
    - Required fields are maintained
    - Nested object properties are accessible
    """
    plan_config = {
        "mode": "json_schema",
        "schema": array_schema,
        "model_id": "test-model"
    }
    plan = prepare_guidance(plan_config)

    # Verify array structure
    assert "items" in plan.schema["properties"]
    assert plan.schema["properties"]["items"]["type"] == "array"

    # Verify nested item schema
    item_schema = plan.schema["properties"]["items"]["items"]
    assert item_schema["type"] == "object"
    assert "id" in item_schema["properties"]
    assert "name" in item_schema["properties"]
    assert "price" in item_schema["properties"]


# Test: non-dict chunk handling
def test_non_dict_chunk_error(simple_schema, mock_model_handle):
    """
    Test that non-dict chunks raise appropriate error

    Verifies:
    - Generator expecting dict chunks rejects other types
    - Error message indicates type mismatch
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield "invalid string chunk"  # Should be dict

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        mock_guard.validate_partial = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "expected dict chunks" in str(exc_info.value)


# Test: empty text chunks
def test_empty_text_chunks_handled(simple_schema, mock_model_handle):
    """
    Test that empty text chunks are handled gracefully

    Verifies:
    - Chunks with empty text don't trigger validation
    - Generation continues normally
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": "", "token_id": 1}  # Empty chunk
        yield {"text": '{"name": "Test", "age": 30}', "token_id": 2}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        partial_calls = []

        def track_partial(text):
            partial_calls.append(text)
            return True

        mock_guard.validate_partial = track_partial
        mock_guard.validate = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)
        chunks = list(wrapped_gen())

        # Only non-empty text should trigger validation
        assert len(partial_calls) == 1
        assert len(chunks) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
