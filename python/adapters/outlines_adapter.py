"""
Outlines adapter - Structured output using Outlines library

Responsibilities:
- Prepare guidance plans from JSON/XML schemas
- Apply guidance to wrap base generator
- Check model compatibility with structured output
"""

import importlib
import importlib.util
from typing import Dict, Any, Callable, Optional
from dataclasses import dataclass

try:
    import orjson
    HAS_ORJSON = True
except ImportError:
    import json
    HAS_ORJSON = False

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from errors import GuidanceError
from config_loader import get_config


@dataclass
class GuidancePlan:
    """Prepared guidance configuration"""

    schema_type: str  # 'json_schema' or 'xml'
    schema: Any  # Parsed schema
    config: Dict[str, Any]  # Additional configuration
    guard: Any = None  # Compiled Outlines guard (if loaded)


def _load_outlines():
    """
    Lazy-load Outlines library

    Returns:
        Outlines module

    Raises:
        GuidanceError: If Outlines is not installed
    """
    outlines_spec = importlib.util.find_spec("outlines")
    if outlines_spec is None:
        raise GuidanceError("n/a", "Install outlines>=0.0.40 for structured output")

    try:
        outlines = importlib.import_module("outlines")
        return outlines
    except Exception as exc:
        raise GuidanceError("n/a", f"Failed to import outlines: {exc}") from exc


def _validate_schema_size(schema: Any, mode: str) -> None:
    """
    Validate schema size to prevent compile overhead

    Args:
        schema: Schema to validate
        mode: Schema mode ('json_schema' or 'xml')

    Raises:
        GuidanceError: If schema is too large
    """
    config = get_config()
    try:
        if mode == "json_schema":
            if HAS_ORJSON:
                schema_bytes = orjson.dumps(schema)
            else:
                schema_bytes = json.dumps(schema).encode("utf-8")
        elif mode == "xml":
            schema_bytes = schema.encode("utf-8") if isinstance(schema, str) else str(schema).encode("utf-8")
        else:
            # Unknown mode, skip validation
            return

        if len(schema_bytes) > config.max_schema_size_bytes:
            raise GuidanceError(
                "n/a",
                f"Schema too large ({len(schema_bytes)} bytes > {config.max_schema_size_bytes} limit). "
                f"Large schemas cause significant compile overhead.",
            )
    except (TypeError, ValueError) as exc:
        raise GuidanceError("n/a", f"Invalid schema format: {exc}") from exc


def prepare_guidance(plan: Dict[str, Any]) -> GuidancePlan:
    """
    Prepare guidance plan from schema

    Args:
        plan: Guidance configuration
            - mode: 'json_schema' or 'xml'
            - schema: JSON schema dict or XML string
            - model_id: Optional model identifier

    Returns:
        GuidancePlan ready for application

    Raises:
        GuidanceError: If schema is invalid or Outlines unavailable
    """
    outlines = _load_outlines()

    mode = plan.get("mode", "json_schema")
    schema = plan.get("schema")
    model_id = plan.get("model_id", "n/a")

    if not schema:
        raise GuidanceError(model_id, "Schema is required")

    # BUG-005 FIX: Validate schema type before size validation
    # This provides clear error messages and fail-fast behavior
    if mode == "json_schema":
        if not isinstance(schema, dict):
            raise GuidanceError(
                model_id,
                f"JSON schema guidance expects a dictionary, got {type(schema).__name__}"
            )
    elif mode == "xml":
        if not isinstance(schema, str):
            raise GuidanceError(
                model_id,
                f"XML guidance expects a string schema, got {type(schema).__name__}"
            )
    else:
        raise GuidanceError(model_id, f"Unsupported guidance mode: {mode}")

    # Validate schema size
    _validate_schema_size(schema, mode)

    return GuidancePlan(schema_type=mode, schema=schema, config=plan, guard=None)


def _resolve_attr(root: Any, path: str) -> Any:
    """Resolve dotted attribute path and return None if any part missing."""
    current = root
    for part in path.split("."):
        if not part:
            continue
        current = getattr(current, part, None)
        if current is None:
            return None
    return current


def _compile_json_guard(outlines: Any, schema: Any, model_id: str) -> Any:
    """Compile a JSON schema guard using whichever API the installed outlines exposes."""
    if not isinstance(schema, dict):
        raise GuidanceError(model_id, "JSON schema guidance expects a dictionary schema")

    candidates = [
        ("models.json_schema", "from_dict"),
        ("models.json_schema", "guard"),
        ("models.json_schema", "build_guard"),
        ("models", "json_schema_from_dict"),
        ("json_schema", "from_dict"),
    ]

    errors: list[str] = []

    for module_path, attr_name in candidates:
        module = _resolve_attr(outlines, module_path)
        if module is None:
            continue
        guard_builder = getattr(module, attr_name, None)
        if not callable(guard_builder):
            continue

        try:
            return guard_builder(schema)  # type: ignore[arg-type,misc]
        except TypeError:
            try:
                return guard_builder(schema=schema)  # type: ignore[arg-type,misc]
            except Exception as exc:
                errors.append(f"{module_path}.{attr_name}(schema=...): {exc}")
        except Exception as exc:
            errors.append(f"{module_path}.{attr_name}(schema): {exc}")

    details = "; ".join(errors) if errors else "no compatible constructor found"
    raise GuidanceError(model_id, f"Failed to compile JSON schema guard via Outlines ({details})")


def _compile_xml_guard(outlines: Any, schema: Any, model_id: str) -> Any:
    """Compile an XML guard using the available outlines API surface."""
    if not isinstance(schema, str):
        raise GuidanceError(model_id, "XML guidance expects schema to be a string")

    candidates = [
        ("models.xml", "from_string"),
        ("models.xml", "guard"),
        ("xml", "from_string"),
    ]

    errors: list[str] = []

    for module_path, attr_name in candidates:
        module = _resolve_attr(outlines, module_path)
        if module is None:
            continue
        guard_builder = getattr(module, attr_name, None)
        if not callable(guard_builder):
            continue

        try:
            return guard_builder(schema)  # type: ignore[arg-type]
        except TypeError:
            try:
                return guard_builder(xml=schema)  # type: ignore[arg-type]
            except Exception as exc:
                errors.append(f"{module_path}.{attr_name}(xml=...): {exc}")
        except Exception as exc:
            errors.append(f"{module_path}.{attr_name}(schema): {exc}")

    details = "; ".join(errors) if errors else "no compatible constructor found"
    raise GuidanceError(model_id, f"Failed to compile XML guard via Outlines ({details})")


def _ensure_guard(plan: GuidancePlan, outlines: Any) -> Any:
    """Compile and cache the guard in the plan."""
    if plan.guard is not None:
        return plan.guard

    model_id = plan.config.get("model_id", "n/a")
    if plan.schema_type == "json_schema":
        plan.guard = _compile_json_guard(outlines, plan.schema, model_id)
    elif plan.schema_type == "xml":
        plan.guard = _compile_xml_guard(outlines, plan.schema, model_id)
    else:
        raise GuidanceError(model_id, f"Unsupported guidance mode: {plan.schema_type}")

    return plan.guard


class _GuardRunner:
    """Adapts Outlines guard objects to a common interface for validation."""

    def __init__(self, plan: GuidancePlan, guard: Any):
        self.plan = plan
        self.guard = guard
        self._partial_validator = self._discover_partial_validator()
        self._final_validator = self._discover_final_validator()

    def _discover_partial_validator(self) -> Optional[Callable[[str], Any]]:
        candidates = [
            "validate_partial",
            "is_valid_partial",
            "check_partial",
            "match_partial",
            "accepts_partial",
        ]

        for name in candidates:
            fn = getattr(self.guard, name, None)
            if callable(fn):
                return fn

        validate = getattr(self.guard, "validate", None)
        if callable(validate):
            def _wrapper(text: str, _validate=validate) -> Any:
                return _validate(text, partial=True)

            return _wrapper

        return None

    def _discover_final_validator(self) -> Optional[Callable[..., Any]]:
        candidates = [
            "validate",
            "is_valid",
            "check",
            "parse",
            "__call__",
        ]

        for name in candidates:
            fn = getattr(self.guard, name, None)
            if callable(fn):
                return fn

        return None

    def _invoke_validator(self, fn: Callable[..., Any], text: str, *, allow_partial_kw: bool = False) -> Any:
        """Call guard validator handling positional/keyword differences."""
        try:
            return fn(text)
        except TypeError:
            if allow_partial_kw:
                return fn(text, partial=True)  # type: ignore[misc]
            raise

    def validate_partial(self, text: str, model_id: str) -> None:
        """Validate partial output if guard exposes incremental validation."""
        if not self._partial_validator:
            return

        try:
            result = self._invoke_validator(self._partial_validator, text, allow_partial_kw=True)
        except Exception as exc:
            raise GuidanceError(model_id, f"Guidance partial validation failed: {exc}") from exc

        if isinstance(result, bool) and not result:
            raise GuidanceError(model_id, "Guidance rejected partial output segment")

    def validate_final(self, text: str, model_id: str) -> None:
        """Validate final output, falling back to format checks when guard lacks helpers."""
        if self._final_validator:
            try:
                result = self._invoke_validator(self._final_validator, text)
            except TypeError:
                try:
                    result = self._final_validator(text, partial=False)  # type: ignore[misc]
                except Exception as exc:
                    raise GuidanceError(model_id, f"Guidance validation failed: {exc}") from exc
            except Exception as exc:
                raise GuidanceError(model_id, f"Guidance validation failed: {exc}") from exc

            if isinstance(result, bool) and not result:
                raise GuidanceError(model_id, "Guidance rejected final output")
            return

        # Fallback: ensure output is well-formed JSON/XML when guard lacks validation helpers
        if self.plan.schema_type == "json_schema":
            try:
                if HAS_ORJSON:
                    orjson.loads(text)
                else:
                    import json  # Local import to avoid global dependency when orjson unavailable

                    json.loads(text)
            except Exception as exc:
                raise GuidanceError(model_id, f"Guided output is not valid JSON: {exc}") from exc
        elif self.plan.schema_type == "xml":
            try:
                import xml.etree.ElementTree as ET

                ET.fromstring(text)
            except Exception as exc:
                raise GuidanceError(model_id, f"Guided output is not valid XML: {exc}") from exc


def apply_guidance(generator_fn: Callable, plan: GuidancePlan, **kwargs) -> Callable:
    """
    Wrap generator function with guidance constraints

    Args:
        generator_fn: Base MLX generator function
        plan: Prepared GuidancePlan
        **kwargs: Additional generation kwargs

    Returns:
        Wrapped generator that enforces schema

    Raises:
        GuidanceError: If guidance application fails
    """
    outlines = _load_outlines()
    guard = _ensure_guard(plan, outlines)
    runner = _GuardRunner(plan, guard)
    model_id = plan.config.get("model_id", "n/a")

    def wrapped_generator(*args, **gen_kwargs):
        current_output = ""
        generation_completed = False
        # BUG-006 FIX: Implement batched validation to reduce O(n²) overhead
        # Only validate every N tokens instead of on every token
        # This reduces validation overhead from O(n²) to O(n²/N) while maintaining reasonable validation frequency
        token_count = 0
        VALIDATION_INTERVAL = 10  # Validate every 10 tokens (configurable)

        # BUG-012 FIX: Merge kwargs from apply_guidance with gen_kwargs
        # gen_kwargs takes precedence to allow call-site overrides
        merged_kwargs = {**kwargs, **gen_kwargs}

        try:
            for chunk in generator_fn(*args, **merged_kwargs):
                if not isinstance(chunk, dict):
                    raise GuidanceError(
                        model_id,
                        f"Guided generator expected dict chunks, got {type(chunk).__name__}",
                    )

                token_text = chunk.get("text", "")
                if token_text:
                    current_output += token_text
                    token_count += 1

                    # BUG-006 FIX: Only validate periodically, not on every token
                    # This significantly reduces overhead for long generations
                    if token_count % VALIDATION_INTERVAL == 0:
                        runner.validate_partial(current_output, model_id)

                yield chunk

            generation_completed = True
        except GuidanceError:
            raise
        except Exception as exc:
            raise GuidanceError(model_id, f"Guidance pipeline failed: {exc}") from exc
        finally:
            if generation_completed:
                runner.validate_final(current_output, model_id)

    return wrapped_generator


def supports_guidance(handle: Any) -> bool:
    """
    Check if model supports structured output

    Args:
        handle: ModelHandle to check

    Returns:
        True if model is compatible with Outlines guidance
    """
    # Vision models typically don't support structured text output
    if handle.metadata.get("is_vision_model", False):
        return False

    # Check if model has a tokenizer
    if handle.tokenizer is None:
        return False

    # Additional checks can be added here
    # e.g., check for specific model types that don't work well with Outlines

    return True


def validate_guidance_params(handle: Any, params: Dict[str, Any]) -> None:
    """
    Validate guidance parameters for a given model

    Args:
        handle: ModelHandle to validate against
        params: Guidance parameters

    Raises:
        GuidanceError: If parameters are incompatible
    """
    # Check model compatibility
    if not supports_guidance(handle):
        is_vision = handle.metadata.get("is_vision_model", False)
        reason = "Vision models do not support structured output" if is_vision else "Model lacks tokenizer"
        raise GuidanceError(handle.model_id, f"Model incompatible with guidance: {reason}")

    # For XML mode, recommend deterministic decoding
    mode = params.get("mode", "json_schema")
    if mode == "xml":
        temperature = params.get("temperature", 0.8)
        if temperature > 0.1:
            # This is a warning, not an error
            # Could log this or add to metadata
            pass

    # Validate schema exists
    if "schema" not in params:
        raise GuidanceError(handle.model_id, "Schema is required for guidance")
