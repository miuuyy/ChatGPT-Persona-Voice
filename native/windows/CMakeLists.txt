cmake_minimum_required(VERSION 3.20)

project(codex_persona_voice_windows_helpers LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

function(cpv_windows_helper target source)
  add_executable(${target} ${source})
  target_compile_definitions(${target} PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
  target_link_libraries(${target} PRIVATE avrt mmdevapi ole32 propsys runtimeobject uuid)
endfunction()

cpv_windows_helper(cpv-audio-capture ProcessLoopbackCapture.cpp)
cpv_windows_helper(cpv-audio-output WasapiOutput.cpp)
cpv_windows_helper(cpv-audio-route AudioPolicyRoute.cpp)
cpv_windows_helper(cpv-windows-audio-common-test WindowsAudioCommonTest.cpp)
