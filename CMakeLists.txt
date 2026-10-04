cmake_minimum_required(VERSION 3.25)

if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Build type" FORCE)
endif ()

project(melee-web LANGUAGES C CXX)

# This fork builds one target: the web app (Emscripten + WebGPU). Build it with
# tools/browser/bundle.py (or tools/browser/build.py for the engine alone);
# the native platforms live upstream, in 999sian/melee-pc.
if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "This repository builds only the browser target. Run "
        "python3 tools/browser/bundle.py /path/to/your/melee.iso (see README.md).")
endif ()

# The simulation builds at -O2: -O3 vectorises float reductions differently,
# and netplay needs identical bits on both peers.
set(CMAKE_C_FLAGS_RELEASE "-O2 -DNDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O2 -DNDEBUG")

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_COLOR_DIAGNOSTICS ON)

add_subdirectory(platforms/browser)
