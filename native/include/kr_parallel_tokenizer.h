#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <atomic>
#include <memory>
#include <functional>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <future>

namespace krserve {

/**
 * Configuration for parallel tokenizer
 */
struct ParallelTokenizerConfig {
    // Number of OpenMP threads for parallel processing
    uint32_t num_threads = 8;

    // Use Apple Accelerate framework for SIMD operations
    bool use_accelerate = true;

    // Batch processing mode
    bool batch_mode = true;

    // Thread pool size for async operations
    uint32_t thread_pool_size = 4;

    // Minimum chunk size for parallel processing (bytes)
    size_t min_chunk_size = 1024;

    // Enable statistics collection
    bool enable_stats = true;
};

/**
 * Statistics for parallel tokenizer performance
 */
struct ParallelTokenizerStatistics {
    // Total number of encode operations
    uint64_t total_encodes = 0;

    // Total number of batch encode operations
    uint64_t total_batch_encodes = 0;

    // Total tokens processed
    uint64_t total_tokens = 0;

    // Total bytes processed
    uint64_t total_bytes = 0;

    // Total encoding time (microseconds)
    uint64_t total_encode_time_us = 0;

    // Average tokens per second
    double getTokensPerSecond() const {
        if (total_encode_time_us == 0) return 0.0;
        return (static_cast<double>(total_tokens) * 1000000.0) / total_encode_time_us;
    }

    // Average encoding time per operation (microseconds)
    double getAvgEncodeTimeUs() const {
        uint64_t ops = total_encodes + total_batch_encodes;
        if (ops == 0) return 0.0;
        return static_cast<double>(total_encode_time_us) / ops;
    }

    // Average tokens per operation
    double getAvgTokensPerOp() const {
        uint64_t ops = total_encodes + total_batch_encodes;
        if (ops == 0) return 0.0;
        return static_cast<double>(total_tokens) / ops;
    }

    // Speedup ratio compared to serial processing
    double speedup_ratio = 1.0;

    // OpenMP active threads
    uint32_t active_threads = 0;

    // Accelerate framework usage
    uint64_t accelerate_ops = 0;
};

/**
 * Thread pool task
 */
struct TokenizerTask {
    std::function<void()> task;
    std::promise<void> promise;
};

/**
 * CPU-Parallelized Tokenizer
 *
 * High-performance text tokenization using:
 * - OpenMP multi-threading for parallel chunk processing
 * - Apple Accelerate framework for SIMD string operations
 * - Thread pool for asynchronous batch operations
 * - Lock-free statistics tracking
 *
 * Performance targets:
 * - Single request: -60% tokenization time
 * - Batch (10 requests): -70% total time
 * - Concurrent load: +15-20% throughput
 */
class ParallelTokenizer {
public:
    /**
     * Create a parallel tokenizer
     * @param config Configuration options
     */
    explicit ParallelTokenizer(const ParallelTokenizerConfig& config = ParallelTokenizerConfig{});

    /**
     * Destructor - cleanup thread pool
     */
    ~ParallelTokenizer();

    // Disable copy
    ParallelTokenizer(const ParallelTokenizer&) = delete;
    ParallelTokenizer& operator=(const ParallelTokenizer&) = delete;

    /**
     * Encode a single text string to token IDs
     *
     * Uses OpenMP parallel processing for large strings (>min_chunk_size).
     * Falls back to serial processing for small strings.
     *
     * @param text Input text to tokenize
     * @param tokenizer_fn Tokenization function (converts substring to tokens)
     * @return Vector of token IDs
     */
    std::vector<uint32_t> encode(
        const std::string& text,
        const std::function<std::vector<uint32_t>(const std::string&)>& tokenizer_fn
    );

    /**
     * Encode a batch of text strings in parallel
     *
     * Uses thread pool to process multiple strings concurrently.
     * Each string may be further parallelized with OpenMP if large enough.
     *
     * @param texts Input texts to tokenize
     * @param tokenizer_fn Tokenization function (converts substring to tokens)
     * @return Vector of token ID vectors (one per input text)
     */
    std::vector<std::vector<uint32_t>> encodeBatch(
        const std::vector<std::string>& texts,
        const std::function<std::vector<uint32_t>(const std::string&)>& tokenizer_fn
    );

    /**
     * Asynchronous encode operation
     *
     * Returns immediately and processes in background thread pool.
     *
     * @param text Input text to tokenize
     * @param tokenizer_fn Tokenization function
     * @return Future that will contain token IDs when complete
     */
    std::future<std::vector<uint32_t>> encodeAsync(
        const std::string& text,
        const std::function<std::vector<uint32_t>(const std::string&)>& tokenizer_fn
    );

    /**
     * Get current statistics
     */
    ParallelTokenizerStatistics getStatistics() const;

    /**
     * Reset statistics counters
     */
    void resetStatistics();

    /**
     * Get configuration
     */
    const ParallelTokenizerConfig& getConfig() const { return config_; }

    /**
     * Check if OpenMP is available
     */
    static bool isOpenMPAvailable();

    /**
     * Check if Apple Accelerate is available
     */
    static bool isAccelerateAvailable();

    /**
     * Get optimal thread count for current hardware
     */
    static uint32_t getOptimalThreadCount();

private:
    // Configuration
    ParallelTokenizerConfig config_;

    // Statistics (atomics for thread-safe updates)
    mutable std::atomic<uint64_t> total_encodes_{0};
    mutable std::atomic<uint64_t> total_batch_encodes_{0};
    mutable std::atomic<uint64_t> total_tokens_{0};
    mutable std::atomic<uint64_t> total_bytes_{0};
    mutable std::atomic<uint64_t> total_encode_time_us_{0};
    mutable std::atomic<double> speedup_ratio_{1.0};
    mutable std::atomic<uint32_t> active_threads_{0};
    mutable std::atomic<uint64_t> accelerate_ops_{0};

    // Thread pool for async operations
    std::vector<std::thread> thread_pool_;
    std::queue<TokenizerTask> task_queue_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    std::atomic<bool> shutdown_{false};

    /**
     * Thread pool worker function
     */
    void workerThread();

    /**
     * Submit task to thread pool
     */
    std::future<void> submitTask(std::function<void()> task);

    /**
     * Split text into chunks for parallel processing
     * Ensures UTF-8 boundaries are respected
     */
    std::vector<std::string> splitIntoChunks(const std::string& text, size_t num_chunks) const;

    /**
     * Merge token vectors from parallel chunks
     */
    std::vector<uint32_t> mergeTokens(const std::vector<std::vector<uint32_t>>& chunks) const;

    /**
     * Use Apple Accelerate for fast string operations
     * (e.g., memcpy, string search, etc.)
     */
    void accelerateStringOp(const char* src, char* dst, size_t len) const;

    /**
     * Record encoding operation timing
     */
    void recordTiming(uint64_t start_time_us, size_t num_tokens, size_t num_bytes);
};

} // namespace krserve
