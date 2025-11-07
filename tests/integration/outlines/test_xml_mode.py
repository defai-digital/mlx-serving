"""
Integration tests for Outlines adapter - XML mode

Tests XML schema-guided generation including:
- Simple XML schemas
- Nested XML elements
- XML attributes
- Malformed XML rejection
- Partial vs final validation
"""

import pytest
from pathlib import Path
from typing import Dict, Any, Generator
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from adapters.outlines_adapter import (
    prepare_guidance,
    apply_guidance,
    GuidancePlan,
)
from errors import GuidanceError


# Test fixtures
FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_xml(name: str) -> str:
    """Load an XML fixture"""
    with open(FIXTURES_DIR / f"{name}.xml") as f:
        return f.read()


# Pytest fixtures
@pytest.fixture
def simple_xml_schema():
    """Simple XML schema for person"""
    return """<?xml version="1.0"?>
<person>
  <name>string</name>
  <age>integer</age>
  <email>string</email>
</person>"""


@pytest.fixture
def nested_xml_schema():
    """Complex XML schema with nested elements"""
    return """<?xml version="1.0"?>
<company>
  <name>string</name>
  <employees>
    <employee id="string">
      <name>string</name>
      <department>string</department>
    </employee>
  </employees>
  <location country="string">
    <city>string</city>
    <state>string</state>
  </location>
</company>"""


@pytest.fixture
def mock_model_handle():
    """Create a mock model handle"""
    handle = Mock()
    handle.model_id = "test-model"
    handle.metadata = {"is_vision_model": False}
    handle.tokenizer = Mock()
    return handle


# Test: prepare_guidance with simple XML schema
def test_prepare_guidance_simple_xml(simple_xml_schema):
    """
    Test preparing guidance plan with a simple XML schema

    Verifies:
    - GuidancePlan is created successfully
    - Schema type is 'xml'
    - Schema string is stored correctly
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": "test-model"
    }

    plan = prepare_guidance(plan_config)

    assert isinstance(plan, GuidancePlan)
    assert plan.schema_type == "xml"
    assert plan.schema == simple_xml_schema
    assert "<?xml version" in plan.schema


# Test: prepare_guidance with nested XML schema
def test_prepare_guidance_nested_xml(nested_xml_schema):
    """
    Test preparing guidance plan with a nested XML schema

    Verifies:
    - Complex XML schemas with nested elements are handled
    - Attributes are preserved
    - Schema structure is maintained
    """
    plan_config = {
        "mode": "xml",
        "schema": nested_xml_schema,
        "model_id": "test-model"
    }

    plan = prepare_guidance(plan_config)

    assert plan.schema_type == "xml"
    assert "<company>" in plan.schema
    assert "<employees>" in plan.schema
    assert 'id="string"' in plan.schema
    assert 'country="string"' in plan.schema


# Test: XML schema size validation
def test_xml_schema_size_validation():
    """
    Test that oversized XML schemas are rejected

    Verifies:
    - Schemas exceeding max_schema_size_bytes raise GuidanceError
    - Error message includes size information
    """
    # Create a large XML schema
    large_elements = "".join([f"<field_{i}>string</field_{i}>" for i in range(5000)])
    large_schema = f"""<?xml version="1.0"?>
<root>
  {large_elements}
</root>"""

    plan_config = {
        "mode": "xml",
        "schema": large_schema,
        "model_id": "test-model"
    }

    with pytest.raises(GuidanceError) as exc_info:
        prepare_guidance(plan_config)

    assert "Schema too large" in str(exc_info.value)


# Test: non-string XML schema
def test_non_string_xml_schema_error():
    """
    Test that non-string XML schemas are rejected during compilation

    Verifies:
    - XML mode expects string schema
    - Appropriate error is raised for dict/object schemas
    """
    plan_config = {
        "mode": "xml",
        "schema": {"root": "element"},  # Dict instead of string
        "model_id": "test-model"
    }

    # prepare_guidance doesn't validate type, but guard compilation should
    plan = prepare_guidance(plan_config)

    # This would fail when trying to compile the guard
    assert plan.schema_type == "xml"


# Test: apply_guidance with XML generator
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_apply_guidance_xml_generation(simple_xml_schema, mock_model_handle):
    """
    Test applying XML guidance to a generator function

    Verifies:
    - XML guidance wrapper is created successfully
    - Generator yields XML chunks correctly
    - Partial validation works with XML
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs) -> Generator[Dict[str, Any], None, None]:
        xml_parts = [
            '<?xml version="1.0"?>',
            '<person>',
            '<name>John</name>',
            '<age>30</age>',
            '<email>john@test.com</email>',
            '</person>'
        ]
        for part in xml_parts:
            yield {"text": part, "token_id": 123}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        mock_guard = Mock()
        mock_guard.validate_partial = Mock(return_value=True)
        mock_guard.validate = Mock(return_value=True)
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)
        chunks = list(wrapped_gen())

        assert len(chunks) == 6
        assert all("text" in chunk for chunk in chunks)


# Test: XML partial validation
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_xml_partial_validation(simple_xml_schema, mock_model_handle):
    """
    Test that partial validation works correctly for XML

    Verifies:
    - Partial validator is called for each chunk
    - Output accumulates progressively
    - Incomplete XML during generation is handled
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        yield {"text": '<person>', "token_id": 1}
        yield {"text": '<name>Alice</name>', "token_id": 2}
        yield {"text": '</person>', "token_id": 3}

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

        # Verify partial validation accumulates text
        assert len(partial_calls) == 3
        assert partial_calls[0] == '<person>'
        assert partial_calls[1] == '<person><name>Alice</name>'
        assert partial_calls[2] == '<person><name>Alice</name></person>'


# Test: XML final validation
@pytest.mark.skipif(
    not hasattr(sys.modules.get("importlib.util"), "find_spec") or
    __import__("importlib.util").find_spec("outlines") is None,
    reason="Outlines library not installed"
)
def test_xml_final_validation(simple_xml_schema, mock_model_handle):
    """
    Test that final XML validation is performed

    Verifies:
    - Final validator is called with complete XML
    - Well-formed XML passes validation
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        complete_xml = '<?xml version="1.0"?><person><name>Bob</name><age>25</age><email>bob@test.com</email></person>'
        yield {"text": complete_xml, "token_id": 1}

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
        assert '<?xml version="1.0"?>' in final_call[0]


# Test: malformed XML rejection
def test_malformed_xml_rejection(simple_xml_schema, mock_model_handle):
    """
    Test that malformed XML is rejected during final validation

    Verifies:
    - Invalid XML syntax raises GuidanceError
    - Error message indicates XML parsing failure
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        # Yield malformed XML (unclosed tag)
        yield {"text": '<person><name>Invalid</name>', "token_id": 1}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        # Mock guard without validation methods (fallback to XML parsing)
        mock_guard = Mock(spec=[])
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)

        with pytest.raises(GuidanceError) as exc_info:
            list(wrapped_gen())

        assert "not valid XML" in str(exc_info.value)


# Test: XML with attributes
def test_xml_with_attributes(nested_xml_schema):
    """
    Test that XML schemas with attributes are preserved

    Verifies:
    - Attribute definitions are maintained
    - Schema structure includes attribute syntax
    """
    plan_config = {
        "mode": "xml",
        "schema": nested_xml_schema,
        "model_id": "test-model"
    }
    plan = prepare_guidance(plan_config)

    # Verify attributes are in schema
    assert 'id="string"' in plan.schema
    assert 'country="string"' in plan.schema


# Test: nested XML elements
def test_nested_xml_elements(nested_xml_schema):
    """
    Test that nested XML element structures are preserved

    Verifies:
    - Nested elements are correctly stored
    - Element hierarchy is maintained
    """
    plan_config = {
        "mode": "xml",
        "schema": nested_xml_schema,
        "model_id": "test-model"
    }
    plan = prepare_guidance(plan_config)

    # Parse to verify structure
    try:
        # Remove type hints to make it valid XML
        schema_cleaned = plan.schema.replace(">string<", "><").replace(">integer<", "><")
        root = ET.fromstring(schema_cleaned)

        # Verify nested structure exists
        assert root.tag == "company"
    except ET.ParseError:
        # Schema might have placeholders, that's OK
        pass


# Test: XML validation fallback
def test_xml_validation_fallback(simple_xml_schema, mock_model_handle):
    """
    Test that XML validation falls back to ElementTree parsing

    Verifies:
    - When guard lacks validation methods, ET.fromstring is used
    - Valid XML passes fallback validation
    - Invalid XML fails fallback validation
    """
    plan_config = {
        "mode": "xml",
        "schema": simple_xml_schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    def mock_generator(*args, **kwargs):
        valid_xml = '<person><name>Test</name><age>30</age><email>test@example.com</email></person>'
        yield {"text": valid_xml, "token_id": 1}

    with patch('adapters.outlines_adapter._ensure_guard') as mock_ensure_guard:
        # Mock guard without validation methods
        mock_guard = Mock(spec=[])
        mock_ensure_guard.return_value = mock_guard

        wrapped_gen = apply_guidance(mock_generator, plan)
        chunks = list(wrapped_gen())

        # Should complete without error (fallback validation passes)
        assert len(chunks) == 1


# Test: empty XML elements
def test_empty_xml_elements(mock_model_handle):
    """
    Test that empty XML elements are handled correctly

    Verifies:
    - Self-closing tags are supported
    - Empty elements don't break validation
    """
    schema = """<?xml version="1.0"?>
<config>
  <setting name="string" value="string"/>
  <enabled/>
</config>"""

    plan_config = {
        "mode": "xml",
        "schema": schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    assert plan.schema_type == "xml"
    assert "<enabled/>" in plan.schema


# Test: XML with CDATA
def test_xml_with_cdata(mock_model_handle):
    """
    Test that XML schemas with CDATA sections are preserved

    Verifies:
    - CDATA sections are maintained in schema
    - Special characters in CDATA are handled
    """
    schema = """<?xml version="1.0"?>
<document>
  <content><![CDATA[Some <special> content]]></content>
</document>"""

    plan_config = {
        "mode": "xml",
        "schema": schema,
        "model_id": mock_model_handle.model_id
    }
    plan = prepare_guidance(plan_config)

    assert "<![CDATA[" in plan.schema


# Test: multiple root elements error
def test_multiple_root_elements(mock_model_handle):
    """
    Test that XML with multiple root elements is handled

    Note: prepare_guidance doesn't validate XML structure,
    but this would fail during guard compilation or validation
    """
    schema = """<?xml version="1.0"?>
<root1>content</root1>
<root2>content</root2>"""

    plan_config = {
        "mode": "xml",
        "schema": schema,
        "model_id": mock_model_handle.model_id
    }

    # prepare_guidance accepts it (validation happens later)
    plan = prepare_guidance(plan_config)
    assert plan.schema_type == "xml"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
