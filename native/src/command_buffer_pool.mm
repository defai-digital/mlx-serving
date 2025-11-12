#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include "../include/kr_command_buffer_pool.h"
#include <vector>
#include <mutex>
#include <atomic>

namespace krserve {

class CommandBufferPool::Impl {
public:
    explicit Impl(size_t pool_size)
        : max_pool_size_(pool_size)
        , total_acquired_(0)
        , total_released_(0)
        , cache_hits_(0)
        , cache_misses_(0)
    {
        // Get default Metal device
        device_ = MTLCreateSystemDefaultDevice();
        if (!device_) {
            throw std::runtime_error("Failed to create Metal device");
        }

        // Create command queue
        queue_ = [device_ newCommandQueue];
        if (!queue_) {
            throw std::runtime_error("Failed to create Metal command queue");
        }

        // Pre-allocate pool storage
        pool_.reserve(pool_size);
    }

    ~Impl() {
        std::lock_guard<std::mutex> lock(mutex_);
        pool_.clear();
        queue_ = nil;
        device_ = nil;
    }

    void* acquire() {
        total_acquired_.fetch_add(1, std::memory_order_relaxed);

        std::lock_guard<std::mutex> lock(mutex_);

        // Try to reuse from pool
        if (!pool_.empty()) {
            id<MTLCommandBuffer> buffer = pool_.back();
            pool_.pop_back();
            cache_hits_.fetch_add(1, std::memory_order_relaxed);
            return (__bridge_retained void*)buffer;
        }

        // Pool empty - create new buffer
        cache_misses_.fetch_add(1, std::memory_order_relaxed);
        id<MTLCommandBuffer> buffer = [queue_ commandBuffer];
        return (__bridge_retained void*)buffer;
    }

    void release(void* buffer_ptr) {
        if (!buffer_ptr) {
            return;
        }

        total_released_.fetch_add(1, std::memory_order_relaxed);

        id<MTLCommandBuffer> buffer = (__bridge_transfer id<MTLCommandBuffer>)buffer_ptr;

        std::lock_guard<std::mutex> lock(mutex_);

        // Return to pool if not full
        if (pool_.size() < max_pool_size_) {
            pool_.push_back(buffer);
        }
        // Otherwise let ARC release it
    }

    void reset() {
        std::lock_guard<std::mutex> lock(mutex_);
        pool_.clear();
    }

    CommandBufferPool::Stats getStats() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return {
            .pool_size = max_pool_size_,
            .available_buffers = pool_.size(),
            .total_acquired = total_acquired_.load(std::memory_order_relaxed),
            .total_released = total_released_.load(std::memory_order_relaxed),
            .cache_hits = cache_hits_.load(std::memory_order_relaxed),
            .cache_misses = cache_misses_.load(std::memory_order_relaxed)
        };
    }

private:
    id<MTLDevice> device_;
    id<MTLCommandQueue> queue_;
    std::vector<id<MTLCommandBuffer>> pool_;
    size_t max_pool_size_;

    mutable std::mutex mutex_;

    std::atomic<uint64_t> total_acquired_;
    std::atomic<uint64_t> total_released_;
    std::atomic<uint64_t> cache_hits_;
    std::atomic<uint64_t> cache_misses_;
};

// Public API implementation
CommandBufferPool::CommandBufferPool(size_t pool_size)
    : impl_(std::make_unique<Impl>(pool_size))
{
}

CommandBufferPool::~CommandBufferPool() = default;

void* CommandBufferPool::acquire() {
    return impl_->acquire();
}

void CommandBufferPool::release(void* buffer) {
    impl_->release(buffer);
}

void CommandBufferPool::reset() {
    impl_->reset();
}

CommandBufferPool::Stats CommandBufferPool::getStats() const {
    return impl_->getStats();
}

} // namespace krserve
