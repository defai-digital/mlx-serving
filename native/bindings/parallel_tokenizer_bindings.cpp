#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/functional.h>

#include "../include/kr_parallel_tokenizer.h"

namespace py = pybind11;
using namespace krserve;

void bind_parallel_tokenizer(py::module& m) {
    // ParallelTokenizerConfig
    py::class_<ParallelTokenizerConfig>(m, "ParallelTokenizerConfig",
        R"doc(
        Configuration for CPU-parallelized tokenizer.

        Attributes:
            num_threads (int): Number of OpenMP threads for parallel processing (default: 8)
            use_accelerate (bool): Use Apple Accelerate framework for SIMD operations (default: True)
            batch_mode (bool): Enable batch processing mode (default: True)
            thread_pool_size (int): Thread pool size for async operations (default: 4)
            min_chunk_size (int): Minimum chunk size for parallel processing in bytes (default: 1024)
            enable_stats (bool): Enable statistics collection (default: True)

        Example:
            >>> config = ParallelTokenizerConfig()
            >>> config.num_threads = 16
            >>> config.use_accelerate = True
            >>> tokenizer = ParallelTokenizer(config)
        )doc")
        .def(py::init<>())
        .def_readwrite("num_threads", &ParallelTokenizerConfig::num_threads,
            "Number of OpenMP threads for parallel processing")
        .def_readwrite("use_accelerate", &ParallelTokenizerConfig::use_accelerate,
            "Use Apple Accelerate framework for SIMD operations")
        .def_readwrite("batch_mode", &ParallelTokenizerConfig::batch_mode,
            "Enable batch processing mode")
        .def_readwrite("thread_pool_size", &ParallelTokenizerConfig::thread_pool_size,
            "Thread pool size for async operations")
        .def_readwrite("min_chunk_size", &ParallelTokenizerConfig::min_chunk_size,
            "Minimum chunk size for parallel processing (bytes)")
        .def_readwrite("enable_stats", &ParallelTokenizerConfig::enable_stats,
            "Enable statistics collection")
        .def("__repr__", [](const ParallelTokenizerConfig& c) {
            return "ParallelTokenizerConfig(num_threads=" + std::to_string(c.num_threads) +
                   ", use_accelerate=" + (c.use_accelerate ? "True" : "False") +
                   ", batch_mode=" + (c.batch_mode ? "True" : "False") +
                   ", thread_pool_size=" + std::to_string(c.thread_pool_size) +
                   ", min_chunk_size=" + std::to_string(c.min_chunk_size) +
                   ", enable_stats=" + (c.enable_stats ? "True" : "False") + ")";
        });

    // ParallelTokenizerStatistics
    py::class_<ParallelTokenizerStatistics>(m, "ParallelTokenizerStatistics",
        R"doc(
        Statistics for parallel tokenizer performance tracking.

        Attributes:
            total_encodes (int): Total number of single encode operations
            total_batch_encodes (int): Total number of batch encode operations
            total_tokens (int): Total tokens processed
            total_bytes (int): Total bytes processed
            total_encode_time_us (int): Total encoding time in microseconds
            speedup_ratio (float): Speedup ratio compared to serial processing
            active_threads (int): Number of active OpenMP threads
            accelerate_ops (int): Number of Apple Accelerate operations used

        Methods:
            get_tokens_per_second(): Returns average tokens per second
            get_avg_encode_time_us(): Returns average encoding time per operation (microseconds)
            get_avg_tokens_per_op(): Returns average tokens per operation
            to_dict(): Returns statistics as a dictionary

        Example:
            >>> stats = tokenizer.get_statistics()
            >>> print(f"Throughput: {stats.get_tokens_per_second():.2f} tok/s")
            >>> print(f"Speedup: {stats.speedup_ratio:.2f}x")
        )doc")
        .def(py::init<>())
        .def_readonly("total_encodes", &ParallelTokenizerStatistics::total_encodes,
            "Total number of single encode operations")
        .def_readonly("total_batch_encodes", &ParallelTokenizerStatistics::total_batch_encodes,
            "Total number of batch encode operations")
        .def_readonly("total_tokens", &ParallelTokenizerStatistics::total_tokens,
            "Total tokens processed")
        .def_readonly("total_bytes", &ParallelTokenizerStatistics::total_bytes,
            "Total bytes processed")
        .def_readonly("total_encode_time_us", &ParallelTokenizerStatistics::total_encode_time_us,
            "Total encoding time (microseconds)")
        .def_readonly("speedup_ratio", &ParallelTokenizerStatistics::speedup_ratio,
            "Speedup ratio compared to serial processing")
        .def_readonly("active_threads", &ParallelTokenizerStatistics::active_threads,
            "Number of active OpenMP threads")
        .def_readonly("accelerate_ops", &ParallelTokenizerStatistics::accelerate_ops,
            "Number of Apple Accelerate operations used")
        .def("get_tokens_per_second", &ParallelTokenizerStatistics::getTokensPerSecond,
            "Get average tokens per second")
        .def("get_avg_encode_time_us", &ParallelTokenizerStatistics::getAvgEncodeTimeUs,
            "Get average encoding time per operation (microseconds)")
        .def("get_avg_tokens_per_op", &ParallelTokenizerStatistics::getAvgTokensPerOp,
            "Get average tokens per operation")
        .def("to_dict", [](const ParallelTokenizerStatistics& s) {
            py::dict d;
            d["total_encodes"] = s.total_encodes;
            d["total_batch_encodes"] = s.total_batch_encodes;
            d["total_tokens"] = s.total_tokens;
            d["total_bytes"] = s.total_bytes;
            d["total_encode_time_us"] = s.total_encode_time_us;
            d["tokens_per_second"] = s.getTokensPerSecond();
            d["avg_encode_time_us"] = s.getAvgEncodeTimeUs();
            d["avg_tokens_per_op"] = s.getAvgTokensPerOp();
            d["speedup_ratio"] = s.speedup_ratio;
            d["active_threads"] = s.active_threads;
            d["accelerate_ops"] = s.accelerate_ops;
            return d;
        }, "Convert statistics to dictionary")
        .def("__repr__", [](const ParallelTokenizerStatistics& s) {
            return "ParallelTokenizerStatistics(total_encodes=" + std::to_string(s.total_encodes) +
                   ", total_tokens=" + std::to_string(s.total_tokens) +
                   ", tokens_per_second=" + std::to_string(s.getTokensPerSecond()) +
                   ", speedup_ratio=" + std::to_string(s.speedup_ratio) + "x)";
        });

    // ParallelTokenizer
    py::class_<ParallelTokenizer>(m, "ParallelTokenizer",
        R"doc(
        CPU-Parallelized Tokenizer with OpenMP and Apple Accelerate.

        High-performance text tokenization using:
        - OpenMP multi-threading for parallel chunk processing
        - Apple Accelerate framework for SIMD string operations
        - Thread pool for asynchronous batch operations
        - Lock-free statistics tracking

        Performance targets:
        - Single request: -60% tokenization time
        - Batch (10 requests): -70% total time
        - Concurrent load: +15-20% throughput

        Args:
            config (ParallelTokenizerConfig): Configuration options

        Example:
            >>> # Single text encoding
            >>> def my_tokenizer(text: str) -> list[int]:
            ...     # Your tokenization logic here
            ...     return [1, 2, 3, 4, 5]
            ...
            >>> tokenizer = ParallelTokenizer()
            >>> tokens = tokenizer.encode("Hello world", my_tokenizer)
            >>> print(f"Tokens: {tokens}")

            >>> # Batch encoding
            >>> texts = ["Hello", "World", "Test"]
            >>> batch_tokens = tokenizer.encode_batch(texts, my_tokenizer)
            >>> print(f"Batch: {len(batch_tokens)} results")

            >>> # Async encoding
            >>> future = tokenizer.encode_async("Hello world", my_tokenizer)
            >>> # Do other work...
            >>> tokens = future.get()  # Wait for result

            >>> # Check statistics
            >>> stats = tokenizer.get_statistics()
            >>> print(f"Throughput: {stats.get_tokens_per_second():.2f} tok/s")
            >>> print(f"Speedup: {stats.speedup_ratio:.2f}x")

        See Also:
            ParallelTokenizerConfig: Configuration options
            ParallelTokenizerStatistics: Performance statistics
        )doc")
        .def(py::init<const ParallelTokenizerConfig&>(),
             py::arg("config") = ParallelTokenizerConfig{},
             "Create a parallel tokenizer with configuration")

        .def("encode",
             &ParallelTokenizer::encode,
             py::arg("text"),
             py::arg("tokenizer_fn"),
             R"doc(
             Encode a single text string to token IDs.

             Uses OpenMP parallel processing for large strings (>min_chunk_size).
             Falls back to serial processing for small strings.

             Args:
                 text (str): Input text to tokenize
                 tokenizer_fn (callable): Tokenization function that converts substring to token IDs
                     Signature: (str) -> list[int]

             Returns:
                 list[int]: Vector of token IDs

             Example:
                 >>> def my_tokenizer(text: str) -> list[int]:
                 ...     return [ord(c) for c in text]  # Simple char-to-int
                 >>> tokens = tokenizer.encode("Hello", my_tokenizer)
                 >>> print(tokens)  # [72, 101, 108, 108, 111]

             Note:
                 For texts larger than min_chunk_size * num_threads, the text is split into
                 chunks and processed in parallel. UTF-8 boundaries are respected.
             )doc")

        .def("encode_batch",
             &ParallelTokenizer::encodeBatch,
             py::arg("texts"),
             py::arg("tokenizer_fn"),
             R"doc(
             Encode a batch of text strings in parallel.

             Uses thread pool to process multiple strings concurrently.
             Each string may be further parallelized with OpenMP if large enough.

             Args:
                 texts (list[str]): Input texts to tokenize
                 tokenizer_fn (callable): Tokenization function that converts substring to token IDs
                     Signature: (str) -> list[int]

             Returns:
                 list[list[int]]: List of token ID vectors (one per input text)

             Example:
                 >>> def my_tokenizer(text: str) -> list[int]:
                 ...     return [ord(c) for c in text]
                 >>> texts = ["Hello", "World"]
                 >>> batch_tokens = tokenizer.encode_batch(texts, my_tokenizer)
                 >>> print(len(batch_tokens))  # 2
                 >>> print(batch_tokens[0])    # [72, 101, 108, 108, 111]

             Note:
                 Optimal for batches of 3+ texts. For smaller batches, consider using
                 encode() directly for each text.
             )doc")

        .def("encode_async",
             [](ParallelTokenizer& self,
                const std::string& text,
                const std::function<std::vector<uint32_t>(const std::string&)>& tokenizer_fn) {
                 // Python can't directly use std::future, so we wrap in a blocking call
                 auto future = self.encodeAsync(text, tokenizer_fn);
                 return future.get();
             },
             py::arg("text"),
             py::arg("tokenizer_fn"),
             py::call_guard<py::gil_scoped_release>(),  // Release GIL during processing
             R"doc(
             Asynchronous encode operation (blocking in Python).

             Note: Due to Python GIL limitations, this method blocks but releases the GIL
             during processing, allowing other Python threads to run.

             Args:
                 text (str): Input text to tokenize
                 tokenizer_fn (callable): Tokenization function
                     Signature: (str) -> list[int]

             Returns:
                 list[int]: Vector of token IDs

             Example:
                 >>> tokens = tokenizer.encode_async("Hello world", my_tokenizer)
                 >>> print(tokens)
             )doc")

        .def("get_statistics",
             &ParallelTokenizer::getStatistics,
             "Get current performance statistics")

        .def("reset_statistics",
             &ParallelTokenizer::resetStatistics,
             "Reset all statistics counters to zero")

        .def("get_config",
             &ParallelTokenizer::getConfig,
             "Get current configuration")

        .def_static("is_openmp_available",
                    &ParallelTokenizer::isOpenMPAvailable,
                    R"doc(
                    Check if OpenMP is available.

                    Returns:
                        bool: True if OpenMP is compiled in and available

                    Example:
                        >>> if ParallelTokenizer.is_openmp_available():
                        ...     print("OpenMP acceleration enabled")
                    )doc")

        .def_static("is_accelerate_available",
                    &ParallelTokenizer::isAccelerateAvailable,
                    R"doc(
                    Check if Apple Accelerate framework is available.

                    Returns:
                        bool: True if Apple Accelerate is available (macOS only)

                    Example:
                        >>> if ParallelTokenizer.is_accelerate_available():
                        ...     print("SIMD acceleration enabled")
                    )doc")

        .def_static("get_optimal_thread_count",
                    &ParallelTokenizer::getOptimalThreadCount,
                    R"doc(
                    Get optimal thread count for current hardware.

                    Returns:
                        int: Recommended number of threads (75% of hardware threads, clamped to [1, 16])

                    Example:
                        >>> optimal = ParallelTokenizer.get_optimal_thread_count()
                        >>> config = ParallelTokenizerConfig()
                        >>> config.num_threads = optimal
                    )doc")

        .def("__repr__", [](const ParallelTokenizer& t) {
            const auto& config = t.getConfig();
            auto stats = t.getStatistics();
            return "ParallelTokenizer(threads=" + std::to_string(config.num_threads) +
                   ", accelerate=" + (config.use_accelerate ? "enabled" : "disabled") +
                   ", total_ops=" + std::to_string(stats.total_encodes + stats.total_batch_encodes) +
                   ", speedup=" + std::to_string(stats.speedup_ratio) + "x)";
        });
}
