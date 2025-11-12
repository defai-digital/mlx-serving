// native/bindings/command_buffer_ring_bindings.cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include "../include/kr_command_buffer_ring.h"

namespace py = pybind11;
using namespace krserve;

/**
 * Command Buffer Ring Python Bindings
 *
 * Provides pybind11 bindings for CommandBufferRing C++/Objective-C++ class.
 * Enables Python runtime to leverage command buffer ring buffering for GPU optimization.
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

        .def_readwrite("ring_size", &CommandBufferRing::Config::ring_size,
                       "Number of buffers in ring (2-3, default: 2)")

        .def_readwrite("timeout_ms", &CommandBufferRing::Config::timeout_ms,
                       "Timeout for buffer acquisition in ms (0=infinite, default: 0)")

        .def_readwrite("track_statistics", &CommandBufferRing::Config::track_statistics,
                       "Enable statistics tracking (default: true)")

        .def_readwrite("log_wait_events", &CommandBufferRing::Config::log_wait_events,
                       "Log warnings when waiting for buffers (default: false)")

        .def("__repr__", [](const CommandBufferRing::Config& c) {
            return "CommandBufferRingConfig(ring_size=" + std::to_string(c.ring_size) +
                   ", timeout_ms=" + std::to_string(c.timeout_ms) +
                   ", track_statistics=" + std::to_string(c.track_statistics) + ")";
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
                      "Total buffers acquired")

        .def_readonly("total_released", &CommandBufferRing::Statistics::total_released,
                      "Total buffers released")

        .def_readonly("wait_events", &CommandBufferRing::Statistics::wait_events,
                      "Number of times waited for buffer availability")

        .def_readonly("timeout_events", &CommandBufferRing::Statistics::timeout_events,
                      "Number of timeout events")

        .def_readonly("avg_wait_time_us", &CommandBufferRing::Statistics::avg_wait_time_us,
                      "Average wait time in microseconds")

        .def_readonly("max_wait_time_us", &CommandBufferRing::Statistics::max_wait_time_us,
                      "Maximum wait time in microseconds")

        .def_readonly("buffer_utilization", &CommandBufferRing::Statistics::buffer_utilization,
                      "Buffer utilization percentage (0-100)")

        .def_readonly("submission_overhead_us", &CommandBufferRing::Statistics::submission_overhead_us,
                      "Average submission overhead in microseconds")

        .def_readonly("rotations", &CommandBufferRing::Statistics::rotations,
                      "Number of ring rotations (wrap-arounds)")

        .def_readonly("rotation_rate", &CommandBufferRing::Statistics::rotation_rate,
                      "Ring rotation rate (rotations per second)")

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
            return d;
        }, "Convert statistics to Python dictionary")

        .def("__repr__", [](const CommandBufferRing::Statistics& s) {
            return "CommandBufferRingStatistics(ring_size=" + std::to_string(s.ring_size) +
                   ", available=" + std::to_string(s.available_count) +
                   ", in_flight=" + std::to_string(s.in_flight_count) +
                   ", wait_events=" + std::to_string(s.wait_events) +
                   ", utilization=" + std::to_string(s.buffer_utilization) + "%)";
        });

    // CommandBufferRing main class
    py::class_<CommandBufferRing>(m, "CommandBufferRing")
        .def(py::init<const CommandBufferRing::Config&>(),
             py::arg("config"),
             "Create a command buffer ring with specified configuration\n\n"
             "Args:\n"
             "    config: CommandBufferRingConfig instance\n\n"
             "Raises:\n"
             "    RuntimeError: If Metal device is unavailable\n"
             "    ValueError: If configuration is invalid\n\n"
             "Example:\n"
             "    >>> config = CommandBufferRingConfig()\n"
             "    >>> config.ring_size = 3  # Triple buffering\n"
             "    >>> ring = CommandBufferRing(config)")

        .def("acquire_buffer", &CommandBufferRing::acquireBuffer,
             "Acquire next available buffer from ring\n\n"
             "Returns:\n"
             "    id<MTLCommandBuffer>: Metal command buffer (opaque pointer)\n\n"
             "Raises:\n"
             "    RuntimeError: If timeout occurs or allocation fails\n\n"
             "Notes:\n"
             "    - Blocks if all buffers are in-flight (respects timeout_ms)\n"
             "    - Thread-safe operation\n"
             "    - Must be paired with release_buffer() to avoid deadlock\n\n"
             "Example:\n"
             "    >>> buffer = ring.acquire_buffer()\n"
             "    >>> # Use buffer for GPU commands\n"
             "    >>> ring.release_buffer(buffer)")

        .def("release_buffer", &CommandBufferRing::releaseBuffer,
             py::arg("buffer"),
             "Release buffer back to ring\n\n"
             "Args:\n"
             "    buffer: Buffer previously acquired via acquire_buffer()\n\n"
             "Notes:\n"
             "    - Commits buffer to GPU and marks as in-flight\n"
             "    - Buffer becomes available after GPU completion\n"
             "    - Thread-safe operation\n"
             "    - Safe to call with null buffer (no-op)\n\n"
             "Example:\n"
             "    >>> buffer = ring.acquire_buffer()\n"
             "    >>> # Use buffer...\n"
             "    >>> ring.release_buffer(buffer)  # Commits & schedules completion")

        .def("wait_all", &CommandBufferRing::waitAll,
             "Wait for all in-flight buffers to complete\n\n"
             "Blocks until all submitted buffers finish GPU execution.\n"
             "Useful for synchronization points or shutdown.\n\n"
             "Example:\n"
             "    >>> ring.wait_all()  # Wait for GPU to finish all work")

        .def("get_statistics", &CommandBufferRing::getStatistics,
             "Get current ring statistics\n\n"
             "Returns:\n"
             "    CommandBufferRingStatistics: Statistics snapshot\n\n"
             "Example:\n"
             "    >>> stats = ring.get_statistics()\n"
             "    >>> print(f'Utilization: {stats.buffer_utilization:.1f}%')\n"
             "    >>> print(f'Wait events: {stats.wait_events}')\n"
             "    >>> print(f'Avg wait: {stats.avg_wait_time_us:.0f} μs')")

        .def("reset_statistics", &CommandBufferRing::resetStatistics,
             "Reset all statistics counters to zero\n\n"
             "Resets acquired/released/wait/rotation counters.\n"
             "Buffer state (available/in-flight) is NOT reset.\n\n"
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
