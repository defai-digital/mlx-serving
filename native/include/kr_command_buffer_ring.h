#pragma once

#ifdef __OBJC__
#import <Metal/Metal.h>
#endif

#include <cstddef>
#include <cstdint>
#include <memory>
#include <chrono>

namespace krserve {

/**
 * Command Buffer Ring for Metal GPU operations
 *
 * Implements double/triple buffering pattern with 2-3 MTLCommandBuffers
 * in a round-robin rotation. This enables better GPU utilization by
 * allowing the GPU to work on one buffer while the CPU prepares the next.
 *
 * Architecture:
 * - Ring of 2-3 pre-allocated MTLCommandBuffers
 * - Round-robin acquisition with automatic rotation
 * - Wait for buffer completion before reuse (prevents GPU stalls)
 * - Thread-safe acquire/release with std::mutex
 *
 * Performance Impact:
 * - Expected: +5-10% GPU utilization
 * - Expected: -30% submission overhead
 * - Eliminates command buffer allocation during hot path
 *
 * Usage:
 *   CommandBufferRing ring(config);
 *
 *   // Acquire next buffer (waits if all buffers in-flight)
 *   void* buffer = ring.acquireBuffer();
 *
 *   // Use buffer...
 *   id<MTLCommandBuffer> mtlBuffer = (__bridge id<MTLCommandBuffer>)buffer;
 *   [mtlBuffer commit];
 *
 *   // Release buffer (marks as in-use, will be reused after completion)
 *   ring.releaseBuffer(buffer);
 *
 *   // Wait for all buffers to complete
 *   ring.waitAll();
 */
class CommandBufferRing {
public:
    /**
     * Configuration for command buffer ring
     */
    struct Config {
        /**
         * Number of buffers in ring (2-3 recommended)
         * - 2 buffers: Double buffering (CPU/GPU overlap)
         * - 3 buffers: Triple buffering (higher latency tolerance)
         */
        size_t ring_size = 2;

        /**
         * Maximum time to wait for buffer availability (milliseconds)
         * - 0 = infinite wait
         * - >0 = timeout after N milliseconds
         */
        uint32_t timeout_ms = 0;

        /**
         * Enable detailed statistics tracking
         */
        bool track_statistics = true;

        /**
         * Log warnings when waiting for buffers
         */
        bool log_wait_events = false;
    };

    /**
     * Statistics for command buffer ring
     */
    struct Statistics {
        // Buffer management
        size_t ring_size;             // Number of buffers in ring
        size_t available_count;       // Currently available buffers
        size_t in_flight_count;       // Buffers currently in use

        // Acquisition metrics
        uint64_t total_acquired;      // Total buffers acquired
        uint64_t total_released;      // Total buffers released
        uint64_t wait_events;         // Times we had to wait for buffer
        uint64_t timeout_events;      // Times we hit timeout

        // Performance metrics
        double avg_wait_time_us;      // Average wait time (microseconds)
        double max_wait_time_us;      // Maximum wait time (microseconds)
        double buffer_utilization;    // % of time buffers are in use
        double submission_overhead_us; // Average submission overhead (microseconds)

        // Rotation metrics
        uint64_t rotations;           // Number of ring rotations
        double rotation_rate;         // Rotations per second
    };

    /**
     * Create a command buffer ring
     * @param config Ring configuration
     * @throws std::runtime_error if Metal device creation fails
     * @throws std::invalid_argument if config is invalid
     */
    explicit CommandBufferRing(const Config& config);

    /**
     * Destructor - waits for all buffers to complete
     */
    ~CommandBufferRing();

    // Non-copyable, non-movable
    CommandBufferRing(const CommandBufferRing&) = delete;
    CommandBufferRing& operator=(const CommandBufferRing&) = delete;
    CommandBufferRing(CommandBufferRing&&) = delete;
    CommandBufferRing& operator=(CommandBufferRing&&) = delete;

    /**
     * Acquire next available buffer from ring
     *
     * Behavior:
     * - Returns immediately if buffer available
     * - Waits for buffer completion if all buffers in-flight
     * - Respects timeout_ms configuration
     * - Thread-safe with mutex protection
     *
     * @return Command buffer (id<MTLCommandBuffer> as void*)
     * @throws std::runtime_error if timeout occurs or allocation fails
     */
    void* acquireBuffer();

    /**
     * Release buffer back to ring
     *
     * Marks buffer as in-flight and schedules completion handler.
     * Buffer will become available again after GPU completes execution.
     *
     * @param buffer Command buffer to release (id<MTLCommandBuffer>)
     */
    void releaseBuffer(void* buffer);

    /**
     * Wait for all in-flight buffers to complete
     *
     * Blocks until all submitted buffers finish GPU execution.
     * Useful for shutdown or synchronization points.
     */
    void waitAll();

    /**
     * Get current statistics
     * @return Ring statistics (safe to call from any thread)
     */
    Statistics getStatistics() const;

    /**
     * Reset statistics counters
     * Does not affect buffer state or availability.
     */
    void resetStatistics();

private:
    // Forward declaration for Pimpl idiom
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace krserve
