cmake_minimum_required(VERSION 3.15)
project(krserve_native VERSION 1.0.0 LANGUAGES CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Build options
option(BUILD_TESTS "Build test suite" ON)
option(BUILD_BENCHMARKS "Build benchmarks" ON)
option(ENABLE_ASAN "Enable AddressSanitizer for debugging" OFF)

# Find Python
find_package(Python3 COMPONENTS Interpreter Development REQUIRED)

# Find pybind11
execute_process(
    COMMAND ${Python3_EXECUTABLE} -c "import pybind11; print(pybind11.get_cmake_dir())"
    OUTPUT_VARIABLE PYBIND11_CMAKE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
list(APPEND CMAKE_PREFIX_PATH "${PYBIND11_CMAKE_DIR}")
find_package(pybind11 CONFIG REQUIRED)

# Metal and Foundation frameworks
find_library(METAL_LIBRARY Metal REQUIRED)
find_library(FOUNDATION_LIBRARY Foundation REQUIRED)
find_library(COREGRAPHICS_LIBRARY CoreGraphics REQUIRED)
find_library(ACCELERATE_LIBRARY Accelerate REQUIRED)

# OpenMP support (optional - graceful fallback if unavailable)
find_package(OpenMP)
if(OpenMP_CXX_FOUND)
    message(STATUS "OpenMP: Found (${OpenMP_CXX_VERSION})")
    set(HAS_OPENMP TRUE)
else()
    message(STATUS "OpenMP: Not found (parallel tokenizer will use fallback)")
    set(HAS_OPENMP FALSE)
endif()

message(STATUS "Python: ${Python3_EXECUTABLE}")
message(STATUS "Python version: ${Python3_VERSION}")
message(STATUS "Pybind11: ${pybind11_VERSION}")
message(STATUS "Metal: ${METAL_LIBRARY}")

# Source files (will add as we implement)
set(NATIVE_SOURCES
    src/command_buffer_pool.mm
    src/kr_metal_memory_pool.mm
    src/kr_command_buffer_ring.mm
    src/kr_blit_queue.mm
    src/kr_weight_manager.mm
    src/metrics_collector.cpp
    src/utils.cpp
    src/kr_parallel_tokenizer.cpp
)

# Python module
pybind11_add_module(krserve_native
    bindings/python_bindings.cpp
    bindings/metal_pool_bindings.cpp
    bindings/command_buffer_ring_bindings.cpp
    bindings/blit_queue_bindings.cpp
    bindings/parallel_tokenizer_bindings.cpp
    bindings/weight_manager_bindings.mm
    ${NATIVE_SOURCES}
)

target_include_directories(krserve_native PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(krserve_native PRIVATE
    ${METAL_LIBRARY}
    ${FOUNDATION_LIBRARY}
    ${COREGRAPHICS_LIBRARY}
    ${ACCELERATE_LIBRARY}
)

# Link OpenMP if available
if(OpenMP_CXX_FOUND)
    target_link_libraries(krserve_native PRIVATE OpenMP::OpenMP_CXX)
    target_compile_definitions(krserve_native PRIVATE HAS_OPENMP=1)
endif()

# Enable ARC (Automatic Reference Counting) for Objective-C++
set_source_files_properties(
    src/command_buffer_pool.mm
    src/kr_metal_memory_pool.mm
    src/kr_command_buffer_ring.mm
    src/kr_blit_queue.mm
    src/kr_weight_manager.mm
    bindings/weight_manager_bindings.mm
    PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
)

# Compiler flags
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(krserve_native PRIVATE
        -Wall -Wextra -Wpedantic
        -Wno-unused-parameter
        -g -O0
    )
    if(ENABLE_ASAN)
        target_compile_options(krserve_native PRIVATE -fsanitize=address)
        target_link_options(krserve_native PRIVATE -fsanitize=address)
    endif()
else()
    target_compile_options(krserve_native PRIVATE
        -O3 -DNDEBUG
        -flto
    )
endif()

# Install
install(TARGETS krserve_native
    LIBRARY DESTINATION ${Python3_SITELIB}
)

# Tests
if(BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# Benchmarks
if(BUILD_BENCHMARKS)
    add_subdirectory(benchmarks)
endif()
