"""
Pytest configuration for Outlines integration tests

Provides shared fixtures, markers, and test utilities.
"""

import pytest
import sys
from pathlib import Path

# Add python directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))


def pytest_configure(config):
    """Register custom markers"""
    config.addinivalue_line(
        "markers", "outlines_required: mark test as requiring Outlines library"
    )
    config.addinivalue_line(
        "markers", "slow: mark test as slow running"
    )


@pytest.fixture(scope="session")
def fixtures_dir():
    """Path to test fixtures directory"""
    return Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def reset_config():
    """Reset global config before each test"""
    from config_loader import _global_config
    import config_loader

    # Reset global config to avoid cross-test contamination
    config_loader._global_config = None

    yield

    # Clean up after test
    config_loader._global_config = None


@pytest.fixture
def temp_config(tmp_path):
    """
    Create a temporary config file for testing

    Returns:
        Path to temporary config file
    """
    config_content = """
python_runtime:
  max_restarts: 3
  startup_timeout_ms: 30000
  shutdown_timeout_ms: 5000

python_bridge:
  max_buffer_size: 1048576
  stream_queue_size: 100
  queue_put_max_retries: 100
  queue_put_backoff_ms: 10

json_rpc:
  default_timeout_ms: 30000
  max_line_buffer_size: 65536
  max_pending_requests: 100

model:
  default_context_length: 8192
  default_max_tokens: 512
  supported_dtypes: ["float16", "bfloat16", "float32"]
  default_dtype: "float16"
  max_generation_tokens: 4096
  max_temperature: 2.0

outlines:
  max_schema_size_bytes: 32768

performance:
  aggressive_gc: false

development:
  verbose: false
  debug: false
"""

    config_file = tmp_path / "runtime.yaml"
    config_file.write_text(config_content)

    return config_file
