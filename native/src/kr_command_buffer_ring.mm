#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include "../include/kr_command_buffer_ring.h"
#include <vector>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <chrono>
#include <iostream>
#include <algorithm>
#include <numeric>

namespace krserve {

/**
 * Buffer slot in the ring
 *
 * Tracks individual command buffer state and completion.
 */
struct BufferSlot {
    id<MTLCommandBuffer> buffer;  // Metal command buffer
    bool in_use;                  // Is buffer currently in-flight?
    uint64_t fence_value;         // Monotonic fence for completion tracking
    std::chrono::steady_clock::time_point acquire_time;  // When buffer was acquired
    std::chrono::steady_clock::time_point release_time;  // When buffer was released
};

/**
 * Implementation class using Pimpl idiom
 *
 * Encapsulates Objective-C++ Metal objects from C++ header.
 * Provides thread-safe ring buffer with automatic rotation.
 */
class CommandBufferRing::Impl {
public:
    explicit Impl(const Config& config)
        : config_(config)
        , current_index_(0)
        , fence_value_(0)
        , total_acquired_(0)
        , total_released_(0)
        , wait_events_(0)
        , timeout_events_(0)
        , rotations_(0)
        , total_wait_time_us_(0)
        , max_wait_time_us_(0)
        , start_time_(std::chrono::steady_clock::now())
    {
        // Get default Metal device
        device_ = MTLCreateSystemDefaultDevice();
        if (!device_) {
            throw std::runtime_error("Failed to create Metal device - Apple Silicon required");
        }

        // Create command queue
        queue_ = [device_ newCommandQueue];
        if (!queue_) {
            throw std::runtime_error("Failed to create Metal command queue");
        }

        // Validate configuration
        validateConfig();

        // Pre-allocate ring buffer slots
        ring_.reserve(config_.ring_size);

        for (size_t i = 0; i < config_.ring_size; ++i) {
            BufferSlot slot;
            slot.buffer = nil;  // Will be created on-demand
            slot.in_use = false;
            slot.fence_value = 0;
            ring_.push_back(slot);
        }

        std::cerr << "[CommandBufferRing] Initialized: "
                  << config_.ring_size << " buffers ("
                  << (config_.ring_size == 2 ? "double" : "triple")
                  << " buffering)"
                  << std::endl;
    }

    ~Impl() {
        // Wait for all in-flight buffers
        waitAll();

        std::lock_guard<std::mutex> lock(mutex_);

        // Log final statistics
        if (config_.track_statistics) {
            const uint64_t acquired = total_acquired_.load(std::memory_order_relaxed);
            const uint64_t released = total_released_.load(std::memory_order_relaxed);

            std::cerr << "[CommandBufferRing] Shutdown statistics:\n"
                      << "  Buffers acquired: " << acquired << "\n"
                      << "  Buffers released: " << released << "\n"
                      << "  Wait events: " << wait_events_.load(std::memory_order_relaxed) << "\n"
                      << "  Ring rotations: " << rotations_.load(std::memory_order_relaxed)
                      << std::endl;

            if (acquired != released) {
                std::cerr << "[CommandBufferRing] WARNING: Mismatch in acquire/release count!"
                          << std::endl;
            }
        }

        // Release all buffers (ARC will handle cleanup)
        ring_.clear();
        queue_ = nil;
        device_ = nil;
    }

    void* acquireBuffer() {
        auto acquire_start = std::chrono::steady_clock::now();

        std::unique_lock<std::mutex> lock(mutex_);

        // Wait for available buffer
        bool buffer_available = false;
        if (config_.timeout_ms > 0) {
            // Wait with timeout
            auto timeout = std::chrono::milliseconds(config_.timeout_ms);
            buffer_available = cv_.wait_for(lock, timeout, [this] {
                return hasAvailableBuffer();
            });

            if (!buffer_available) {
                timeout_events_.fetch_add(1, std::memory_order_relaxed);
                throw std::runtime_error("CommandBufferRing: timeout waiting for available buffer");
            }
        } else {
            // Wait indefinitely
            cv_.wait(lock, [this] {
                return hasAvailableBuffer();
            });
            buffer_available = true;
        }

        // Track wait time if we had to wait
        if (!hasAvailableBuffer_nolock()) {
            auto wait_end = std::chrono::steady_clock::now();
            auto wait_duration = std::chrono::duration_cast<std::chrono::microseconds>(
                wait_end - acquire_start
            ).count();

            wait_events_.fetch_add(1, std::memory_order_relaxed);
            total_wait_time_us_.fetch_add(wait_duration, std::memory_order_relaxed);

            uint64_t current_max = max_wait_time_us_.load(std::memory_order_relaxed);
            while (wait_duration > current_max &&
                   !max_wait_time_us_.compare_exchange_weak(current_max, wait_duration)) {
                // Loop until we successfully update max
            }

            if (config_.log_wait_events) {
                std::cerr << "[CommandBufferRing] Waited " << wait_duration
                          << " μs for buffer availability"
                          << std::endl;
            }
        }

        // Find next available buffer (round-robin)
        size_t start_index = current_index_;
        size_t attempts = 0;

        while (attempts < ring_.size()) {
            BufferSlot& slot = ring_[current_index_];

            if (!slot.in_use) {
                // Found available buffer!

                // Create buffer if needed (lazy allocation)
                if (slot.buffer == nil) {
                    slot.buffer = [queue_ commandBuffer];
                    if (!slot.buffer) {
                        throw std::runtime_error("Failed to create Metal command buffer");
                    }
                }

                // Mark as in-use
                slot.in_use = true;
                slot.fence_value = ++fence_value_;
                slot.acquire_time = std::chrono::steady_clock::now();

                // Advance index for next acquisition (round-robin)
                size_t acquired_index = current_index_;
                current_index_ = (current_index_ + 1) % ring_.size();

                // Track rotation if we wrapped around
                if (current_index_ < acquired_index) {
                    rotations_.fetch_add(1, std::memory_order_relaxed);
                }

                total_acquired_.fetch_add(1, std::memory_order_relaxed);

                // Return buffer (bridge_retained so caller can use it)
                return (__bridge_retained void*)slot.buffer;
            }

            // Try next slot
            current_index_ = (current_index_ + 1) % ring_.size();
            ++attempts;
        }

        // Should never reach here (wait condition guarantees available buffer)
        throw std::runtime_error("CommandBufferRing: internal error - no buffer available after wait");
    }

    void releaseBuffer(void* buffer_ptr) {
        if (!buffer_ptr) {
            return;
        }

        // Convert void* back to id<MTLCommandBuffer>
        id<MTLCommandBuffer> buffer = (__bridge_transfer id<MTLCommandBuffer>)buffer_ptr;

        std::unique_lock<std::mutex> lock(mutex_);

        // Find buffer in ring
        BufferSlot* slot = nullptr;
        for (auto& s : ring_) {
            if (s.buffer == buffer) {
                slot = &s;
                break;
            }
        }

        if (!slot) {
            std::cerr << "[CommandBufferRing] WARNING: Released buffer not found in ring"
                      << std::endl;
            return;
        }

        slot->release_time = std::chrono::steady_clock::now();

        // Register completion handler (called when GPU finishes)
        __block CommandBufferRing::Impl* impl_ptr = this;
        __block BufferSlot* slot_ptr = slot;

        [buffer addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull completedBuffer) {
            // Completion handler executes on Metal's internal thread
            std::unique_lock<std::mutex> completion_lock(impl_ptr->mutex_);

            // Mark buffer as available
            slot_ptr->in_use = false;

            // Notify waiting threads
            impl_ptr->cv_.notify_one();
        }];

        // Commit buffer to GPU
        [buffer commit];

        total_released_.fetch_add(1, std::memory_order_relaxed);

        // Unlock before notify to avoid waking threads that immediately re-lock
        lock.unlock();
    }

    void waitAll() {
        std::unique_lock<std::mutex> lock(mutex_);

        // Wait until all buffers are available
        cv_.wait(lock, [this] {
            for (const auto& slot : ring_) {
                if (slot.in_use) {
                    return false;
                }
            }
            return true;
        });

        std::cerr << "[CommandBufferRing] All buffers completed" << std::endl;
    }

    CommandBufferRing::Statistics getStatistics() const {
        std::lock_guard<std::mutex> lock(mutex_);

        const uint64_t acquired = total_acquired_.load(std::memory_order_relaxed);
        const uint64_t released = total_released_.load(std::memory_order_relaxed);
        const uint64_t waits = wait_events_.load(std::memory_order_relaxed);
        const uint64_t total_wait = total_wait_time_us_.load(std::memory_order_relaxed);
        const uint64_t rots = rotations_.load(std::memory_order_relaxed);

        // Count available vs in-flight buffers
        size_t available_count = 0;
        size_t in_flight_count = 0;
        for (const auto& slot : ring_) {
            if (slot.in_use) {
                ++in_flight_count;
            } else {
                ++available_count;
            }
        }

        // Calculate average wait time
        double avg_wait_time = (waits > 0) ? (total_wait / static_cast<double>(waits)) : 0.0;

        // Calculate buffer utilization (% of time buffers are in use)
        double utilization = (acquired > 0)
            ? (in_flight_count / static_cast<double>(ring_.size())) * 100.0
            : 0.0;

        // Calculate rotation rate (rotations per second)
        auto now = std::chrono::steady_clock::now();
        auto elapsed_sec = std::chrono::duration<double>(now - start_time_).count();
        double rotation_rate = (elapsed_sec > 0) ? (rots / elapsed_sec) : 0.0;

        // Calculate submission overhead (time between acquire and release)
        double avg_submission_overhead = 0.0;
        size_t completed_buffers = 0;
        for (const auto& slot : ring_) {
            if (!slot.in_use && slot.fence_value > 0) {
                auto overhead = std::chrono::duration_cast<std::chrono::microseconds>(
                    slot.release_time - slot.acquire_time
                ).count();
                avg_submission_overhead += overhead;
                ++completed_buffers;
            }
        }
        if (completed_buffers > 0) {
            avg_submission_overhead /= completed_buffers;
        }

        return {
            .ring_size = ring_.size(),
            .available_count = available_count,
            .in_flight_count = in_flight_count,
            .total_acquired = acquired,
            .total_released = released,
            .wait_events = waits,
            .timeout_events = timeout_events_.load(std::memory_order_relaxed),
            .avg_wait_time_us = avg_wait_time,
            .max_wait_time_us = static_cast<double>(max_wait_time_us_.load(std::memory_order_relaxed)),
            .buffer_utilization = utilization,
            .submission_overhead_us = avg_submission_overhead,
            .rotations = rots,
            .rotation_rate = rotation_rate
        };
    }

    void resetStatistics() {
        std::lock_guard<std::mutex> lock(mutex_);
        total_acquired_.store(0, std::memory_order_relaxed);
        total_released_.store(0, std::memory_order_relaxed);
        wait_events_.store(0, std::memory_order_relaxed);
        timeout_events_.store(0, std::memory_order_relaxed);
        rotations_.store(0, std::memory_order_relaxed);
        total_wait_time_us_.store(0, std::memory_order_relaxed);
        max_wait_time_us_.store(0, std::memory_order_relaxed);
        start_time_ = std::chrono::steady_clock::now();
    }

private:
    // Configuration
    Config config_;

    // Metal objects
    id<MTLDevice> device_;
    id<MTLCommandQueue> queue_;

    // Ring buffer
    std::vector<BufferSlot> ring_;
    size_t current_index_;  // Current position in ring (round-robin)
    uint64_t fence_value_;  // Monotonic counter for completion tracking

    // Thread safety
    mutable std::mutex mutex_;
    std::condition_variable cv_;

    // Statistics (atomic for lock-free reads in some cases)
    std::atomic<uint64_t> total_acquired_;
    std::atomic<uint64_t> total_released_;
    std::atomic<uint64_t> wait_events_;
    std::atomic<uint64_t> timeout_events_;
    std::atomic<uint64_t> rotations_;
    std::atomic<uint64_t> total_wait_time_us_;
    std::atomic<uint64_t> max_wait_time_us_;
    std::chrono::steady_clock::time_point start_time_;

    /**
     * Validate configuration
     * @throws std::invalid_argument if configuration is invalid
     */
    void validateConfig() {
        if (config_.ring_size < 2) {
            throw std::invalid_argument("ring_size must be >= 2 (double buffering)");
        }
        if (config_.ring_size > 3) {
            throw std::invalid_argument("ring_size must be <= 3 (triple buffering)");
        }

        std::cerr << "[CommandBufferRing] Configuration:\n"
                  << "  Ring size: " << config_.ring_size << " buffers\n"
                  << "  Timeout: " << (config_.timeout_ms == 0 ? "infinite" : std::to_string(config_.timeout_ms) + " ms") << "\n"
                  << "  Statistics: " << (config_.track_statistics ? "enabled" : "disabled")
                  << std::endl;
    }

    /**
     * Check if any buffer is available (thread-safe)
     * @return true if at least one buffer is available
     */
    bool hasAvailableBuffer() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return hasAvailableBuffer_nolock();
    }

    /**
     * Check if any buffer is available (caller must hold mutex)
     * @return true if at least one buffer is available
     */
    bool hasAvailableBuffer_nolock() const {
        for (const auto& slot : ring_) {
            if (!slot.in_use) {
                return true;
            }
        }
        return false;
    }
};

// ============================================================================
// Public API Implementation (delegates to Impl via Pimpl)
// ============================================================================

CommandBufferRing::CommandBufferRing(const Config& config)
    : impl_(std::make_unique<Impl>(config))
{
}

CommandBufferRing::~CommandBufferRing() = default;

void* CommandBufferRing::acquireBuffer() {
    return impl_->acquireBuffer();
}

void CommandBufferRing::releaseBuffer(void* buffer) {
    impl_->releaseBuffer(buffer);
}

void CommandBufferRing::waitAll() {
    impl_->waitAll();
}

CommandBufferRing::Statistics CommandBufferRing::getStatistics() const {
    return impl_->getStatistics();
}

void CommandBufferRing::resetStatistics() {
    impl_->resetStatistics();
}

} // namespace krserve
