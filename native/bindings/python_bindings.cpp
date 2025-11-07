#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include "../include/kr_command_buffer_pool.h"
#include "../include/kr_metrics_collector.h"

namespace py = pybind11;
using namespace krserve;

PYBIND11_MODULE(krserve_native, m) {
    m.doc() = "KR-Serve-MLX native acceleration module (C++/ObjC++)";

    // Version info
    m.def("get_version", []() { return "1.0.0"; });

    // CommandBufferPool
    py::class_<CommandBufferPool>(m, "CommandBufferPool")
        .def(py::init<size_t>(),
             py::arg("pool_size") = 16,
             "Create a command buffer pool\n\n"
             "Args:\n"
             "    pool_size: Maximum number of buffers to cache (default: 16)")

        .def("acquire", &CommandBufferPool::acquire,
             "Acquire a command buffer from the pool")

        .def("release", &CommandBufferPool::release,
             py::arg("buffer"),
             "Release a command buffer back to the pool")

        .def("reset", &CommandBufferPool::reset,
             "Reset the pool (clears all cached buffers)")

        .def("get_stats", &CommandBufferPool::getStats,
             "Get pool statistics");

    // CommandBufferPool::Stats
    py::class_<CommandBufferPool::Stats>(m, "CommandBufferPoolStats")
        .def_readonly("pool_size", &CommandBufferPool::Stats::pool_size)
        .def_readonly("available_buffers", &CommandBufferPool::Stats::available_buffers)
        .def_readonly("total_acquired", &CommandBufferPool::Stats::total_acquired)
        .def_readonly("total_released", &CommandBufferPool::Stats::total_released)
        .def_readonly("cache_hits", &CommandBufferPool::Stats::cache_hits)
        .def_readonly("cache_misses", &CommandBufferPool::Stats::cache_misses)
        .def("__repr__", [](const CommandBufferPool::Stats& s) {
            return "CommandBufferPoolStats(pool_size=" + std::to_string(s.pool_size) +
                   ", available=" + std::to_string(s.available_buffers) +
                   ", hits=" + std::to_string(s.cache_hits) +
                   ", misses=" + std::to_string(s.cache_misses) + ")";
        });

    // MetricsCollector
    py::class_<MetricsCollector>(m, "MetricsCollector")
        .def(py::init<>(),
             "Create a metrics collector")

        .def("record_request", &MetricsCollector::recordRequest,
             "Record the start of a request")

        .def("record_completion", &MetricsCollector::recordCompletion,
             py::arg("latency_ms"),
             "Record successful completion with latency")

        .def("record_failure", &MetricsCollector::recordFailure,
             "Record a failure")

        .def("get_metrics", &MetricsCollector::getMetrics,
             "Get current metrics snapshot")

        .def("reset", &MetricsCollector::reset,
             "Reset all counters");

    // MetricsCollector::Metrics
    py::class_<MetricsCollector::Metrics>(m, "Metrics")
        .def_readonly("total_requests", &MetricsCollector::Metrics::total_requests)
        .def_readonly("completed_requests", &MetricsCollector::Metrics::completed_requests)
        .def_readonly("failed_requests", &MetricsCollector::Metrics::failed_requests)
        .def_readonly("avg_latency_ms", &MetricsCollector::Metrics::avg_latency_ms)
        .def_readonly("p50_latency_ms", &MetricsCollector::Metrics::p50_latency_ms)
        .def_readonly("p95_latency_ms", &MetricsCollector::Metrics::p95_latency_ms)
        .def_readonly("p99_latency_ms", &MetricsCollector::Metrics::p99_latency_ms)
        .def_readonly("throughput_rps", &MetricsCollector::Metrics::throughput_rps)
        .def("__repr__", [](const MetricsCollector::Metrics& m) {
            return "Metrics(requests=" + std::to_string(m.total_requests) +
                   ", completed=" + std::to_string(m.completed_requests) +
                   ", avg_latency=" + std::to_string(m.avg_latency_ms) + "ms" +
                   ", p99=" + std::to_string(m.p99_latency_ms) + "ms)";
        });
}
