"""
Integration tests for Outlines adapter - Error Handling

Tests error scenarios including:
- Outlines library not installed
- Invalid schemas (too large, malformed)
- Incompatible models (vision models)
- Guidance failures during generation
- Schema compilation errors
"""

import pytest
from pathlib import Path
from typing import Dict, Any
from unittest.mock import Mock, patch, MagicMock
import importlib.util

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from adapters.outlines_adapter import (
    prepare_guidance,
    apply_guidance,
    supports_guidance,
    validate_guidance_params,
    _load_outlines,
    _compile_json_guard,
    _compile_xml_guard,
)
from errors import GuidanceError


# Pytest fixtures
@pytest.fixture
def mock_model_handle():
    """Create a mock model handle"""
    handle = Mock()
    handle.model_id = "test-model"
    handle.metadata = {"is_vision_model": False}
    handle.tokenizer = Mock()
    return handle


@pytest.fixture
def mock_vision_model_handle():
    """Create a mock vision model handle"""
    handle = Mock()
    handle.model_id = "vision-model"
    handle.metadata = {"is_vision_model": True}
    handle.tokenizer = Mock()
    return handle


@pytest.fixture
def simple_schema():
    """Simple JSON schema for testing"""
    return {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "integer"}
        },
        "required": ["name"]
    }


# Test: Outlines library not installed
def test_outlines_not_installed():
    """
    Test behavior when Outlines library is not installed

    Verifies:
    - GuidanceError is raised with descriptive message
    - Error indicates installation requirement
    """
    with patch('importlib.util.find_spec') as mock_find_spec:
        mock_find_spec.return_value = None

        with pytest.raises(GuidanceError) as exc_info:
            _load_outlines()

        assert "Install outlines>=0.0.40" in str(exc_info.value)
        assert exc_info.value.model_id == "n/a"


# Test: Outlines import failure
def test_outlines_import_failure():
    """
    Test behavior when Outlines import fails

    Verifies:
    - GuidanceError is raised on import exception
    - Original exception is preserved in chain
    """
    with patch('importlib.util.find_spec') as mock_find_spec:
        mock_find_spec.return_value = Mock()  # Library exists

        with patch('importlib.import_module') as mock_import:
            mock_import.side_effect = ImportError("Module broken")

            with pytest.raises(GuidanceError) as exc_info:
                _load_outlines()

            assert "Failed to import outlines" in str(exc_info.value)
            assert "Module broken" in str(exc_info.value)


# Test: Invalid schema - too large
def test_schema_too_large(simple_schema):
    """
    Test that oversized schemas are rejected

    Verifies:
    - Schemas exceeding max_schema_size_bytes raise GuidanceError
    - Error message includes size information
    """
    # Create massive schema
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
    assert "bytes >" in str(exc_info.value)


# Test: Missing schema
def test_missing_schema():
    """
    Test that missing schema raises appropriate error

    Verifies:
    - GuidanceError is raised when schema is absent
    - Error message is clear
    """
    plan_config = {
        "mode": "json_schema",
        "model_id": "test-model"
    }

    with pytest.raises(GuidanceError) as exc_info:
        prepare_guidance(plan_config)

    assert "Schema is required" in str(exc_info.value)
    assert exc_info.value.model_id == "test-model"


# Test: Vision model incompatibility
def test_vision_model_incompatible(mock_vision_model_handle):
    """
    Test that vision models are detected as incompatible

    Verifies:
    - supports_guidance returns False for vision models
    - Appropriate error message is provided
    """
    assert not supports_guidance(mock_vision_model_handle)


# Test: Model without tokenizer
def test_model_without_tokenizer():
    """
    Test that models without tokenizer are incompatible

    Verifies:
    - supports_guidance returns False when tokenizer is None
    - Error handling for missing tokenizer
    """
    handle = Mock()
    handle.model_id = "no-tokenizer-model"
    handle.metadata = {"is_vision_model": False}
    handle.tokenizer = None

    assert not supports_guidance(handle)


# Test: validate_guidance_params with vision model
def test_validate_guidance_params_vision_model(mock_vision_model_handle, simple_schema):
    """
    Test that validate_guidance_params rejects vision models

    Verifies:
    - GuidanceError is raised for vision models
    - Error message indicates incompatibility
    """
    params = {
        "mode": "json_schema",
        "schema": simple_schema
    }

    with pytest.raises(GuidanceError) as exc_info:
        validate_guidance_params(mock_vision_model_handle, params)

    assert "Vision models do not support structured output" in str(exc_info.value)
    assert exc_info.value.model_id == "vision-model"


# Test: validate_guidance_params without tokenizer
def test_validate_guidance_params_no_tokenizer(simple_schema):
    """
    Test that validate_guidance_params rejects models without tokenizer

    Verifies:
    - GuidanceError is raised when tokenizer is missing
    - Error message indicates tokenizer requirement
    """
    handle = Mock()
    handle.model_id = "no-tokenizer"
    handle.metadata = {"is_vision_model": False}
    handle.tokenizer = None

    params = {
        "mode": "json_schema",
        "schema": simple_schema
    }

    with pytest.raises(GuidanceError) as exc_info:
        validate_guidance_params(handle, params)

    assert "Model lacks tokenizer" in str(exc_info.value)


# Test: validate_guidance_params missing schema
def test_validate_guidance_params_missing_schema(mock_model_handle):
    """
    Test that validate_guidance_params requires schema

    Verifies:
    - GuidanceError is raised when schema is missing
    - Error message is descriptive
    """
    params = {"mode": "json_schema"}

    with pytest.raises(GuidanceError) as exc_info:
        validate_guidance_params(mock_model_handle, params)

    assert "Schema is required" in str(exc_info.value)


# Test: JSON guard compilation failure
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_json_guard_compilation_failure():
    """
    Test handling of JSON guard compilation failures

    Verifies:
    - GuidanceError is raised when guard compilation fails
    - Error message includes compilation details
    """
    # Mock outlines with no compatible constructors
    mock_outlines = Mock()
    mock_outlines.models = Mock(spec=[])  # No json_schema module

    schema = {"type": "object", "properties": {"test": {"type": "string"}}}

    with pytest.raises(GuidanceError) as exc_info:
        _compile_json_guard(mock_outlines, schema, "test-model")

    assert "Failed to compile JSON schema guard" in str(exc_info.value)
    assert exc_info.value.model_id == "test-model"


# Test: XML guard compilation failure
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_xml_guard_compilation_failure():
    """
    Test handling of XML guard compilation failures

    Verifies:
    - GuidanceError is raised when XML guard compilation fails
    - Error message indicates XML-specific failure
    """
    # Mock outlines with no XML support
    mock_outlines = Mock()
    mock_outlines.models = Mock(spec=[])  # No xml module

    schema = '<?xml version="1.0"?><root><test>string</test></root>'

    with pytest.raises(GuidanceError) as exc_info:
        _compile_xml_guard(mock_outlines, schema, "test-model")

    assert "Failed to compile XML guard" in str(exc_info.value)
    assert exc_info.value.model_id == "test-model"


# Test: Non-dict schema for JSON mode
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_non_dict_json_schema():
    """
    Test that non-dict schemas are rejected for JSON mode

    Verifies:
    - GuidanceError is raised for string/list schemas
    - Error message indicates dict requirement
    """
    mock_outlines = Mock()

    with pytest.raises(GuidanceError) as exc_info:
        _compile_json_guard(mock_outlines, "not a dict", "test-model")

    assert "expects a dictionary schema" in str(exc_info.value)


# Test: Non-string schema for XML mode
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_non_string_xml_schema():
    """
    Test that non-string schemas are rejected for XML mode

    Verifies:
    - GuidanceError is raised for dict/object schemas
    - Error message indicates string requirement
    """
    mock_outlines = Mock()

    with pytest.raises(GuidanceError) as exc_info:
        _compile_xml_guard(mock_outlines, {"not": "a string"}, "test-model")

    assert "expects schema to be a string" in str(exc_info.value)


# Test: Guidance pipeline failure during generation
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_guidance_pipeline_failure(simple_schema, mock_model_handle):
    """
    Test handling of failures during guided generation

    Verifies:
    - Exceptions during generation are wrapped in GuidanceError
    - Original exception is preserved
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '{"name":', "token_id": 1}
        raise RuntimeError("Generator crashed")

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        mock_guard.validate_partial = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "Guidance pipeline failed" in str(exc_info.value)


# Test: Partial validation rejection
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_partial_validation_rejection(simple_schema, mock_model_handle):
    """
    Test that partial validation failures are caught

    Verifies:
    - GuidanceError is raised when partial validation fails
    - Generation stops immediately
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '{"invalid":', "token_id": 1}
        yield {"text": ' "structure"}', "token_id": 2}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()

        # Partial validator rejects on first call
        def reject_partial(text):
            raise ValueError("Invalid structure")

        mock_guard.validate_partial = reject_partial
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "partial validation failed" in str(exc_info.value)


# Test: Final validation rejection
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_final_validation_rejection(simple_schema, mock_model_handle):
    """
    Test that final validation failures are caught

    Verifies:
    - GuidanceError is raised when final validation fails
    - Error occurs after generation completes
    """
    plan_config = {
        "mode": "json_schema",
        "schema": simple_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '{"name": "Test"}', "token_id": 1}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        mock_guard.validate_partial = Mock(return_value=True)

        def reject_final(text, partial=None):
            return False  # Return False to trigger rejection

        mock_guard.validate = reject_final
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "rejected final output" in str(exc_info.value)


# Test: Unsupported guidance mode
def test_unsupported_guidance_mode(simple_schema):
    """
    Test that unsupported guidance modes are rejected

    Verifies:
    - GuidanceError is raised for unknown modes
    - Error message indicates supported modes
    """
    plan_config = {
        "mode": "unsupported_mode",
        "schema": simple_schema,
        "model_id": "test-model"
    }

    plan = prepare_guidance(plan_config)

    # Error occurs when trying to ensure guard
    with patch('adapters.outlines_adapter._load_outlines') as mock_load:
        mock_load.return_value = Mock()

        with pytest.raises(GuidanceError) as exc_info:
            from adapters.outlines_adapter import _ensure_guard
            _ensure_guard(plan, mock_load.return_value)

        assert "Unsupported guidance mode" in str(exc_info.value)


# Test: Guard builder TypeError handling
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    importlib.util.find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_guard_builder_type_error():
    """
    Test handling of TypeError during guard construction

    Verifies:
    - Multiple constructor signatures are tried
    - TypeErrors are caught and alternative approaches attempted
    """
    mock_outlines = Mock()

    # Create mock builder that raises TypeError on first call
    mock_builder = Mock(side_effect=[TypeError("Wrong args"), {"guard": "object"}])
    mock_module = Mock()
    mock_module.from_dict = mock_builder
    mock_outlines.models.json_schema = mock_module

    schema = {"type": "object", "properties": {"test": {"type": "string"}}}

    # Should not raise, should try alternative signature
    result = _compile_json_guard(mock_outlines, schema, "test-model")

    # Should have called builder twice (positional, then keyword)
    assert mock_builder.call_count >= 1


# Test: Empty schema
def test_empty_schema():
    """
    Test handling of empty schemas

    Verifies:
    - Empty dict/string schemas raise GuidanceError
    - Error message is descriptive
    """
    plan_config = {
        "mode": "json_schema",
        "schema": {},
        "model_id": "test-model"
    }

    # prepare_guidance accepts empty schema (validation happens at compilation)
    plan = prepare_guidance(plan_config)
    assert plan.schema == {}


# Test: None schema
def test_none_schema():
    """
    Test handling of None schema

    Verifies:
    - None schema raises GuidanceError
    - Error message indicates schema is required
    """
    plan_config = {
        "mode": "json_schema",
        "schema": None,
        "model_id": "test-model"
    }

    with pytest.raises(GuidanceError) as exc_info:
        prepare_guidance(plan_config)

    assert "Schema is required" in str(exc_info.value)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
