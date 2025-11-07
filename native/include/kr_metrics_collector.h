#pragma once

#include <cstdint>
#include <atomic>
#include <vector>
#include <mutex>

namespace krserve {

/**
 * High-performance metrics collector
 *
 * Thread-safe lock-free counters with periodic statistical aggregation.
 */
class MetricsCollector {
public:
    MetricsCollector();
    ~MetricsCollector();

    /**
     * Record the start of a request
     */
    void recordRequest();

    /**
     * Record successful completion with latency
     * @param latency_ms Latency in milliseconds
     */
    void recordCompletion(double latency_ms);

    /**
     * Record a failure
     */
    void recordFailure();

    /**
     * Current metrics snapshot
     */
    struct Metrics {
        uint64_t total_requests;
        uint64_t completed_requests;
        uint64_t failed_requests;
        double avg_latency_ms;
        double p50_latency_ms;
        double p95_latency_ms;
        double p99_latency_ms;
        double throughput_rps;
    };

    /**
     * Get current metrics (computed on-demand)
     */
    Metrics getMetrics() const;

    /**
     * Reset all counters
     */
    void reset();

private:
    std::atomic<uint64_t> total_requests_{0};
    std::atomic<uint64_t> completed_requests_{0};
    std::atomic<uint64_t> failed_requests_{0};
    std::atomic<uint64_t> sum_latency_ns_{0};  // Use nanoseconds for precision

    // Latency samples for percentile calculation
    mutable std::mutex samples_mutex_;
    std::vector<double> latency_samples_;
    static constexpr size_t MAX_SAMPLES = 1000;

    // Throughput calculation
    mutable std::mutex throughput_mutex_;
    uint64_t throughput_window_start_ns_;
    uint64_t throughput_requests_;
};

} // namespace krserve
