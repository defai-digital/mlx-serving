// native/bindings/command_ring_bindings.cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include "../include/kr_command_buffer_ring.h"

namespace py = pybind11;
using namespace krserve;

/**
 * Python Bindings for CommandBufferRing
 *
 * Provides pybind11 bindings for command buffer ring management.
 * Enables Python runtime to leverage instruction interleaving for better GPU utilization.
 *
 * Module: krserve_native
 * Dependencies: Metal.framework, Foundation.framework
 */
void bind_command_buffer_ring(py::module& m) {
    // CommandBufferRing::Config
    py::class_<CommandBufferRing::Config>(m, "CommandBufferRingConfig")
        .def(py::init<>(),
             "Create default command buffer ring configuration\n\n"
             "Default values:\n"
             "    ring_size: 2 (double buffering)\n"
             "    timeout_ms: 0 (infinite wait)\n"
             "    track_statistics: true\n"
             "    log_wait_events: false")

        .def_readwrite("ring_size",
                       &CommandBufferRing::Config::ring_size,
                       "Number of buffers in ring (2-3 recommended, default: 2)\n"
                       "  - 2 buffers: Double buffering (CPU/GPU overlap)\n"
                       "  - 3 buffers: Triple buffering (higher latency tolerance)")

        .def_readwrite("timeout_ms",
                       &CommandBufferRing::Config::timeout_ms,
                       "Maximum time to wait for buffer availability in ms (default: 0 = infinite)")

        .def_readwrite("track_statistics",
                       &CommandBufferRing::Config::track_statistics,
                       "Enable detailed statistics tracking (default: true)")

        .def_readwrite("log_wait_events",
                       &CommandBufferRing::Config::log_wait_events,
                       "Log warnings when waiting for buffers (default: false)")

        .def("__repr__", [](const CommandBufferRing::Config& c) {
            return "CommandBufferRingConfig(ring_size=" +
                   std::to_string(c.ring_size) +
                   ", timeout_ms=" + std::to_string(c.timeout_ms) + ")";
        });

    // CommandBufferRing::Statistics
    py::class_<CommandBufferRing::Statistics>(m, "CommandBufferRingStatistics")
        .def_readonly("ring_size", &CommandBufferRing::Statistics::ring_size,
                      "Number of buffers in ring")

        .def_readonly("available_count", &CommandBufferRing::Statistics::available_count,
                      "Currently available buffers")

        .def_readonly("in_flight_count", &CommandBufferRing::Statistics::in_flight_count,
                      "Buffers currently in use")

        .def_readonly("total_acquired", &CommandBufferRing::Statistics::total_acquired,
                      "Total buffers acquired from ring")

        .def_readonly("total_released", &CommandBufferRing::Statistics::total_released,
                      "Total buffers released to ring")

        .def_readonly("wait_events", &CommandBufferRing::Statistics::wait_events,
                      "Times we had to wait for buffer availability")

        .def_readonly("timeout_events", &CommandBufferRing::Statistics::timeout_events,
                      "Times we hit timeout waiting for buffer")

        .def_readonly("avg_wait_time_us", &CommandBufferRing::Statistics::avg_wait_time_us,
                      "Average wait time in microseconds")

        .def_readonly("max_wait_time_us", &CommandBufferRing::Statistics::max_wait_time_us,
                      "Maximum wait time in microseconds")

        .def_readonly("buffer_utilization", &CommandBufferRing::Statistics::buffer_utilization,
                      "Percentage of time buffers are in use (0.0 to 1.0)")

        .def_readonly("submission_overhead_us", &CommandBufferRing::Statistics::submission_overhead_us,
                      "Average submission overhead in microseconds")

        .def_readonly("rotations", &CommandBufferRing::Statistics::rotations,
                      "Number of ring rotations")

        .def_readonly("rotation_rate", &CommandBufferRing::Statistics::rotation_rate,
                      "Rotations per second")

        .def_property_readonly("utilization_percent",
            [](const CommandBufferRing::Statistics& s) {
                return s.buffer_utilization * 100.0;
            },
            "Buffer utilization as percentage (0-100%)")

        .def_property_readonly("avg_wait_time_ms",
            [](const CommandBufferRing::Statistics& s) {
                return s.avg_wait_time_us / 1000.0;
            },
            "Average wait time in milliseconds")

        .def_property_readonly("max_wait_time_ms",
            [](const CommandBufferRing::Statistics& s) {
                return s.max_wait_time_us / 1000.0;
            },
            "Maximum wait time in milliseconds")

        .def_property_readonly("wait_rate",
            [](const CommandBufferRing::Statistics& s) {
                if (s.total_acquired == 0) return 0.0;
                return static_cast<double>(s.wait_events) / s.total_acquired;
            },
            "Wait event rate (0.0 to 1.0, lower is better)")

        .def("to_dict", [](const CommandBufferRing::Statistics& s) {
            py::dict d;
            d["ring_size"] = s.ring_size;
            d["available_count"] = s.available_count;
            d["in_flight_count"] = s.in_flight_count;
            d["total_acquired"] = s.total_acquired;
            d["total_released"] = s.total_released;
            d["wait_events"] = s.wait_events;
            d["timeout_events"] = s.timeout_events;
            d["avg_wait_time_us"] = s.avg_wait_time_us;
            d["max_wait_time_us"] = s.max_wait_time_us;
            d["buffer_utilization"] = s.buffer_utilization;
            d["submission_overhead_us"] = s.submission_overhead_us;
            d["rotations"] = s.rotations;
            d["rotation_rate"] = s.rotation_rate;

            // Calculate derived metrics
            d["utilization_percent"] = s.buffer_utilization * 100.0;
            d["avg_wait_time_ms"] = s.avg_wait_time_us / 1000.0;
            d["max_wait_time_ms"] = s.max_wait_time_us / 1000.0;

            double wait_rate = 0.0;
            if (s.total_acquired > 0) {
                wait_rate = static_cast<double>(s.wait_events) / s.total_acquired;
            }
            d["wait_rate"] = wait_rate;

            return d;
        }, "Convert statistics to Python dictionary")

        .def("__repr__", [](const CommandBufferRing::Statistics& s) {
            return "CommandBufferRingStatistics(acquired=" + std::to_string(s.total_acquired) +
                   ", in_flight=" + std::to_string(s.in_flight_count) +
                   ", available=" + std::to_string(s.available_count) +
                   ", waits=" + std::to_string(s.wait_events) +
                   ", utilization=" + std::to_string(s.buffer_utilization * 100.0) + "%)";
        });

    // CommandBufferRing main class
    py::class_<CommandBufferRing>(m, "CommandBufferRing")
        .def(py::init<const CommandBufferRing::Config&>(),
             py::arg("config") = CommandBufferRing::Config{},
             "Create a Metal command buffer ring for instruction interleaving\n\n"
             "Args:\n"
             "    config: CommandBufferRingConfig instance (optional)\n\n"
             "Raises:\n"
             "    RuntimeError: If Metal device is unavailable or ring creation fails\n"
             "    ValueError: If config is invalid (e.g., ring_size < 2)\n\n"
             "Example:\n"
             "    >>> config = CommandBufferRingConfig()\n"
             "    >>> config.ring_size = 2  # Double buffering\n"
             "    >>> config.timeout_ms = 5000  # 5 second timeout\n"
             "    >>> ring = CommandBufferRing(config)\n"
             "    >>> buffer = ring.acquire_buffer()")

        .def("acquire_buffer", &CommandBufferRing::acquireBuffer,
             "Acquire next available buffer from ring\n\n"
             "Returns:\n"
             "    void*: Command buffer (id<MTLCommandBuffer>)\n\n"
             "Raises:\n"
             "    RuntimeError: If timeout occurs or allocation fails\n\n"
             "Notes:\n"
             "    - Returns immediately if buffer available\n"
             "    - Waits for buffer completion if all buffers in-flight\n"
             "    - Respects timeout_ms configuration\n"
             "    - Thread-safe with mutex protection\n"
             "    - Must be paired with release_buffer() to avoid leaks\n\n"
             "Example:\n"
             "    >>> buffer = ring.acquire_buffer()\n"
             "    >>> # Use buffer for Metal commands\n"
             "    >>> # ... encode commands ...\n"
             "    >>> # Commit and release\n"
             "    >>> ring.release_buffer(buffer)")

        .def("release_buffer", &CommandBufferRing::releaseBuffer,
             py::arg("buffer"),
             "Release buffer back to ring\n\n"
             "Args:\n"
             "    buffer: Buffer object previously acquired via acquire_buffer()\n\n"
             "Notes:\n"
             "    - Marks buffer as in-flight\n"
             "    - Schedules completion handler\n"
             "    - Buffer becomes available again after GPU completes execution\n"
             "    - Thread-safe operation\n\n"
             "Example:\n"
             "    >>> buffer = ring.acquire_buffer()\n"
             "    >>> # Encode commands...\n"
             "    >>> # Commit buffer to GPU\n"
             "    >>> ring.release_buffer(buffer)")

        .def("wait_all", &CommandBufferRing::waitAll,
             "Wait for all in-flight buffers to complete\n\n"
             "Blocks until all submitted buffers finish GPU execution.\n"
             "Useful for shutdown or synchronization points.\n\n"
             "Notes:\n"
             "    - Thread-safe operation\n"
             "    - Returns immediately if no buffers in-flight\n\n"
             "Example:\n"
             "    >>> buffer1 = ring.acquire_buffer()\n"
             "    >>> buffer2 = ring.acquire_buffer()\n"
             "    >>> # Submit commands...\n"
             "    >>> ring.release_buffer(buffer1)\n"
             "    >>> ring.release_buffer(buffer2)\n"
             "    >>> ring.wait_all()  # Wait for both to complete")

        .def("get_statistics", &CommandBufferRing::getStatistics,
             "Get current ring buffer statistics\n\n"
             "Returns:\n"
             "    CommandBufferRingStatistics: Statistics snapshot\n\n"
             "Thread-safe: Can be called from any thread\n\n"
             "Example:\n"
             "    >>> stats = ring.get_statistics()\n"
             "    >>> print(f'In flight: {stats.in_flight_count}/{stats.ring_size}')\n"
             "    >>> print(f'Utilization: {stats.utilization_percent:.1f}%')\n"
             "    >>> print(f'Wait events: {stats.wait_events}')\n"
             "    >>> print(f'Avg wait: {stats.avg_wait_time_ms:.2f}ms')\n"
             "    >>> print(f'Rotations/sec: {stats.rotation_rate:.1f}')")

        .def("reset_statistics", &CommandBufferRing::resetStatistics,
             "Reset all statistics counters to zero\n\n"
             "Resets acquired/released/wait counters and timing metrics.\n"
             "Does not affect buffer state or availability.\n\n"
             "Example:\n"
             "    >>> ring.reset_statistics()\n"
             "    >>> stats = ring.get_statistics()\n"
             "    >>> assert stats.total_acquired == 0")

        .def("__repr__", [](const CommandBufferRing& ring) {
            auto stats = ring.getStatistics();
            return "CommandBufferRing(size=" + std::to_string(stats.ring_size) +
                   ", available=" + std::to_string(stats.available_count) +
                   ", in_flight=" + std::to_string(stats.in_flight_count) + ")";
        });
}

// Module definition
// NOTE: This should be integrated into existing krserve_native module
// The bind_command_buffer_ring() function will be called from python_bindings.cpp
