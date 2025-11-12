// native/bindings/blit_queue_bindings.cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/functional.h>
#include "../include/kr_blit_queue.h"

namespace py = pybind11;

/**
 * Python Bindings for BlitQueue
 *
 * Provides pybind11 bindings for asynchronous GPU data transfer.
 * Enables Python runtime to leverage I/O overlap for reduced TTFT.
 *
 * Module: krserve_native
 * Dependencies: Metal.framework, Foundation.framework
 */
void bind_blit_queue(py::module& m) {
    // BlitQueue::Config
    py::class_<krserve::BlitQueue::Config>(m, "BlitQueueConfig")
        .def(py::init<>(),
             "Create default blit queue configuration\n\n"
             "Default values:\n"
             "    enabled: true\n"
             "    max_pending_ops: 8\n"
             "    use_shared_events: true\n"
             "    track_metrics: true")

        .def_readwrite("enabled",
                       &krserve::BlitQueue::Config::enabled,
                       "Enable blit queue (default: true)")

        .def_readwrite("max_pending_ops",
                       &krserve::BlitQueue::Config::max_pending_ops,
                       "Maximum concurrent blit operations (default: 8)")

        .def_readwrite("use_shared_events",
                       &krserve::BlitQueue::Config::use_shared_events,
                       "Use MTLSharedEvent for synchronization (default: true)")

        .def_readwrite("track_metrics",
                       &krserve::BlitQueue::Config::track_metrics,
                       "Track performance metrics (default: true)")

        .def("__repr__", [](const krserve::BlitQueue::Config& c) {
            return "BlitQueueConfig(enabled=" + std::string(c.enabled ? "true" : "false") +
                   ", max_pending=" + std::to_string(c.max_pending_ops) +
                   ", shared_events=" + std::string(c.use_shared_events ? "true" : "false") + ")";
        });

    // BlitQueue::Metrics
    py::class_<krserve::BlitQueue::Metrics>(m, "BlitQueueMetrics")
        .def_readonly("total_uploads", &krserve::BlitQueue::Metrics::total_uploads,
                      "Total upload operations completed")

        .def_readonly("total_downloads", &krserve::BlitQueue::Metrics::total_downloads,
                      "Total download operations completed")

        .def_readonly("avg_upload_ms", &krserve::BlitQueue::Metrics::avg_upload_ms,
                      "Average upload duration in milliseconds")

        .def_readonly("avg_download_ms", &krserve::BlitQueue::Metrics::avg_download_ms,
                      "Average download duration in milliseconds")

        .def_readonly("total_overlap_ms", &krserve::BlitQueue::Metrics::total_overlap_ms,
                      "Total time saved via overlap")

        .def_readonly("overlap_ratio", &krserve::BlitQueue::Metrics::overlap_ratio,
                      "Overlap efficiency ratio (0.0-1.0)")

        .def_readonly("sync_wait_count", &krserve::BlitQueue::Metrics::sync_wait_count,
                      "Number of synchronization waits")

        .def_readonly("avg_sync_wait_ms", &krserve::BlitQueue::Metrics::avg_sync_wait_ms,
                      "Average synchronization wait duration in milliseconds")

        .def_property_readonly("total_operations",
            [](const krserve::BlitQueue::Metrics& m) {
                return m.total_uploads + m.total_downloads;
            },
            "Total operations (uploads + downloads)")

        .def_property_readonly("avg_io_ms",
            [](const krserve::BlitQueue::Metrics& m) {
                uint64_t total_ops = m.total_uploads + m.total_downloads;
                if (total_ops == 0) return 0.0;
                double total_ms = (m.avg_upload_ms * m.total_uploads) +
                                (m.avg_download_ms * m.total_downloads);
                return total_ms / total_ops;
            },
            "Average I/O duration in milliseconds")

        .def("to_dict", [](const krserve::BlitQueue::Metrics& m) {
            py::dict d;
            d["total_uploads"] = m.total_uploads;
            d["total_downloads"] = m.total_downloads;
            d["avg_upload_ms"] = m.avg_upload_ms;
            d["avg_download_ms"] = m.avg_download_ms;
            d["total_overlap_ms"] = m.total_overlap_ms;
            d["overlap_ratio"] = m.overlap_ratio;
            d["sync_wait_count"] = m.sync_wait_count;
            d["avg_sync_wait_ms"] = m.avg_sync_wait_ms;

            // Derived metrics
            d["total_operations"] = m.total_uploads + m.total_downloads;
            uint64_t total_ops = m.total_uploads + m.total_downloads;
            if (total_ops > 0) {
                double total_ms = (m.avg_upload_ms * m.total_uploads) +
                                (m.avg_download_ms * m.total_downloads);
                d["avg_io_ms"] = total_ms / total_ops;
            } else {
                d["avg_io_ms"] = 0.0;
            }

            return d;
        }, "Convert metrics to Python dictionary")

        .def("__repr__", [](const krserve::BlitQueue::Metrics& m) {
            return "BlitQueueMetrics(uploads=" + std::to_string(m.total_uploads) +
                   ", downloads=" + std::to_string(m.total_downloads) +
                   ", overlap=" + std::to_string(static_cast<int>(m.overlap_ratio * 100)) + "%)";
        });

    // BlitQueue main class
    py::class_<krserve::BlitQueue>(m, "BlitQueue")
        .def(py::init<const krserve::BlitQueue::Config&>(),
             py::arg("config"),
             "Create a Metal blit queue for async GPU data transfer\n\n"
             "Args:\n"
             "    config: BlitQueueConfig instance\n\n"
             "Raises:\n"
             "    RuntimeError: If Metal device is unavailable or queue creation fails\n\n"
             "Example:\n"
             "    >>> config = BlitQueueConfig()\n"
             "    >>> config.max_pending_ops = 8\n"
             "    >>> config.use_shared_events = True\n"
             "    >>> queue = BlitQueue(config)\n"
             "    >>> op_id = queue.upload_async(data_ptr, size, gpu_buffer)")

        .def("upload_async",
             [](krserve::BlitQueue& self,
                uintptr_t source_data,
                size_t source_size,
                uintptr_t dest_buffer,
                size_t dest_offset) {
                 return self.uploadAsync(
                     reinterpret_cast<const void*>(source_data),
                     source_size,
                     reinterpret_cast<void*>(dest_buffer),
                     dest_offset,
                     nullptr  // No completion handler from Python
                 );
             },
             py::arg("source_data"),
             py::arg("source_size"),
             py::arg("dest_buffer"),
             py::arg("dest_offset") = 0,
             "Upload data to GPU asynchronously\n\n"
             "Args:\n"
             "    source_data: Pointer to CPU data (as int/uintptr_t)\n"
             "    source_size: Size of data in bytes\n"
             "    dest_buffer: GPU buffer pointer (id<MTLBuffer> as int/uintptr_t)\n"
             "    dest_offset: Offset in destination buffer (default: 0)\n\n"
             "Returns:\n"
             "    uint64_t: Operation ID for tracking completion\n\n"
             "Notes:\n"
             "    - Non-blocking operation\n"
             "    - Use wait_for_completion() to ensure transfer finished\n"
             "    - Thread-safe operation\n\n"
             "Example:\n"
             "    >>> op_id = queue.upload_async(data_ptr, 1024, gpu_buffer)\n"
             "    >>> queue.wait_for_completion(op_id)")

        .def("download_async",
             [](krserve::BlitQueue& self,
                uintptr_t source_buffer,
                size_t source_offset,
                uintptr_t dest_data,
                size_t dest_size) {
                 return self.downloadAsync(
                     reinterpret_cast<void*>(source_buffer),
                     source_offset,
                     reinterpret_cast<void*>(dest_data),
                     dest_size,
                     nullptr  // No completion handler from Python
                 );
             },
             py::arg("source_buffer"),
             py::arg("source_offset"),
             py::arg("dest_data"),
             py::arg("dest_size"),
             "Download data from GPU asynchronously\n\n"
             "Args:\n"
             "    source_buffer: GPU buffer pointer (id<MTLBuffer> as int/uintptr_t)\n"
             "    source_offset: Offset in source buffer\n"
             "    dest_data: CPU buffer pointer (as int/uintptr_t, must be pre-allocated)\n"
             "    dest_size: Size of data in bytes\n\n"
             "Returns:\n"
             "    uint64_t: Operation ID for tracking completion\n\n"
             "Notes:\n"
             "    - Non-blocking operation\n"
             "    - Use wait_for_completion() to ensure transfer finished\n"
             "    - Thread-safe operation\n\n"
             "Example:\n"
             "    >>> op_id = queue.download_async(gpu_buffer, 0, cpu_buffer, 1024)\n"
             "    >>> queue.wait_for_completion(op_id)")

        .def("wait_for_completion",
             &krserve::BlitQueue::waitForCompletion,
             py::arg("operation_id"),
             py::arg("timeout_ms") = 0,
             "Wait for a specific blit operation to complete\n\n"
             "Args:\n"
             "    operation_id: Operation ID returned from upload_async/download_async\n"
             "    timeout_ms: Maximum time to wait in milliseconds (0 = wait forever)\n\n"
             "Returns:\n"
             "    bool: True if operation completed, False on timeout\n\n"
             "Notes:\n"
             "    - Blocks until operation finishes or timeout\n"
             "    - Uses MTLSharedEvent for efficient synchronization (no busy-wait)\n"
             "    - Thread-safe operation\n\n"
             "Example:\n"
             "    >>> op_id = queue.upload_async(data_ptr, size, gpu_buffer)\n"
             "    >>> success = queue.wait_for_completion(op_id, timeout_ms=5000)\n"
             "    >>> if not success:\n"
             "    ...     print('Operation timed out!')")

        .def("wait_for_all",
             &krserve::BlitQueue::waitForAll,
             "Wait for all pending blit operations to complete\n\n"
             "Blocks until all in-flight operations complete.\n"
             "Useful for cleanup or synchronization points.\n\n"
             "Example:\n"
             "    >>> queue.upload_async(data1, size1, buffer1)\n"
             "    >>> queue.upload_async(data2, size2, buffer2)\n"
             "    >>> queue.wait_for_all()  # Wait for both")

        .def("is_completed",
             &krserve::BlitQueue::isCompleted,
             py::arg("operation_id"),
             "Check if a blit operation has completed (non-blocking)\n\n"
             "Args:\n"
             "    operation_id: Operation ID to check\n\n"
             "Returns:\n"
             "    bool: True if completed, False if still pending\n\n"
             "Example:\n"
             "    >>> op_id = queue.upload_async(data, size, buffer)\n"
             "    >>> while not queue.is_completed(op_id):\n"
             "    ...     # Do other work\n"
             "    ...     pass")

        .def("get_metrics",
             &krserve::BlitQueue::getMetrics,
             "Get current blit queue performance metrics\n\n"
             "Returns:\n"
             "    BlitQueueMetrics: Metrics snapshot\n\n"
             "Example:\n"
             "    >>> metrics = queue.get_metrics()\n"
             "    >>> print(f'Uploads: {metrics.total_uploads}')\n"
             "    >>> print(f'Avg upload: {metrics.avg_upload_ms:.2f}ms')\n"
             "    >>> print(f'Overlap: {metrics.overlap_ratio * 100:.1f}%')")

        .def("reset_metrics",
             &krserve::BlitQueue::resetMetrics,
             "Reset all performance metrics to zero\n\n"
             "Resets upload/download counters and timing metrics.\n\n"
             "Example:\n"
             "    >>> queue.reset_metrics()\n"
             "    >>> metrics = queue.get_metrics()\n"
             "    >>> assert metrics.total_uploads == 0")

        .def("flush",
             &krserve::BlitQueue::flush,
             "Flush all pending blit commands (non-blocking)\n\n"
             "Ensures all commands are submitted to GPU.\n"
             "Does not wait for completion.\n\n"
             "Example:\n"
             "    >>> queue.upload_async(data, size, buffer)\n"
             "    >>> queue.flush()  # Ensure submitted to GPU")

        .def("__repr__", [](const krserve::BlitQueue& queue) {
            auto metrics = queue.getMetrics();
            return "BlitQueue(uploads=" + std::to_string(metrics.total_uploads) +
                   ", downloads=" + std::to_string(metrics.total_downloads) +
                   ", overlap=" + std::to_string(static_cast<int>(metrics.overlap_ratio * 100)) + "%)";
        });
}
