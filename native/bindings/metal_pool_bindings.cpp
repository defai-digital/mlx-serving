// native/bindings/metal_pool_bindings.cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include "../include/kr_metal_memory_pool.h"

namespace py = pybind11;
using namespace krserve;

/**
 * Metal Memory Pool Python Bindings
 *
 * Provides pybind11 bindings for MetalMemoryPool C++/Objective-C++ class.
 * Enables Python runtime to leverage Metal memory pooling for GPU optimization.
 *
 * Module: kr_metal_native
 * Dependencies: Metal.framework, Foundation.framework
 */

void bind_metal_memory_pool(py::module& m) {
    // MetalMemoryPool::Config
    py::class_<MetalMemoryPool::Config>(m, "MetalMemoryPoolConfig")
        .def(py::init<>(),
             "Create default Metal memory pool configuration\n\n"
             "Default values:\n"
             "    heap_size_mb: 256\n"
             "    num_heaps: 4\n"
             "    warmup_sizes: []\n"
             "    track_statistics: true\n"
             "    log_exhaustion: true")

        .def_readwrite("heap_size_mb", &MetalMemoryPool::Config::heap_size_mb,
                       "Size per heap in MB (default: 256)")

        .def_readwrite("num_heaps", &MetalMemoryPool::Config::num_heaps,
                       "Number of heaps in pool (default: 4)")

        .def_readwrite("warmup_sizes", &MetalMemoryPool::Config::warmup_sizes,
                       "Buffer sizes to pre-allocate during warmup (MB)")

        .def_readwrite("track_statistics", &MetalMemoryPool::Config::track_statistics,
                       "Enable statistics tracking (default: true)")

        .def_readwrite("log_exhaustion", &MetalMemoryPool::Config::log_exhaustion,
                       "Log warnings when pool is exhausted (default: true)")

        .def("__repr__", [](const MetalMemoryPool::Config& c) {
            return "MetalMemoryPoolConfig(heap_size_mb=" + std::to_string(c.heap_size_mb) +
                   ", num_heaps=" + std::to_string(c.num_heaps) +
                   ", warmup_sizes=" + std::to_string(c.warmup_sizes.size()) + " entries)";
        });

    // MetalMemoryPool::Statistics
    py::class_<MetalMemoryPool::Statistics>(m, "MetalMemoryPoolStatistics")
        .def_readonly("total_acquired", &MetalMemoryPool::Statistics::total_acquired,
                      "Total heaps acquired from pool")

        .def_readonly("total_released", &MetalMemoryPool::Statistics::total_released,
                      "Total heaps released back to pool")

        .def_readonly("exhaustion_events", &MetalMemoryPool::Statistics::exhaustion_events,
                      "Number of times pool was exhausted")

        .def_readonly("fallback_events", &MetalMemoryPool::Statistics::fallback_events,
                      "Number of fallback allocations (non-pooled)")

        .def_readonly("pool_size", &MetalMemoryPool::Statistics::pool_size,
                      "Total size of pool (number of heaps)")

        .def_readonly("available_count", &MetalMemoryPool::Statistics::available_count,
                      "Currently available heaps in pool")

        .def_property_readonly("utilization",
            [](const MetalMemoryPool::Statistics& s) {
                if (s.pool_size == 0) return 0.0;
                return 1.0 - (static_cast<double>(s.available_count) / s.pool_size);
            },
            "Pool utilization ratio (0.0 to 1.0)")

        .def_property_readonly("hit_rate",
            [](const MetalMemoryPool::Statistics& s) {
                if (s.total_acquired == 0) return 0.0;
                return 1.0 - (static_cast<double>(s.fallback_events) / s.total_acquired);
            },
            "Cache hit rate (1.0 = all from pool, <1.0 = some fallbacks)")

        .def("to_dict", [](const MetalMemoryPool::Statistics& s) {
            py::dict d;
            d["total_acquired"] = s.total_acquired;
            d["total_released"] = s.total_released;
            d["exhaustion_events"] = s.exhaustion_events;
            d["fallback_events"] = s.fallback_events;
            d["pool_size"] = s.pool_size;
            d["available_count"] = s.available_count;

            // Calculate derived metrics
            double utilization = 0.0;
            if (s.pool_size > 0) {
                utilization = 1.0 - (static_cast<double>(s.available_count) / s.pool_size);
            }
            d["utilization"] = utilization;

            double hit_rate = 0.0;
            if (s.total_acquired > 0) {
                hit_rate = 1.0 - (static_cast<double>(s.fallback_events) / s.total_acquired);
            }
            d["hit_rate"] = hit_rate;

            return d;
        }, "Convert statistics to Python dictionary")

        .def("__repr__", [](const MetalMemoryPool::Statistics& s) {
            return "MetalMemoryPoolStatistics(acquired=" + std::to_string(s.total_acquired) +
                   ", released=" + std::to_string(s.total_released) +
                   ", available=" + std::to_string(s.available_count) + "/" + std::to_string(s.pool_size) +
                   ", exhaustion=" + std::to_string(s.exhaustion_events) +
                   ", fallback=" + std::to_string(s.fallback_events) + ")";
        });

    // MetalMemoryPool main class
    py::class_<MetalMemoryPool>(m, "MetalMemoryPool")
        .def(py::init<const MetalMemoryPool::Config&>(),
             py::arg("config"),
             "Create a Metal memory pool with specified configuration\n\n"
             "Args:\n"
             "    config: MetalMemoryPoolConfig instance\n\n"
             "Raises:\n"
             "    RuntimeError: If Metal device is unavailable or heap creation fails\n\n"
             "Example:\n"
             "    >>> config = MetalMemoryPoolConfig()\n"
             "    >>> config.heap_size_mb = 256\n"
             "    >>> config.num_heaps = 4\n"
             "    >>> pool = MetalMemoryPool(config)\n"
             "    >>> pool.warmup()")

        .def("acquire_heap", &MetalMemoryPool::acquireHeap,
             "Acquire a heap from the pool\n\n"
             "Returns:\n"
             "    id<MTLHeap>: Metal heap object (opaque pointer)\n\n"
             "Notes:\n"
             "    - If pool is exhausted, creates temporary heap (fallback)\n"
             "    - Thread-safe operation\n"
             "    - Must be paired with release_heap() to avoid leaks\n\n"
             "Example:\n"
             "    >>> heap = pool.acquire_heap()\n"
             "    >>> # Use heap for allocations\n"
             "    >>> pool.release_heap(heap)")

        .def("release_heap", &MetalMemoryPool::releaseHeap,
             py::arg("heap"),
             "Release a heap back to the pool\n\n"
             "Args:\n"
             "    heap: Heap object previously acquired via acquire_heap()\n\n"
             "Notes:\n"
             "    - Only pooled heaps are returned to pool\n"
             "    - Fallback heaps are auto-released\n"
             "    - Thread-safe operation\n"
             "    - Safe to call with null heap (no-op)\n\n"
             "Example:\n"
             "    >>> heap = pool.acquire_heap()\n"
             "    >>> pool.release_heap(heap)")

        .def("warmup", &MetalMemoryPool::warmup,
             "Pre-warm the pool by allocating common buffer sizes\n\n"
             "Pre-allocates buffers of sizes specified in config.warmup_sizes.\n"
             "This reduces first-request latency by performing allocations upfront.\n\n"
             "Notes:\n"
             "    - Should be called once during initialization\n"
             "    - Thread-safe operation\n"
             "    - Buffers are auto-released after warmup\n\n"
             "Example:\n"
             "    >>> config = MetalMemoryPoolConfig()\n"
             "    >>> config.warmup_sizes = [32, 128, 512]  # MB\n"
             "    >>> pool = MetalMemoryPool(config)\n"
             "    >>> pool.warmup()  # Pre-allocate 32MB, 128MB, 512MB buffers")

        .def("get_statistics", &MetalMemoryPool::getStatistics,
             "Get current pool statistics\n\n"
             "Returns:\n"
             "    MetalMemoryPoolStatistics: Statistics snapshot\n\n"
             "Example:\n"
             "    >>> stats = pool.get_statistics()\n"
             "    >>> print(f'Utilization: {stats.utilization * 100:.1f}%')\n"
             "    >>> print(f'Hit rate: {stats.hit_rate * 100:.1f}%')\n"
             "    >>> print(f'Available: {stats.available_count}/{stats.pool_size}')")

        .def("reset_statistics", &MetalMemoryPool::resetStatistics,
             "Reset all statistics counters to zero\n\n"
             "Resets acquired/released/exhaustion/fallback counters.\n"
             "Pool size and available count are NOT reset.\n\n"
             "Example:\n"
             "    >>> pool.reset_statistics()\n"
             "    >>> stats = pool.get_statistics()\n"
             "    >>> assert stats.total_acquired == 0")

        .def("__repr__", [](const MetalMemoryPool& pool) {
            auto stats = pool.getStatistics();
            return "MetalMemoryPool(size=" + std::to_string(stats.pool_size) +
                   ", available=" + std::to_string(stats.available_count) + ")";
        });
}

// Module definition
// NOTE: This should be integrated into existing kr_metal_native module
// If creating standalone module, use:
//
// PYBIND11_MODULE(kr_metal_native, m) {
//     m.doc() = "mlx-serving Metal optimizations native module\n\n"
//               "Provides Metal-layer performance optimizations:\n"
//               "  - MetalMemoryPool: Pre-allocated heap pooling for efficient GPU memory\n"
//               "  - Thread-safe operations with automatic fallback\n"
//               "  - Comprehensive statistics tracking\n\n"
//               "Version: 0.9.0\n"
//               "Platform: macOS (Apple Silicon only)";
//
//     // Version info
//     m.attr("__version__") = "0.9.0";
//     m.def("get_version", []() { return "0.9.0"; });
//
//     // Bind Metal Memory Pool
//     bind_metal_memory_pool(m);
// }
