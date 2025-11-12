"""
Prometheus Metrics Exporter for mlx-serving GPU Scheduler.

Provides HTTP endpoints for metrics export, health checks, and debugging.
Integrates with MetricsCollector for comprehensive observability.

Part of mlx-serving v1.4.1 upgrade.
"""

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


class MetricsHandler(BaseHTTPRequestHandler):
    """HTTP request handler for metrics endpoints."""

    # Class-level reference to MetricsCollector (set by PrometheusExporter)
    metrics_collector = None
    start_time = time.time()

    def log_message(self, format: str, *args) -> None:
        """Override to use Python logger instead of stderr."""
        logger.debug(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        """Handle GET requests to various endpoints."""
        parsed_path = urlparse(self.path)
        path = parsed_path.path

        if path == "/metrics":
            self._handle_metrics()
        elif path == "/health":
            self._handle_health()
        elif path == "/ready":
            self._handle_ready()
        elif path == "/stats":
            self._handle_stats()
        else:
            self._send_response(404, "text/plain", "Not Found")

    def _handle_metrics(self) -> None:
        """Handle /metrics endpoint (Prometheus text format)."""
        try:
            if self.metrics_collector is None:
                self._send_response(
                    503, "text/plain", "# Metrics collector not initialized\n"
                )
                return

            prometheus_text = self.metrics_collector.export_prometheus()
            self._send_response(200, "text/plain; version=0.0.4", prometheus_text)

        except Exception as e:
            logger.error(f"Error exporting Prometheus metrics: {e}")
            self._send_response(500, "text/plain", f"# Error: {str(e)}\n")

    def _handle_health(self) -> None:
        """Handle /health endpoint (liveness probe)."""
        # Simple liveness check - server is responding
        health_data = {
            "status": "healthy",
            "timestamp": time.time(),
            "uptime_seconds": time.time() - self.start_time,
        }
        self._send_json_response(200, health_data)

    def _handle_ready(self) -> None:
        """Handle /ready endpoint (readiness probe)."""
        try:
            # Check if metrics collector is initialized and working
            if self.metrics_collector is None:
                ready_data = {
                    "status": "not_ready",
                    "reason": "metrics_collector_not_initialized",
                    "timestamp": time.time(),
                }
                self._send_json_response(503, ready_data)
                return

            # Try to get metrics to verify collector is working
            _ = self.metrics_collector.get_metrics()

            ready_data = {
                "status": "ready",
                "timestamp": time.time(),
                "uptime_seconds": time.time() - self.start_time,
            }
            self._send_json_response(200, ready_data)

        except Exception as e:
            logger.error(f"Readiness check failed: {e}")
            ready_data = {
                "status": "not_ready",
                "reason": str(e),
                "timestamp": time.time(),
            }
            self._send_json_response(503, ready_data)

    def _handle_stats(self) -> None:
        """Handle /stats endpoint (JSON metrics dump for debugging)."""
        try:
            if self.metrics_collector is None:
                stats_data = {
                    "error": "metrics_collector_not_initialized",
                    "timestamp": time.time(),
                }
                self._send_json_response(503, stats_data)
                return

            # Export full metrics as JSON
            stats_data = self.metrics_collector.export_json()
            self._send_json_response(200, stats_data)

        except Exception as e:
            logger.error(f"Error exporting stats: {e}")
            error_data = {"error": str(e), "timestamp": time.time()}
            self._send_json_response(500, error_data)

    def _send_response(
        self, status_code: int, content_type: str, content: str
    ) -> None:
        """Send HTTP response with given status and content."""
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _send_json_response(self, status_code: int, data: dict) -> None:
        """Send JSON response."""
        json_str = json.dumps(data, indent=2)
        self._send_response(status_code, "application/json", json_str)


class PrometheusExporter:
    """
    HTTP server for Prometheus metrics export.

    Runs in a background thread and provides endpoints for:
    - /metrics - Prometheus text format metrics
    - /health - Liveness probe
    - /ready - Readiness probe
    - /stats - JSON metrics dump for debugging

    The server is designed to be lightweight and non-blocking.
    """

    def __init__(
        self, metrics_collector, host: str = "127.0.0.1", port: Optional[int] = None
    ):
        """
        Initialize Prometheus exporter.

        Args:
            metrics_collector: MetricsCollector instance to export data from
            host: Host to bind to (default: 127.0.0.1 for security)
            port: Port to bind to (default: from MLX_METRICS_PORT env or 9090)
        """
        self.metrics_collector = metrics_collector
        self.host = host
        self.port = port or int(os.getenv("MLX_METRICS_PORT", "9090"))
        self.enabled = os.getenv("MLX_METRICS_EXPORT", "off").lower() == "on"

        self.server: Optional[HTTPServer] = None
        self.server_thread: Optional[threading.Thread] = None
        self._shutdown_event = threading.Event()

        if self.enabled:
            logger.info(
                f"PrometheusExporter initialized: enabled={self.enabled}, "
                f"endpoint=http://{self.host}:{self.port}/metrics"
            )
        else:
            logger.info("PrometheusExporter initialized: disabled (MLX_METRICS_EXPORT=off)")

    def start(self) -> None:
        """Start the HTTP server in a background thread."""
        if not self.enabled:
            logger.info("PrometheusExporter not starting (disabled)")
            return

        if self.server is not None:
            logger.warning("PrometheusExporter already started")
            return

        try:
            # Set metrics collector reference on handler class
            MetricsHandler.metrics_collector = self.metrics_collector
            MetricsHandler.start_time = time.time()

            # Create HTTP server
            self.server = HTTPServer((self.host, self.port), MetricsHandler)

            # Start server thread
            self.server_thread = threading.Thread(
                target=self._run_server, daemon=True, name="PrometheusExporter"
            )
            self.server_thread.start()

            logger.info(
                f"PrometheusExporter started on http://{self.host}:{self.port}"
            )
            logger.info(f"  - Metrics: http://{self.host}:{self.port}/metrics")
            logger.info(f"  - Health:  http://{self.host}:{self.port}/health")
            logger.info(f"  - Ready:   http://{self.host}:{self.port}/ready")
            logger.info(f"  - Stats:   http://{self.host}:{self.port}/stats")

        except Exception as e:
            logger.error(f"Failed to start PrometheusExporter: {e}")
            self.server = None
            self.server_thread = None
            raise

    def _run_server(self) -> None:
        """Run HTTP server loop (runs in background thread)."""
        try:
            # Bug fix: Use timeout in handle_request to allow checking shutdown_event
            # Without timeout, thread blocks indefinitely in handle_request()
            self.server.timeout = 1.0  # Check shutdown every 1 second

            while not self._shutdown_event.is_set():
                self.server.handle_request()
        except Exception as e:
            if not self._shutdown_event.is_set():
                logger.error(f"PrometheusExporter server error: {e}")

    def stop(self) -> None:
        """Stop the HTTP server gracefully."""
        if not self.enabled:
            return

        if self.server is None:
            logger.debug("PrometheusExporter not running")
            return

        logger.info("Stopping PrometheusExporter...")
        self._shutdown_event.set()

        # Shutdown server
        if self.server is not None:
            self.server.shutdown()
            self.server = None

        # Wait for thread to finish (with timeout)
        if self.server_thread is not None:
            self.server_thread.join(timeout=5.0)
            if self.server_thread.is_alive():
                logger.warning("PrometheusExporter thread did not terminate cleanly")
            self.server_thread = None

        logger.info("PrometheusExporter stopped")

    def is_running(self) -> bool:
        """Check if exporter is running."""
        return self.enabled and self.server is not None

    def get_endpoint_url(self) -> Optional[str]:
        """Get the metrics endpoint URL."""
        if not self.is_running():
            return None
        return f"http://{self.host}:{self.port}/metrics"
