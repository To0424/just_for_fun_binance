cmake_minimum_required(VERSION 3.14)
project(binance_api VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PostgreSQL REQUIRED)
find_package(Threads REQUIRED)

include(FetchContent)

# nlohmann/json
FetchContent_Declare(
    json
    URL https://github.com/nlohmann/json/archive/refs/tags/v3.11.3.tar.gz
)

# cpp-httplib (header-only HTTP server)
FetchContent_Declare(
    httplib
    URL https://github.com/yhirose/cpp-httplib/archive/refs/tags/v0.15.3.tar.gz
)

FetchContent_MakeAvailable(json httplib)

add_executable(api_server src/main.cpp)

target_link_libraries(api_server PRIVATE
    PostgreSQL::PostgreSQL
    nlohmann_json::nlohmann_json
    httplib::httplib
    Threads::Threads
)
