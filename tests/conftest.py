"""
Pytest configuration for mlx-serving tests

Sets up Python path to allow imports from python/ directory
"""
import sys
from pathlib import Path

# Add python directory to path for imports
python_dir = Path(__file__).parent.parent / 'python'
sys.path.insert(0, str(python_dir))
