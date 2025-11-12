#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include "../include/kr_blit_queue.h"
#include <vector>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <chrono>
#include <thread>
#include <iostream>
#include <algorithm>

namespace krserve {

/**
 * Blit operation metadata for tracking
 */
struct BlitOperation {
    uint64_t op_id;                          // Unique operation ID
    uint64_t event_value;                    // MTLSharedEvent signal value
    std::chrono::steady_clock::time_point start_time;
    std::chrono::steady_clock::time_point end_time;
    bool is_upload;                          // true = upload, false = download
    size_t data_size;                        // Size in bytes
    BlitQueue::CompletionHandler completion; // Optional callback
};

/**
 * Implementation class using Pimpl idiom
 *
 * Encapsulates Objective-C++ Metal objects from C++ header.
 * Provides thread-safe asynchronous blit operations with MTLSharedEvent synchronization.
 */
class BlitQueue::Impl {
public:
    explicit Impl(const Config& config)
        : config_(config)
        , next_op_id_(1)
        , next_event_value_(1)
        , total_uploads_(0)
        , total_downloads_(0)
        , total_upload_ms_(0.0)
        , total_download_ms_(0.0)
        , total_overlap_ms_(0.0)
        , sync_wait_count_(0)
        , total_sync_wait_ms_(0.0)
    {
        if (!config_.enabled) {
            std::cerr << "[BlitQueue] Disabled by configuration" << std::endl;
            return;
        }

        // Get default Metal device
        device_ = MTLCreateSystemDefaultDevice();
        if (!device_) {
            throw std::runtime_error("Failed to create Metal device - Apple Silicon required");
        }

        // Create dedicated blit command queue
        blit_queue_ = [device_ newCommandQueue];
        if (!blit_queue_) {
            throw std::runtime_error("Failed to create Metal blit command queue");
        }
        blit_queue_.label = @"krserve.blit.queue";

        // Create shared event for CPU-GPU synchronization
        if (config_.use_shared_events) {
            shared_event_ = [device_ newSharedEvent];
            if (!shared_event_) {
                std::cerr << "[BlitQueue] WARNING: Failed to create MTLSharedEvent, "
                          << "falling back to barrier synchronization"
                          << std::endl;
                config_.use_shared_events = false;
            } else {
                shared_event_.label = @"krserve.blit.event";
            }
        }

        // Reserve space for pending operations tracking
        pending_ops_.reserve(config_.max_pending_ops);

        std::cerr << "[BlitQueue] Initialized: "
                  << "max_pending=" << config_.max_pending_ops
                  << ", shared_events=" << (config_.use_shared_events ? "yes" : "no")
                  << std::endl;
    }

    ~Impl() {
        if (!config_.enabled) {
            return;
        }

        // Wait for all pending operations before cleanup
        waitForAll();

        std::lock_guard<std::mutex> lock(mutex_);

        if (config_.track_metrics) {
            const uint64_t uploads = total_uploads_.load(std::memory_order_relaxed);
            const uint64_t downloads = total_downloads_.load(std::memory_order_relaxed);
            std::cerr << "[BlitQueue] Shutdown: "
                      << uploads << " uploads, "
                      << downloads << " downloads, "
                      << getOverlapRatio() << "% overlap efficiency"
                      << std::endl;
        }

        // Clean up pending operations
        pending_ops_.clear();
        completed_ops_.clear();

        // Release Metal objects (ARC handles cleanup)
        shared_event_ = nil;
        blit_queue_ = nil;
        device_ = nil;
    }

    uint64_t uploadAsync(
        const void* source_data,
        size_t source_size,
        void* dest_buffer_ptr,
        size_t dest_offset,
        CompletionHandler completion
    ) {
        if (!config_.enabled) {
            throw std::runtime_error("BlitQueue is disabled");
        }

        if (!source_data || !dest_buffer_ptr || source_size == 0) {
            throw std::invalid_argument("Invalid upload parameters");
        }

        id<MTLBuffer> dest_buffer = (__bridge id<MTLBuffer>)dest_buffer_ptr;

        // Validate buffer size
        if (dest_offset + source_size > [dest_buffer length]) {
            throw std::invalid_argument("Upload would exceed buffer bounds");
        }

        // Create staging buffer for CPU data (MTLResourceStorageModeShared)
        id<MTLBuffer> staging_buffer = [device_ newBufferWithBytes:source_data
                                                            length:source_size
                                                           options:MTLResourceStorageModeShared];
        if (!staging_buffer) {
            throw std::runtime_error("Failed to create staging buffer for upload");
        }

        const uint64_t op_id = next_op_id_.fetch_add(1, std::memory_order_relaxed);
        const uint64_t event_value = next_event_value_.fetch_add(1, std::memory_order_relaxed);

        auto start_time = std::chrono::steady_clock::now();

        // Create blit command buffer
        id<MTLCommandBuffer> cmd_buffer = [blit_queue_ commandBuffer];
        cmd_buffer.label = [NSString stringWithFormat:@"krserve.blit.upload.%llu", op_id];

        // Create blit encoder
        id<MTLBlitCommandEncoder> encoder = [cmd_buffer blitCommandEncoder];
        encoder.label = @"krserve.blit.encoder.upload";

        // Copy from staging (CPU) to destination (GPU)
        [encoder copyFromBuffer:staging_buffer
                   sourceOffset:0
                       toBuffer:dest_buffer
              destinationOffset:dest_offset
                           size:source_size];

        [encoder endEncoding];

        // Signal shared event when complete
        if (config_.use_shared_events && shared_event_) {
            [cmd_buffer encodeSignalEvent:shared_event_ value:event_value];
        }

        // Add completion handler for metrics and callbacks
        [cmd_buffer addCompletedHandler:^(id<MTLCommandBuffer> buffer) {
            auto end_time = std::chrono::steady_clock::now();
            this->onBlitComplete(op_id, start_time, end_time, true, source_size, completion);
        }];

        // Commit command buffer (non-blocking)
        [cmd_buffer commit];

        // Track pending operation
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pending_ops_[op_id] = {
                .op_id = op_id,
                .event_value = event_value,
                .start_time = start_time,
                .end_time = {},
                .is_upload = true,
                .data_size = source_size,
                .completion = completion
            };
        }

        total_uploads_.fetch_add(1, std::memory_order_relaxed);

        return op_id;
    }

    uint64_t downloadAsync(
        void* source_buffer_ptr,
        size_t source_offset,
        void* dest_data,
        size_t dest_size,
        CompletionHandler completion
    ) {
        if (!config_.enabled) {
            throw std::runtime_error("BlitQueue is disabled");
        }

        if (!source_buffer_ptr || !dest_data || dest_size == 0) {
            throw std::invalid_argument("Invalid download parameters");
        }

        id<MTLBuffer> source_buffer = (__bridge id<MTLBuffer>)source_buffer_ptr;

        // Validate buffer size
        if (source_offset + dest_size > [source_buffer length]) {
            throw std::invalid_argument("Download would exceed buffer bounds");
        }

        // Create staging buffer for download (MTLResourceStorageModeShared)
        id<MTLBuffer> staging_buffer = [device_ newBufferWithLength:dest_size
                                                            options:MTLResourceStorageModeShared];
        if (!staging_buffer) {
            throw std::runtime_error("Failed to create staging buffer for download");
        }

        const uint64_t op_id = next_op_id_.fetch_add(1, std::memory_order_relaxed);
        const uint64_t event_value = next_event_value_.fetch_add(1, std::memory_order_relaxed);

        auto start_time = std::chrono::steady_clock::now();

        // Create blit command buffer
        id<MTLCommandBuffer> cmd_buffer = [blit_queue_ commandBuffer];
        cmd_buffer.label = [NSString stringWithFormat:@"krserve.blit.download.%llu", op_id];

        // Create blit encoder
        id<MTLBlitCommandEncoder> encoder = [cmd_buffer blitCommandEncoder];
        encoder.label = @"krserve.blit.encoder.download";

        // Copy from source (GPU) to staging (CPU-accessible)
        [encoder copyFromBuffer:source_buffer
                   sourceOffset:source_offset
                       toBuffer:staging_buffer
              destinationOffset:0
                           size:dest_size];

        [encoder endEncoding];

        // Signal shared event when complete
        if (config_.use_shared_events && shared_event_) {
            [cmd_buffer encodeSignalEvent:shared_event_ value:event_value];
        }

        // Add completion handler to copy from staging to destination
        [cmd_buffer addCompletedHandler:^(id<MTLCommandBuffer> buffer) {
            // Copy from staging buffer to destination (now safe to read)
            memcpy(dest_data, [staging_buffer contents], dest_size);

            auto end_time = std::chrono::steady_clock::now();
            this->onBlitComplete(op_id, start_time, end_time, false, dest_size, completion);
        }];

        // Commit command buffer (non-blocking)
        [cmd_buffer commit];

        // Track pending operation
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pending_ops_[op_id] = {
                .op_id = op_id,
                .event_value = event_value,
                .start_time = start_time,
                .end_time = {},
                .is_upload = false,
                .data_size = dest_size,
                .completion = completion
            };
        }

        total_downloads_.fetch_add(1, std::memory_order_relaxed);

        return op_id;
    }

    bool waitForCompletion(uint64_t operation_id, uint64_t timeout_ms) {
        if (!config_.enabled) {
            return true;
        }

        auto start_wait = std::chrono::steady_clock::now();

        // Check if already completed
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (completed_ops_.find(operation_id) != completed_ops_.end()) {
                return true;
            }
        }

        // Get event value for this operation
        uint64_t event_value = 0;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = pending_ops_.find(operation_id);
            if (it == pending_ops_.end()) {
                // Operation not found (might have completed)
                return completed_ops_.find(operation_id) != completed_ops_.end();
            }
            event_value = it->second.event_value;
        }

        // Wait on shared event
        if (config_.use_shared_events && shared_event_) {
            if (timeout_ms > 0) {
                // Wait with timeout (nanoseconds)
                uint64_t timeout_ns = timeout_ms * 1000000ULL;
                bool completed = [shared_event_ waitUntilSignaledValue:event_value
                                                          timeoutMS:(timeout_ns / 1000000)];

                if (completed) {
                    recordSyncWait(start_wait);
                    return true;
                } else {
                    return false; // Timeout
                }
            } else {
                // Wait forever
                while ([shared_event_ signaledValue] < event_value) {
                    // Efficient wait loop (not busy-wait)
                    std::this_thread::sleep_for(std::chrono::microseconds(100));
                }
                recordSyncWait(start_wait);
                return true;
            }
        } else {
            // Fallback: poll completed_ops_
            auto deadline = start_wait + std::chrono::milliseconds(timeout_ms);
            while (timeout_ms == 0 || std::chrono::steady_clock::now() < deadline) {
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    if (completed_ops_.find(operation_id) != completed_ops_.end()) {
                        recordSyncWait(start_wait);
                        return true;
                    }
                }
                std::this_thread::sleep_for(std::chrono::microseconds(100));
            }
            return false; // Timeout
        }
    }

    void waitForAll() {
        if (!config_.enabled) {
            return;
        }

        auto start_wait = std::chrono::steady_clock::now();

        // Get current highest event value
        uint64_t max_event_value = 0;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            for (const auto& pair : pending_ops_) {
                max_event_value = std::max(max_event_value, pair.second.event_value);
            }
        }

        if (max_event_value == 0) {
            return; // No pending operations
        }

        // Wait for highest event value
        if (config_.use_shared_events && shared_event_) {
            while ([shared_event_ signaledValue] < max_event_value) {
                std::this_thread::sleep_for(std::chrono::microseconds(100));
            }
        } else {
            // Fallback: wait until all pending operations complete
            while (true) {
                std::lock_guard<std::mutex> lock(mutex_);
                if (pending_ops_.empty()) {
                    break;
                }
                std::this_thread::sleep_for(std::chrono::microseconds(100));
            }
        }

        recordSyncWait(start_wait);
    }

    bool isCompleted(uint64_t operation_id) {
        std::lock_guard<std::mutex> lock(mutex_);
        return completed_ops_.find(operation_id) != completed_ops_.end();
    }

    BlitQueue::Metrics getMetrics() const {
        std::lock_guard<std::mutex> lock(mutex_);

        const uint64_t uploads = total_uploads_.load(std::memory_order_relaxed);
        const uint64_t downloads = total_downloads_.load(std::memory_order_relaxed);
        const double total_ops = static_cast<double>(uploads + downloads);

        return {
            .total_uploads = uploads,
            .total_downloads = downloads,
            .avg_upload_ms = uploads > 0 ? (total_upload_ms_ / uploads) : 0.0,
            .avg_download_ms = downloads > 0 ? (total_download_ms_ / downloads) : 0.0,
            .total_overlap_ms = total_overlap_ms_,
            .overlap_ratio = getOverlapRatio(),
            .sync_wait_count = sync_wait_count_.load(std::memory_order_relaxed),
            .avg_sync_wait_ms = sync_wait_count_ > 0
                ? (total_sync_wait_ms_ / sync_wait_count_)
                : 0.0
        };
    }

    void resetMetrics() {
        std::lock_guard<std::mutex> lock(mutex_);
        total_uploads_.store(0, std::memory_order_relaxed);
        total_downloads_.store(0, std::memory_order_relaxed);
        total_upload_ms_ = 0.0;
        total_download_ms_ = 0.0;
        total_overlap_ms_ = 0.0;
        sync_wait_count_.store(0, std::memory_order_relaxed);
        total_sync_wait_ms_ = 0.0;
        completed_ops_.clear();
    }

    void flush() {
        if (!config_.enabled || !blit_queue_) {
            return;
        }

        // Create empty command buffer and commit to flush queue
        id<MTLCommandBuffer> flush_buffer = [blit_queue_ commandBuffer];
        [flush_buffer commit];
    }

private:
    // Configuration
    Config config_;

    // Metal objects
    id<MTLDevice> device_;
    id<MTLCommandQueue> blit_queue_;
    id<MTLSharedEvent> shared_event_;

    // Operation tracking
    std::unordered_map<uint64_t, BlitOperation> pending_ops_;
    std::unordered_map<uint64_t, BlitOperation> completed_ops_;

    // Thread safety
    mutable std::mutex mutex_;

    // Operation IDs and event values
    std::atomic<uint64_t> next_op_id_;
    std::atomic<uint64_t> next_event_value_;

    // Metrics (atomic counters + mutex-protected aggregates)
    std::atomic<uint64_t> total_uploads_;
    std::atomic<uint64_t> total_downloads_;
    double total_upload_ms_;
    double total_download_ms_;
    double total_overlap_ms_;
    std::atomic<uint64_t> sync_wait_count_;
    double total_sync_wait_ms_;

    /**
     * Called when blit operation completes (from MTLCommandBuffer callback)
     */
    void onBlitComplete(
        uint64_t op_id,
        std::chrono::steady_clock::time_point start_time,
        std::chrono::steady_clock::time_point end_time,
        bool is_upload,
        size_t data_size,
        CompletionHandler completion
    ) {
        const double duration_ms = std::chrono::duration<double, std::milli>(
            end_time - start_time
        ).count();

        // Update metrics
        {
            std::lock_guard<std::mutex> lock(mutex_);

            if (is_upload) {
                total_upload_ms_ += duration_ms;
            } else {
                total_download_ms_ += duration_ms;
            }

            // Move from pending to completed
            auto it = pending_ops_.find(op_id);
            if (it != pending_ops_.end()) {
                BlitOperation op = it->second;
                op.end_time = end_time;
                completed_ops_[op_id] = op;
                pending_ops_.erase(it);

                // Calculate overlap (simplified: assume pipelining benefit)
                if (pending_ops_.size() > 0) {
                    total_overlap_ms_ += duration_ms * 0.8; // 80% overlap estimate
                }
            }
        }

        // Invoke user callback if provided
        if (completion) {
            completion();
        }

        // Log verbose metrics (debug builds)
        if (config_.track_metrics && (op_id % 100 == 0)) {
            std::cerr << "[BlitQueue] Op " << op_id
                      << " (" << (is_upload ? "upload" : "download") << ")"
                      << ": " << duration_ms << " ms"
                      << ", " << (data_size / 1024) << " KB"
                      << std::endl;
        }
    }

    /**
     * Record synchronization wait for metrics
     */
    void recordSyncWait(std::chrono::steady_clock::time_point start_wait) {
        auto end_wait = std::chrono::steady_clock::now();
        const double wait_ms = std::chrono::duration<double, std::milli>(
            end_wait - start_wait
        ).count();

        sync_wait_count_.fetch_add(1, std::memory_order_relaxed);

        {
            std::lock_guard<std::mutex> lock(mutex_);
            total_sync_wait_ms_ += wait_ms;
        }
    }

    /**
     * Calculate overlap efficiency ratio
     * @return Overlap ratio (0.0-1.0) or -1.0 if insufficient data
     */
    double getOverlapRatio() const {
        const uint64_t total_ops = total_uploads_.load(std::memory_order_relaxed)
                                 + total_downloads_.load(std::memory_order_relaxed);

        if (total_ops < 2) {
            return 0.0; // Not enough operations for overlap
        }

        const double total_io_ms = total_upload_ms_ + total_download_ms_;
        if (total_io_ms < 0.001) {
            return 0.0; // Avoid division by zero
        }

        // Overlap ratio = saved time / total I/O time
        return std::min(1.0, total_overlap_ms_ / total_io_ms);
    }
};

// ============================================================================
// Public API Implementation (delegates to Impl via Pimpl)
// ============================================================================

BlitQueue::BlitQueue(const Config& config)
    : impl_(std::make_unique<Impl>(config))
{
}

BlitQueue::~BlitQueue() = default;

uint64_t BlitQueue::uploadAsync(
    const void* source_data,
    size_t source_size,
    void* dest_buffer,
    size_t dest_offset,
    CompletionHandler completion
) {
    return impl_->uploadAsync(source_data, source_size, dest_buffer, dest_offset, completion);
}

uint64_t BlitQueue::downloadAsync(
    void* source_buffer,
    size_t source_offset,
    void* dest_data,
    size_t dest_size,
    CompletionHandler completion
) {
    return impl_->downloadAsync(source_buffer, source_offset, dest_data, dest_size, completion);
}

bool BlitQueue::waitForCompletion(uint64_t operation_id, uint64_t timeout_ms) {
    return impl_->waitForCompletion(operation_id, timeout_ms);
}

void BlitQueue::waitForAll() {
    impl_->waitForAll();
}

bool BlitQueue::isCompleted(uint64_t operation_id) {
    return impl_->isCompleted(operation_id);
}

BlitQueue::Metrics BlitQueue::getMetrics() const {
    return impl_->getMetrics();
}

void BlitQueue::resetMetrics() {
    impl_->resetMetrics();
}

void BlitQueue::flush() {
    impl_->flush();
}

} // namespace krserve
