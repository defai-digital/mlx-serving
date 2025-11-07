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

message(STATUS "Python: ${Python3_EXECUTABLE}")
message(STATUS "Python version: ${Python3_VERSION}")
message(STATUS "Pybind11: ${pybind11_VERSION}")
message(STATUS "Metal: ${METAL_LIBRARY}")

# Source files (will add as we implement)
set(NATIVE_SOURCES
    src/command_buffer_pool.mm
    src/metrics_collector.cpp
    src/utils.cpp
)

# Python module
pybind11_add_module(krserve_native
    bindings/python_bindings.cpp
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
)

# Enable ARC (Automatic Reference Counting) for Objective-C++
set_source_files_properties(
    src/command_buffer_pool.mm
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
