#include "../include/kr_metrics_collector.h"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace krserve {

using namespace std::chrono;

MetricsCollector::MetricsCollector()
    : latency_samples_()
    , throughput_window_start_ns_(duration_cast<nanoseconds>(
          system_clock::now().time_since_epoch()).count())
    , throughput_requests_(0)
{
    latency_samples_.reserve(MAX_SAMPLES);
}

MetricsCollector::~MetricsCollector() = default;

void MetricsCollector::recordRequest() {
    total_requests_.fetch_add(1, std::memory_order_relaxed);
}

void MetricsCollector::recordCompletion(double latency_ms) {
    completed_requests_.fetch_add(1, std::memory_order_relaxed);

    // Convert to nanoseconds for precision
    uint64_t latency_ns = static_cast<uint64_t>(latency_ms * 1000000.0);
    sum_latency_ns_.fetch_add(latency_ns, std::memory_order_relaxed);

    // Store sample for percentile calculation
    {
        std::lock_guard<std::mutex> lock(samples_mutex_);
        latency_samples_.push_back(latency_ms);

        // Keep only recent samples (rolling window)
        if (latency_samples_.size() > MAX_SAMPLES) {
            latency_samples_.erase(latency_samples_.begin());
        }
    }

    // Update throughput counter
    {
        std::lock_guard<std::mutex> lock(throughput_mutex_);
        throughput_requests_++;
    }
}

void MetricsCollector::recordFailure() {
    failed_requests_.fetch_add(1, std::memory_order_relaxed);
}

MetricsCollector::Metrics MetricsCollector::getMetrics() const {
    Metrics m;

    m.total_requests = total_requests_.load(std::memory_order_relaxed);
    m.completed_requests = completed_requests_.load(std::memory_order_relaxed);
    m.failed_requests = failed_requests_.load(std::memory_order_relaxed);

    // Calculate average latency
    if (m.completed_requests > 0) {
        uint64_t sum_ns = sum_latency_ns_.load(std::memory_order_relaxed);
        m.avg_latency_ms = static_cast<double>(sum_ns) / 1000000.0 / m.completed_requests;
    } else {
        m.avg_latency_ms = 0.0;
    }

    // Calculate percentiles
    {
        std::lock_guard<std::mutex> lock(samples_mutex_);

        if (!latency_samples_.empty()) {
            std::vector<double> sorted = latency_samples_;
            std::sort(sorted.begin(), sorted.end());

            auto percentile = [&sorted](double p) -> double {
                size_t idx = static_cast<size_t>(sorted.size() * p);
                if (idx >= sorted.size()) idx = sorted.size() - 1;
                return sorted[idx];
            };

            m.p50_latency_ms = percentile(0.50);
            m.p95_latency_ms = percentile(0.95);
            m.p99_latency_ms = percentile(0.99);
        } else {
            m.p50_latency_ms = 0.0;
            m.p95_latency_ms = 0.0;
            m.p99_latency_ms = 0.0;
        }
    }

    // Calculate throughput (requests per second)
    {
        std::lock_guard<std::mutex> lock(throughput_mutex_);

        uint64_t now_ns = duration_cast<nanoseconds>(
            system_clock::now().time_since_epoch()).count();

        double window_sec = static_cast<double>(now_ns - throughput_window_start_ns_) / 1e9;

        if (window_sec > 0.0) {
            m.throughput_rps = throughput_requests_ / window_sec;
        } else {
            m.throughput_rps = 0.0;
        }
    }

    return m;
}

void MetricsCollector::reset() {
    total_requests_.store(0, std::memory_order_relaxed);
    completed_requests_.store(0, std::memory_order_relaxed);
    failed_requests_.store(0, std::memory_order_relaxed);
    sum_latency_ns_.store(0, std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> lock(samples_mutex_);
        latency_samples_.clear();
    }

    {
        std::lock_guard<std::mutex> lock(throughput_mutex_);
        throughput_window_start_ns_ = duration_cast<nanoseconds>(
            system_clock::now().time_since_epoch()).count();
        throughput_requests_ = 0;
    }
}

} // namespace krserve
