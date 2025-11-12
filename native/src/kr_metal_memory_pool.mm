#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include "../include/kr_metal_memory_pool.h"
#include <vector>
#include <mutex>
#include <atomic>
#include <algorithm>
#include <iostream>

namespace krserve {

/**
 * Implementation class using Pimpl idiom
 *
 * Encapsulates Objective-C++ Metal objects from C++ header.
 * Provides thread-safe heap pooling with RAII guarantees.
 */
class MetalMemoryPool::Impl {
public:
    explicit Impl(const Config& config)
        : config_(config)
        , total_acquired_(0)
        , total_released_(0)
        , exhaustion_events_(0)
        , fallback_events_(0)
    {
        // Get default Metal device
        device_ = MTLCreateSystemDefaultDevice();
        if (!device_) {
            throw std::runtime_error("Failed to create Metal device - Apple Silicon required");
        }

        // Log device info
        std::cerr << "[MetalMemoryPool] Metal device: "
                  << [[device_ name] UTF8String]
                  << std::endl;

        // Validate configuration
        validateConfig();

        // Pre-allocate heaps
        pool_.reserve(config_.num_heaps);
        available_.reserve(config_.num_heaps);

        for (size_t i = 0; i < config_.num_heaps; ++i) {
            @try {
                id<MTLHeap> heap = createHeap(config_.heap_size_mb);
                pool_.push_back(heap);
                available_.push_back(heap);
            } @catch (NSException* exception) {
                std::cerr << "[MetalMemoryPool] Failed to create heap " << i << ": "
                          << [[exception reason] UTF8String]
                          << std::endl;
                throw std::runtime_error("Failed to create Metal heap");
            }
        }

        std::cerr << "[MetalMemoryPool] Initialized: "
                  << pool_.size() << " heaps × "
                  << config_.heap_size_mb << " MB ("
                  << (pool_.size() * config_.heap_size_mb) << " MB total)"
                  << std::endl;
    }

    ~Impl() {
        std::lock_guard<std::mutex> lock(mutex_);

        // Leak detection
        const uint64_t acquired = total_acquired_.load(std::memory_order_relaxed);
        const uint64_t released = total_released_.load(std::memory_order_relaxed);

        if (acquired != released) {
            std::cerr << "[MetalMemoryPool] WARNING: Memory leak detected!\n"
                      << "  Acquired: " << acquired << "\n"
                      << "  Released: " << released << "\n"
                      << "  Leaked:   " << (acquired - released)
                      << std::endl;
        } else if (config_.track_statistics) {
            std::cerr << "[MetalMemoryPool] Shutdown clean: "
                      << acquired << " heaps acquired/released"
                      << std::endl;
        }

        // Release all heaps (ARC will handle cleanup)
        pool_.clear();
        available_.clear();
        device_ = nil;
    }

    void* acquireHeap() {
        std::lock_guard<std::mutex> lock(mutex_);

        // Check if pool is exhausted
        if (available_.empty()) {
            exhaustion_events_.fetch_add(1, std::memory_order_relaxed);

            if (config_.log_exhaustion) {
                logExhaustion();
            }

            // Fallback: create temporary heap (not pooled)
            fallback_events_.fetch_add(1, std::memory_order_relaxed);

            @try {
                id<MTLHeap> temp_heap = createHeap(config_.heap_size_mb);
                total_acquired_.fetch_add(1, std::memory_order_relaxed);
                return (__bridge_retained void*)temp_heap;
            } @catch (NSException* exception) {
                std::cerr << "[MetalMemoryPool] CRITICAL: Fallback allocation failed: "
                          << [[exception reason] UTF8String]
                          << std::endl;
                return nullptr;
            }
        }

        // Get heap from pool
        id<MTLHeap> heap = available_.back();
        available_.pop_back();

        total_acquired_.fetch_add(1, std::memory_order_relaxed);

        // Return as void* (caller will bridge_transfer back)
        return (__bridge_retained void*)heap;
    }

    void releaseHeap(void* heap_ptr) {
        if (!heap_ptr) {
            return;
        }

        // Convert void* back to id<MTLHeap>
        id<MTLHeap> heap = (__bridge_transfer id<MTLHeap>)heap_ptr;

        std::lock_guard<std::mutex> lock(mutex_);

        // Check if heap is from pool
        bool is_pooled = false;
        for (id<MTLHeap> pooled_heap : pool_) {
            if (pooled_heap == heap) {
                is_pooled = true;
                break;
            }
        }

        total_released_.fetch_add(1, std::memory_order_relaxed);

        if (is_pooled) {
            // Return to pool for reuse
            available_.push_back(heap);
        }
        // else: temporary heap will be auto-released via ARC
    }

    void warmup() {
        if (config_.warmup_sizes.empty()) {
            std::cerr << "[MetalMemoryPool] Warmup skipped (no sizes configured)"
                      << std::endl;
            return;
        }

        std::cerr << "[MetalMemoryPool] Warming up pool with "
                  << config_.warmup_sizes.size() << " buffer sizes..."
                  << std::endl;

        std::lock_guard<std::mutex> lock(mutex_);

        for (size_t size_mb : config_.warmup_sizes) {
            const size_t size_bytes = size_mb * 1024 * 1024;

            for (id<MTLHeap> heap : available_) {
                @try {
                    // Pre-allocate buffer of specified size
                    MTLResourceOptions options = MTLResourceStorageModePrivate;

                    if (size_bytes <= [heap maxAvailableSizeWithAlignment:1]) {
                        id<MTLBuffer> buffer = [heap newBufferWithLength:size_bytes
                                                                 options:options];
                        if (buffer) {
                            // Buffer will be auto-released, warming the heap
                            // No need to keep reference
                        }
                    }
                } @catch (NSException* exception) {
                    std::cerr << "[MetalMemoryPool] Warmup warning: "
                              << "Failed to allocate " << size_mb << " MB buffer: "
                              << [[exception reason] UTF8String]
                              << std::endl;
                    // Continue with other sizes
                }
            }
        }

        std::cerr << "[MetalMemoryPool] Warmup complete" << std::endl;
    }

    MetalMemoryPool::Statistics getStatistics() const {
        std::lock_guard<std::mutex> lock(mutex_);

        return {
            .total_acquired = total_acquired_.load(std::memory_order_relaxed),
            .total_released = total_released_.load(std::memory_order_relaxed),
            .exhaustion_events = exhaustion_events_.load(std::memory_order_relaxed),
            .fallback_events = fallback_events_.load(std::memory_order_relaxed),
            .pool_size = pool_.size(),
            .available_count = available_.size()
        };
    }

    void resetStatistics() {
        std::lock_guard<std::mutex> lock(mutex_);
        total_acquired_.store(0, std::memory_order_relaxed);
        total_released_.store(0, std::memory_order_relaxed);
        exhaustion_events_.store(0, std::memory_order_relaxed);
        fallback_events_.store(0, std::memory_order_relaxed);
    }

private:
    // Configuration
    Config config_;

    // Metal objects
    id<MTLDevice> device_;

    // Heap pool
    std::vector<id<MTLHeap>> pool_;       // All allocated heaps
    std::vector<id<MTLHeap>> available_;  // Available heaps (subset of pool_)

    // Thread safety
    mutable std::mutex mutex_;

    // Statistics (atomic for lock-free reads in some cases)
    std::atomic<uint64_t> total_acquired_;
    std::atomic<uint64_t> total_released_;
    std::atomic<uint64_t> exhaustion_events_;
    std::atomic<uint64_t> fallback_events_;

    /**
     * Validate configuration
     * @throws std::invalid_argument if configuration is invalid
     */
    void validateConfig() {
        if (config_.heap_size_mb < 64) {
            throw std::invalid_argument("heap_size_mb must be >= 64 MB");
        }
        if (config_.heap_size_mb > 4096) {
            throw std::invalid_argument("heap_size_mb must be <= 4096 MB (4 GB)");
        }
        if (config_.num_heaps < 2) {
            throw std::invalid_argument("num_heaps must be >= 2");
        }
        if (config_.num_heaps > 16) {
            throw std::invalid_argument("num_heaps must be <= 16");
        }

        // Validate warmup sizes
        for (size_t size : config_.warmup_sizes) {
            if (size > config_.heap_size_mb) {
                std::cerr << "[MetalMemoryPool] Warning: warmup size "
                          << size << " MB exceeds heap size "
                          << config_.heap_size_mb << " MB (will skip)"
                          << std::endl;
            }
        }
    }

    /**
     * Create a new MTLHeap
     * @param size_mb Heap size in megabytes
     * @return MTLHeap object
     * @throws std::runtime_error if heap creation fails
     */
    id<MTLHeap> createHeap(size_t size_mb) {
        const size_t size_bytes = size_mb * 1024 * 1024;

        // Configure heap descriptor
        MTLHeapDescriptor* descriptor = [MTLHeapDescriptor new];
        descriptor.size = size_bytes;
        descriptor.storageMode = MTLStorageModePrivate;  // GPU-only memory
        descriptor.cpuCacheMode = MTLCPUCacheModeDefaultCache;
        descriptor.hazardTrackingMode = MTLHazardTrackingModeTracked;  // Safe default
        descriptor.resourceOptions = MTLResourceStorageModePrivate;
        descriptor.type = MTLHeapTypeAutomatic;  // Let Metal choose optimal layout

        // Create heap
        id<MTLHeap> heap = [device_ newHeapWithDescriptor:descriptor];

        if (!heap) {
            throw std::runtime_error("Failed to create Metal heap - out of GPU memory?");
        }

        return heap;
    }

    /**
     * Log pool exhaustion warning
     */
    void logExhaustion() {
        const uint64_t exhaustion_count = exhaustion_events_.load(std::memory_order_relaxed);

        std::cerr << "[MetalMemoryPool] WARNING: Pool exhausted (event #"
                  << exhaustion_count << ")\n"
                  << "  Pool size: " << pool_.size() << " heaps\n"
                  << "  Heap size: " << config_.heap_size_mb << " MB\n"
                  << "  Total acquired: " << total_acquired_.load(std::memory_order_relaxed) << "\n"
                  << "  Total released: " << total_released_.load(std::memory_order_relaxed) << "\n"
                  << "  Recommendation: Increase num_heaps or heap_size_mb"
                  << std::endl;
    }
};

// ============================================================================
// Public API Implementation (delegates to Impl via Pimpl)
// ============================================================================

MetalMemoryPool::MetalMemoryPool(const Config& config)
    : impl_(std::make_unique<Impl>(config))
{
}

MetalMemoryPool::~MetalMemoryPool() = default;

void* MetalMemoryPool::acquireHeap() {
    return impl_->acquireHeap();
}

void MetalMemoryPool::releaseHeap(void* heap) {
    impl_->releaseHeap(heap);
}

void MetalMemoryPool::warmup() {
    impl_->warmup();
}

MetalMemoryPool::Statistics MetalMemoryPool::getStatistics() const {
    return impl_->getStatistics();
}

void MetalMemoryPool::resetStatistics() {
    impl_->resetStatistics();
}

} // namespace krserve
