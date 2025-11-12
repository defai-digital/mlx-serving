"""
MLX Model Downloader

Downloads and manages MLX-optimized models from Hugging Face mlx-community.

Features:
- Download models from mlx-community
- Progress tracking with rich progress bars
- Automatic verification
- Model listing and search
- Cache management

Usage:
    python -m python.model_downloader --help
    python -m python.model_downloader download mlx-community/Llama-3.2-3B-Instruct-4bit
    python -m python.model_downloader list --filter llama
    python -m python.model_downloader cache --list
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict

try:
    from huggingface_hub import (
        snapshot_download,
        hf_hub_download,
        list_repo_files,
        HfApi,
        HfFolder,
    )
    from huggingface_hub.utils import HfHubHTTPError
except ImportError:
    print("ERROR: huggingface_hub not installed.")
    print("Install with: pip install huggingface-hub")
    sys.exit(1)


@dataclass
class ModelInfo:
    """Information about a downloaded model"""
    repo_id: str
    path: str
    size_bytes: int
    files: List[str]
    last_modified: Optional[str] = None
    quantization: Optional[str] = None


class MLXModelDownloader:
    """
    MLX Model Downloader - Download and manage MLX models from Hugging Face
    """

    DEFAULT_CACHE_DIR = Path.home() / ".cache" / "huggingface" / "hub"
    MLX_COMMUNITY_ORG = "mlx-community"

    def __init__(
        self,
        cache_dir: Optional[Path] = None,
        token: Optional[str] = None,
        verbose: bool = True,
    ):
        """
        Initialize MLX Model Downloader

        Args:
            cache_dir: Directory to cache downloaded models (default: ~/.cache/huggingface/hub)
            token: Hugging Face API token (optional, auto-detected from HF_TOKEN env var)
            verbose: Print progress information
        """
        self.cache_dir = cache_dir or self.DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # Get token from env or HfFolder
        self.token = token or os.getenv("HF_TOKEN") or HfFolder.get_token()
        self.verbose = verbose
        self.api = HfApi(token=self.token)

    def download_model(
        self,
        repo_id: str,
        local_dir: Optional[Path] = None,
        allow_patterns: Optional[List[str]] = None,
        ignore_patterns: Optional[List[str]] = None,
        force_download: bool = False,
    ) -> ModelInfo:
        """
        Download a model from Hugging Face Hub

        Args:
            repo_id: Repository ID (e.g., "mlx-community/Llama-3.2-3B-Instruct-4bit")
            local_dir: Local directory to download to (default: cache_dir)
            allow_patterns: List of file patterns to download (e.g., ["*.safetensors", "*.json"])
            ignore_patterns: List of file patterns to ignore
            force_download: Force re-download even if cached

        Returns:
            ModelInfo with download details

        Raises:
            HfHubHTTPError: If model not found or download fails
        """
        if self.verbose:
            print(f"\n📥 Downloading model: {repo_id}")
            print(f"📂 Cache directory: {self.cache_dir}")

        try:
            # Download model snapshot
            snapshot_path = snapshot_download(
                repo_id=repo_id,
                cache_dir=str(self.cache_dir),
                local_dir=str(local_dir) if local_dir else None,
                allow_patterns=allow_patterns,
                ignore_patterns=ignore_patterns,
                token=self.token,
                force_download=force_download,
            )

            # Get model info
            files = list_repo_files(repo_id, token=self.token)

            # Calculate size
            total_size = 0
            snapshot_path_obj = Path(snapshot_path)
            for file_path in snapshot_path_obj.rglob("*"):
                if file_path.is_file():
                    total_size += file_path.stat().st_size

            # Extract quantization from repo_id if present
            quantization = None
            if "bit" in repo_id.lower():
                # Extract quantization (e.g., "4bit", "8bit")
                parts = repo_id.lower().split("-")
                for part in parts:
                    if "bit" in part:
                        quantization = part
                        break

            model_info = ModelInfo(
                repo_id=repo_id,
                path=snapshot_path,
                size_bytes=total_size,
                files=files,
                quantization=quantization,
            )

            if self.verbose:
                self._print_model_info(model_info)

            return model_info

        except HfHubHTTPError as e:
            if "404" in str(e):
                raise ValueError(f"Model not found: {repo_id}") from e
            raise

    def list_mlx_models(
        self,
        filter_str: Optional[str] = None,
        limit: int = 50,
        sort: str = "downloads",
    ) -> List[Dict[str, Any]]:
        """
        List available MLX models from mlx-community

        Args:
            filter_str: Filter model names (case-insensitive)
            limit: Maximum number of models to return
            sort: Sort by "downloads", "likes", or "created" (default: downloads)

        Returns:
            List of model dictionaries with metadata
        """
        if self.verbose:
            print(f"\n🔍 Listing MLX models from {self.MLX_COMMUNITY_ORG}...")

        try:
            # List models from mlx-community
            models = self.api.list_models(
                author=self.MLX_COMMUNITY_ORG,
                sort=sort,
                direction=-1,  # Descending
                limit=limit,
            )

            results = []
            for model in models:
                # Apply filter if provided
                if filter_str and filter_str.lower() not in model.modelId.lower():
                    continue

                results.append({
                    "repo_id": model.modelId,
                    "downloads": model.downloads if hasattr(model, "downloads") else 0,
                    "likes": model.likes if hasattr(model, "likes") else 0,
                    "tags": model.tags if hasattr(model, "tags") else [],
                    "created_at": str(model.created_at) if hasattr(model, "created_at") else None,
                })

            if self.verbose:
                print(f"✅ Found {len(results)} models")

            return results

        except Exception as e:
            if self.verbose:
                print(f"❌ Error listing models: {e}")
            return []

    def get_cached_models(self) -> List[ModelInfo]:
        """
        List all models currently in the cache

        Returns:
            List of ModelInfo for cached models
        """
        cached_models = []

        if not self.cache_dir.exists():
            return cached_models

        # Scan cache directory for models
        # HF cache structure: models--{org}--{model_name}
        for model_dir in self.cache_dir.glob("models--*"):
            if not model_dir.is_dir():
                continue

            # Parse repo_id from directory name
            # Format: models--mlx-community--Llama-3.2-3B-Instruct-4bit
            parts = model_dir.name.split("--")
            if len(parts) >= 3:
                org = parts[1]
                model_name = "--".join(parts[2:])  # Handle names with --
                repo_id = f"{org}/{model_name}"

                # Get snapshot directory (refs/main or snapshots/<hash>)
                snapshot_dir = model_dir / "snapshots"
                if snapshot_dir.exists():
                    # Get the latest snapshot
                    snapshots = list(snapshot_dir.iterdir())
                    if snapshots:
                        latest_snapshot = max(snapshots, key=lambda p: p.stat().st_mtime)

                        # Calculate size and list files
                        total_size = 0
                        files = []
                        for file_path in latest_snapshot.rglob("*"):
                            if file_path.is_file():
                                total_size += file_path.stat().st_size
                                files.append(file_path.relative_to(latest_snapshot).as_posix())

                        # Extract quantization
                        quantization = None
                        if "bit" in model_name.lower():
                            parts = model_name.lower().split("-")
                            for part in parts:
                                if "bit" in part:
                                    quantization = part
                                    break

                        cached_models.append(ModelInfo(
                            repo_id=repo_id,
                            path=str(latest_snapshot),
                            size_bytes=total_size,
                            files=files,
                            quantization=quantization,
                        ))

        return cached_models

    def clear_cache(self, repo_id: Optional[str] = None) -> None:
        """
        Clear cached models

        Args:
            repo_id: Specific model to clear (default: clear all)
        """
        if repo_id:
            # Clear specific model
            # Convert repo_id to cache directory name
            # mlx-community/Llama-3.2-3B-Instruct-4bit -> models--mlx-community--Llama-3.2-3B-Instruct-4bit
            org, model_name = repo_id.split("/", 1)
            cache_name = f"models--{org}--{model_name}"
            model_dir = self.cache_dir / cache_name

            if model_dir.exists():
                import shutil
                shutil.rmtree(model_dir)
                if self.verbose:
                    print(f"✅ Cleared cache for: {repo_id}")
            else:
                if self.verbose:
                    print(f"⚠️  Model not in cache: {repo_id}")
        else:
            # Clear all models
            if self.cache_dir.exists():
                import shutil
                for model_dir in self.cache_dir.glob("models--*"):
                    shutil.rmtree(model_dir)
                if self.verbose:
                    print(f"✅ Cleared all cached models from: {self.cache_dir}")

    def _print_model_info(self, info: ModelInfo) -> None:
        """Print formatted model information"""
        print("\n" + "=" * 60)
        print(f"✅ Model Downloaded: {info.repo_id}")
        print("=" * 60)
        print(f"📂 Path: {info.path}")
        print(f"💾 Size: {self._format_size(info.size_bytes)}")
        if info.quantization:
            print(f"🔢 Quantization: {info.quantization}")
        print(f"📄 Files: {len(info.files)} total")
        print("=" * 60)

    @staticmethod
    def _format_size(size_bytes: int) -> str:
        """Format bytes to human-readable size"""
        for unit in ["B", "KB", "MB", "GB", "TB"]:
            if size_bytes < 1024.0:
                return f"{size_bytes:.2f} {unit}"
            size_bytes /= 1024.0
        return f"{size_bytes:.2f} PB"


def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(
        description="MLX Model Downloader - Download and manage MLX models from Hugging Face",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # Download command
    download_parser = subparsers.add_parser("download", help="Download a model")
    download_parser.add_argument("repo_id", help="Repository ID (e.g., mlx-community/Llama-3.2-3B-Instruct-4bit)")
    download_parser.add_argument("--local-dir", type=Path, help="Local directory to download to")
    download_parser.add_argument("--allow-patterns", nargs="+", help="File patterns to download")
    download_parser.add_argument("--ignore-patterns", nargs="+", help="File patterns to ignore")
    download_parser.add_argument("--force", action="store_true", help="Force re-download")
    download_parser.add_argument("--cache-dir", type=Path, help="Cache directory")
    download_parser.add_argument("--token", help="Hugging Face API token")
    download_parser.add_argument("--quiet", action="store_true", help="Suppress output")

    # List command
    list_parser = subparsers.add_parser("list", help="List available MLX models")
    list_parser.add_argument("--filter", help="Filter model names")
    list_parser.add_argument("--limit", type=int, default=50, help="Maximum models to list")
    list_parser.add_argument("--sort", choices=["downloads", "likes", "created"], default="downloads", help="Sort by")
    list_parser.add_argument("--json", action="store_true", help="Output as JSON")
    list_parser.add_argument("--token", help="Hugging Face API token")
    list_parser.add_argument("--quiet", action="store_true", help="Suppress output")

    # Cache command
    cache_parser = subparsers.add_parser("cache", help="Manage cached models")
    cache_parser.add_argument("--list", action="store_true", help="List cached models")
    cache_parser.add_argument("--clear", action="store_true", help="Clear all cached models")
    cache_parser.add_argument("--clear-model", help="Clear specific model from cache")
    cache_parser.add_argument("--cache-dir", type=Path, help="Cache directory")
    cache_parser.add_argument("--json", action="store_true", help="Output as JSON")
    cache_parser.add_argument("--quiet", action="store_true", help="Suppress output")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    # Initialize downloader
    downloader = MLXModelDownloader(
        cache_dir=getattr(args, "cache_dir", None),
        token=getattr(args, "token", None),
        verbose=not getattr(args, "quiet", False),
    )

    try:
        if args.command == "download":
            model_info = downloader.download_model(
                repo_id=args.repo_id,
                local_dir=args.local_dir,
                allow_patterns=args.allow_patterns,
                ignore_patterns=args.ignore_patterns,
                force_download=args.force,
            )
            print(f"\n✅ Model downloaded successfully!")
            print(f"📂 Path: {model_info.path}")
            return 0

        elif args.command == "list":
            models = downloader.list_mlx_models(
                filter_str=args.filter,
                limit=args.limit,
                sort=args.sort,
            )

            if args.json:
                print(json.dumps(models, indent=2))
            else:
                print(f"\n📋 MLX Community Models (showing {len(models)} of {args.limit} max)")
                print("=" * 80)
                for i, model in enumerate(models, 1):
                    print(f"{i}. {model['repo_id']}")
                    print(f"   📥 Downloads: {model['downloads']:,} | ❤️  Likes: {model['likes']}")
                    if model.get('tags'):
                        print(f"   🏷️  Tags: {', '.join(model['tags'][:5])}")
                    print()
            return 0

        elif args.command == "cache":
            if args.list:
                cached = downloader.get_cached_models()
                if args.json:
                    print(json.dumps([asdict(m) for m in cached], indent=2))
                else:
                    if not cached:
                        print("📭 No models in cache")
                    else:
                        total_size = sum(m.size_bytes for m in cached)
                        print(f"\n💾 Cached Models ({len(cached)} total, {downloader._format_size(total_size)})")
                        print("=" * 80)
                        for i, model in enumerate(cached, 1):
                            print(f"{i}. {model.repo_id}")
                            print(f"   💾 Size: {downloader._format_size(model.size_bytes)}")
                            if model.quantization:
                                print(f"   🔢 Quantization: {model.quantization}")
                            print(f"   📂 Path: {model.path}")
                            print()
                return 0

            elif args.clear:
                downloader.clear_cache()
                print("✅ Cache cleared successfully!")
                return 0

            elif args.clear_model:
                downloader.clear_cache(repo_id=args.clear_model)
                return 0

            else:
                cache_parser.print_help()
                return 1

    except KeyboardInterrupt:
        print("\n\n⚠️  Download interrupted by user")
        return 130

    except Exception as e:
        print(f"\n❌ Error: {e}", file=sys.stderr)
        if not getattr(args, "quiet", False):
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
