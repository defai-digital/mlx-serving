#include "../include/kr_weight_manager.h"
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <cstring>
#include <iostream>
#include <algorithm>

namespace krserve {

// ============================================================================
// ThreadPool Implementation
// ============================================================================

WeightManager::ThreadPool::ThreadPool(size_t num_threads) {
    for (size_t i = 0; i < num_threads; ++i) {
        workers_.emplace_back([this] { this->workerThread(); });
    }
}

WeightManager::ThreadPool::~ThreadPool() {
    {
        std::unique_lock<std::mutex> lock(queue_mutex_);
        stop_ = true;
    }
    queue_cv_.notify_all();

    for (std::thread& worker : workers_) {
        if (worker.joinable()) {
            worker.join();
        }
    }
}

void WeightManager::ThreadPool::workerThread() {
    while (true) {
        std::function<void()> task;

        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            queue_cv_.wait(lock, [this] {
                return stop_ || !tasks_.empty();
            });

            if (stop_ && tasks_.empty()) {
                return;
            }

            if (!tasks_.empty()) {
                task = std::move(tasks_.front());
                tasks_.pop();
                active_tasks_++;
            }
        }

        if (task) {
            task();
            active_tasks_--;
        }
    }
}

size_t WeightManager::ThreadPool::getActiveTaskCount() const {
    return active_tasks_.load();
}

// ============================================================================
// WeightManager Implementation
// ============================================================================

WeightManager::WeightManager(const WeightManagerConfig& config)
    : config_(config)
{
    // Create thread pool for prefetching if enabled
    if (config_.prefetch_enabled && config_.prefetch_threads > 0) {
        thread_pool_ = std::make_unique<ThreadPool>(config_.prefetch_threads);
        std::cerr << "[WeightManager] Thread pool created with "
                  << config_.prefetch_threads << " threads" << std::endl;
    }

    // Log configuration
    std::cerr << "[WeightManager] Initialized:" << std::endl;
    std::cerr << "  - Pin critical weights: "
              << (config_.pin_critical_weights ? "YES" : "NO") << std::endl;
    std::cerr << "  - Pin all weights: "
              << (config_.pin_all_weights ? "YES" : "NO") << std::endl;
    std::cerr << "  - Prefetch enabled: "
              << (config_.prefetch_enabled ? "YES" : "NO") << std::endl;
    std::cerr << "  - Warmup on load: "
              << (config_.warmup_on_load ? "YES" : "NO") << std::endl;
    std::cerr << "  - Memory-mapped loading: "
              << (config_.use_mmap ? "YES" : "NO") << std::endl;
    std::cerr << "  - Critical layers: " << config_.critical_layers << std::endl;

    // Check system limits
    size_t max_pinnable = getMaxPinnableMemory();
    if (max_pinnable > 0) {
        std::cerr << "  - Max pinnable memory: "
                  << (max_pinnable / (1024 * 1024)) << " MB" << std::endl;
    }
}

WeightManager::~WeightManager() {
    // Destroy thread pool first (stops background tasks)
    thread_pool_.reset();

    // Unpin all pinned memory
    std::lock_guard<std::mutex> lock(pinned_mutex_);
    size_t total_unpinned = 0;

    for (const auto& pinned : pinned_weights_) {
        unpinMemory(pinned.ptr, pinned.length);
        total_unpinned += pinned.length;
    }

    if (!pinned_weights_.empty()) {
        std::cerr << "[WeightManager] Unpinned " << pinned_weights_.size()
                  << " weight buffers (" << (total_unpinned / (1024 * 1024))
                  << " MB)" << std::endl;
    }

    pinned_weights_.clear();
}

void WeightManager::pinModelWeights(const std::vector<id<MTLBuffer>>& weights) {
    if (!config_.pin_critical_weights && !config_.pin_all_weights) {
        return;
    }

    if (weights.empty()) {
        return;
    }

    // Determine how many weights to pin
    size_t num_to_pin = config_.pin_all_weights
        ? weights.size()
        : std::min(weights.size(), static_cast<size_t>(config_.critical_layers));

    std::cerr << "[WeightManager] Pinning " << num_to_pin << " / "
              << weights.size() << " weight buffers..." << std::endl;

    size_t total_pinned_bytes = 0;
    size_t successful_pins = 0;

    for (size_t i = 0; i < num_to_pin; ++i) {
        id<MTLBuffer> buffer = weights[i];
        if (!buffer) {
            continue;
        }

        void* ptr = [buffer contents];
        size_t length = [buffer length];

        // Check memory limits
        if (!withinMemoryLimits(length)) {
            std::cerr << "[WeightManager] Skipping weight " << i
                      << " (exceeds memory limit)" << std::endl;
            continue;
        }

        // Pin memory
        if (pinMemory(ptr, length)) {
            total_pinned_bytes += length;
            successful_pins++;
        }
    }

    std::cerr << "[WeightManager] Successfully pinned " << successful_pins
              << " buffers (" << (total_pinned_bytes / (1024 * 1024))
              << " MB)" << std::endl;

    if (successful_pins < num_to_pin) {
        std::cerr << "[WeightManager] WARNING: Failed to pin "
                  << (num_to_pin - successful_pins) << " buffers" << std::endl;
        std::cerr << "  Hint: Check ulimit -l and consider increasing locked memory limit"
                  << std::endl;
    }
}

void WeightManager::pinLayers(const std::vector<id<MTLBuffer>>& layers, int num_layers) {
    if (!config_.pin_critical_weights) {
        return;
    }

    if (layers.empty() || num_layers <= 0) {
        return;
    }

    int to_pin = std::min(num_layers, static_cast<int>(layers.size()));

    std::cerr << "[WeightManager] Pinning " << to_pin << " critical layers..."
              << std::endl;

    size_t total_pinned_bytes = 0;
    int successful_pins = 0;

    for (int i = 0; i < to_pin; ++i) {
        id<MTLBuffer> buffer = layers[i];
        if (!buffer) {
            continue;
        }

        void* ptr = [buffer contents];
        size_t length = [buffer length];

        // Check memory limits
        if (!withinMemoryLimits(length)) {
            std::cerr << "[WeightManager] Skipping layer " << i
                      << " (exceeds memory limit)" << std::endl;
            continue;
        }

        // Pin memory
        if (pinMemory(ptr, length)) {
            total_pinned_bytes += length;
            successful_pins++;
        }
    }

    std::cerr << "[WeightManager] Pinned " << successful_pins << " layers ("
              << (total_pinned_bytes / (1024 * 1024)) << " MB)" << std::endl;
}

void WeightManager::prefetchLayer(int layer_index, const std::vector<id<MTLBuffer>>& weights) {
    if (!config_.prefetch_enabled || !thread_pool_) {
        return;
    }

    if (weights.empty() || layer_index < 0) {
        return;
    }

    // Prefetch next 1-2 layers in background
    int num_to_prefetch = 2;
    for (int next = layer_index + 1;
         next <= layer_index + num_to_prefetch && next < static_cast<int>(weights.size());
         ++next) {

        id<MTLBuffer> buffer = weights[next];
        if (!buffer) {
            continue;
        }

        // Async prefetch in thread pool
        prefetchAsync(buffer);

        weights_prefetched_++;
        bytes_prefetched_ += [buffer length];
    }

    // Update active task count
    if (thread_pool_) {
        active_prefetch_tasks_ = thread_pool_->getActiveTaskCount();
    }
}

void WeightManager::warmupModel(size_t buffer_size_mb) {
    if (!config_.warmup_on_load) {
        return;
    }

    // Use config value if not specified
    if (buffer_size_mb == 0) {
        buffer_size_mb = config_.warmup_buffer_mb;
    }

    if (buffer_size_mb == 0) {
        return;
    }

    std::cerr << "[WeightManager] Warming up " << buffer_size_mb << " MB..."
              << std::endl;

    // Allocate warmup buffer
    size_t buffer_size = buffer_size_mb * 1024 * 1024;
    void* buffer = malloc(buffer_size);

    if (!buffer) {
        std::cerr << "[WeightManager] Failed to allocate warmup buffer" << std::endl;
        return;
    }

    // Touch all pages to bring into physical memory
    size_t page_size = getpagesize();  // 16KB on Apple Silicon
    size_t pages_touched = 0;

    for (size_t offset = 0; offset < buffer_size; offset += page_size) {
        // Volatile read to prevent compiler optimization
        volatile char dummy = *((char*)buffer + offset);
        (void)dummy;
        pages_touched++;
    }

    free(buffer);
    warmup_count_++;

    std::cerr << "[WeightManager] Warmup complete: touched " << pages_touched
              << " pages (" << (pages_touched * page_size / (1024 * 1024))
              << " MB)" << std::endl;
}

id<MTLBuffer> WeightManager::loadWeightsMapped(const std::string& path, id<MTLDevice> device) {
    if (!config_.use_mmap) {
        return nil;
    }

    if (!device) {
        std::cerr << "[WeightManager] Invalid device for mmap loading" << std::endl;
        return nil;
    }

    // Open file
    int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0) {
        std::cerr << "[WeightManager] Failed to open file: " << path
                  << " (" << strerror(errno) << ")" << std::endl;
        return nil;
    }

    // Get file size
    off_t file_size = lseek(fd, 0, SEEK_END);
    if (file_size < 0) {
        std::cerr << "[WeightManager] Failed to get file size: " << path << std::endl;
        close(fd);
        return nil;
    }
    lseek(fd, 0, SEEK_SET);

    if (file_size == 0) {
        std::cerr << "[WeightManager] File is empty: " << path << std::endl;
        close(fd);
        return nil;
    }

    // Memory-map file
    void* mapped = mmap(nullptr, file_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);

    if (mapped == MAP_FAILED) {
        std::cerr << "[WeightManager] mmap failed for " << path
                  << " (" << strerror(errno) << ")" << std::endl;
        return nil;
    }

    // Advise kernel about access pattern (sequential read)
    madvise(mapped, file_size, MADV_SEQUENTIAL);

    // Create Metal buffer from mapped memory (zero-copy)
    id<MTLBuffer> buffer = [device newBufferWithBytesNoCopy:mapped
                                                       length:file_size
                                                      options:MTLResourceStorageModeShared
                                                  deallocator:^(void* pointer, NSUInteger length) {
        // Unmap when buffer is released
        munmap(pointer, length);
    }];

    if (buffer) {
        std::cerr << "[WeightManager] Memory-mapped " << path << " ("
                  << (file_size / (1024 * 1024)) << " MB, zero-copy)" << std::endl;
    } else {
        munmap(mapped, file_size);
        std::cerr << "[WeightManager] Failed to create Metal buffer from mmap" << std::endl;
    }

    return buffer;
}

WeightManagerStatistics WeightManager::getStatistics() const {
    WeightManagerStatistics stats;
    stats.weights_pinned = weights_pinned_.load();
    stats.weights_prefetched = weights_prefetched_.load();
    stats.bytes_pinned = bytes_pinned_.load();
    stats.bytes_prefetched = bytes_prefetched_.load();
    stats.page_faults_before = page_faults_before_.load();
    stats.page_faults_after = page_faults_after_.load();
    stats.warmup_count = warmup_count_.load();
    stats.prefetch_ops = prefetch_ops_.load();
    stats.pin_failures = pin_failures_.load();
    stats.active_prefetch_tasks = active_prefetch_tasks_.load();
    return stats;
}

void WeightManager::resetStatistics() {
    weights_pinned_ = 0;
    weights_prefetched_ = 0;
    bytes_pinned_ = 0;
    bytes_prefetched_ = 0;
    page_faults_before_ = 0;
    page_faults_after_ = 0;
    warmup_count_ = 0;
    prefetch_ops_ = 0;
    pin_failures_ = 0;
    active_prefetch_tasks_ = 0;

    std::cerr << "[WeightManager] Statistics reset" << std::endl;
}

uint32_t WeightManager::getOptimalPrefetchThreads() {
    // Get hardware thread count
    uint32_t hw_threads = std::thread::hardware_concurrency();

    // Use 2-4 threads based on available hardware
    if (hw_threads >= 16) {
        return 4;  // High-end M3 Max/Ultra
    } else if (hw_threads >= 8) {
        return 3;  // M3 Pro
    } else {
        return 2;  // Base M3
    }
}

size_t WeightManager::getMaxPinnableMemory() {
    struct rlimit limit;

    // Get RLIMIT_MEMLOCK (locked memory limit)
    if (getrlimit(RLIMIT_MEMLOCK, &limit) != 0) {
        std::cerr << "[WeightManager] Failed to get RLIMIT_MEMLOCK: "
                  << strerror(errno) << std::endl;
        return 0;
    }

    // RLIM_INFINITY means unlimited
    if (limit.rlim_cur == RLIM_INFINITY) {
        return SIZE_MAX;
    }

    return static_cast<size_t>(limit.rlim_cur);
}

// ============================================================================
// Private Helper Methods
// ============================================================================

bool WeightManager::pinMemory(void* addr, size_t length) {
    if (!addr || length == 0) {
        return false;
    }

    // Use mlock to pin pages in physical memory (prevent swapping)
    int result = mlock(addr, length);

    if (result == 0) {
        // Success
        std::lock_guard<std::mutex> lock(pinned_mutex_);
        pinned_weights_.push_back({addr, length});

        weights_pinned_++;
        bytes_pinned_ += length;

        return true;
    } else {
        // Failure (common causes: EPERM, ENOMEM, EAGAIN)
        pin_failures_++;

        // Only log first few failures to avoid spam
        if (pin_failures_.load() <= 3) {
            std::cerr << "[WeightManager] mlock failed (errno=" << errno
                      << "): " << strerror(errno) << std::endl;

            if (errno == EPERM) {
                std::cerr << "  Hint: Increase locked memory limit with 'ulimit -l unlimited'"
                          << std::endl;
            } else if (errno == ENOMEM || errno == EAGAIN) {
                std::cerr << "  Hint: Not enough memory to pin. Consider reducing critical_layers"
                          << std::endl;
            }
        }

        return false;
    }
}

void WeightManager::unpinMemory(void* addr, size_t length) {
    if (!addr || length == 0) {
        return;
    }

    // Use munlock to unpin pages
    int result = munlock(addr, length);

    if (result != 0) {
        // Non-fatal warning
        if (pin_failures_.load() <= 3) {  // Limit log spam
            std::cerr << "[WeightManager] munlock failed: " << strerror(errno)
                      << std::endl;
        }
    }
}

void WeightManager::touchPages(id<MTLBuffer> buffer) {
    if (!buffer) {
        return;
    }

    void* ptr = [buffer contents];
    size_t length = [buffer length];

    if (!ptr || length == 0) {
        return;
    }

    // Touch every page to trigger page-in
    size_t page_size = getpagesize();  // 16KB on Apple Silicon

    for (size_t offset = 0; offset < length; offset += page_size) {
        // Volatile read to prevent compiler optimization
        volatile char dummy = *((char*)ptr + offset);
        (void)dummy;
    }
}

void WeightManager::prefetchAsync(id<MTLBuffer> buffer) {
    if (!thread_pool_ || !buffer) {
        return;
    }

    // Retain buffer for async access (ARC management)
    id<MTLBuffer> retained_buffer = buffer;

    // Enqueue prefetch task
    thread_pool_->enqueue([this, retained_buffer]() {
        this->touchPages(retained_buffer);
        this->prefetch_ops_++;
    });
}

bool WeightManager::withinMemoryLimits(size_t additional_bytes) const {
    // No limit configured
    if (config_.max_pinned_mb == 0) {
        return true;
    }

    // Check against configured limit
    size_t max_bytes = config_.max_pinned_mb * 1024 * 1024;
    size_t current_bytes = bytes_pinned_.load();

    if (current_bytes + additional_bytes > max_bytes) {
        return false;
    }

    // Also check against system limit
    size_t system_max = getMaxPinnableMemory();
    if (system_max > 0 && system_max != SIZE_MAX) {
        if (current_bytes + additional_bytes > system_max) {
            return false;
        }
    }

    return true;
}

} // namespace krserve
