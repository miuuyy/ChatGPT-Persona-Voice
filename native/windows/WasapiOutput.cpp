#include "WindowsAudioCommon.hpp"

#include <avrt.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

using cpv::windows::ComPtr;
using cpv::windows::ScopedHandle;

constexpr std::uint32_t kMaximumFrameDurationMs = 80;
constexpr std::uint32_t kConvertedStartupPrebufferMs = 500;
constexpr std::uint32_t kConvertedQueueCapacityMs = 1'500;
constexpr std::uint32_t kPassthroughStartupPrebufferMs = 40;
constexpr std::uint32_t kPassthroughQueueCapacityMs = 250;

enum class OutputMode { Converted, Passthrough };

struct OutputBounds {
  std::uint32_t startupPrebufferMs;
  std::uint32_t queueCapacityMs;
};

OutputBounds boundsFor(OutputMode mode) {
  return mode == OutputMode::Passthrough
      ? OutputBounds{kPassthroughStartupPrebufferMs, kPassthroughQueueCapacityMs}
      : OutputBounds{kConvertedStartupPrebufferMs, kConvertedQueueCapacityMs};
}

std::string_view nameFor(OutputMode mode) {
  return mode == OutputMode::Passthrough ? "passthrough" : "converted";
}

std::atomic<bool> stopRequested{false};
HANDLE stopEvent = nullptr;

BOOL WINAPI consoleControlHandler(DWORD controlType) {
  switch (controlType) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT:
      stopRequested.store(true, std::memory_order_release);
      if (stopEvent != nullptr) SetEvent(stopEvent);
      return TRUE;
    default:
      return FALSE;
  }
}

struct AudioChunk {
  std::vector<float> samples;
  std::size_t offsetSamples{0};
};

class BoundedAudioQueue {
 public:
  BoundedAudioQueue(std::uint32_t sampleRate, std::uint16_t channels,
                    OutputBounds bounds)
      : channels_(channels),
        startupPrebufferMs_(bounds.startupPrebufferMs),
        startupFrames_(static_cast<std::size_t>(sampleRate) * bounds.startupPrebufferMs / 1000),
        capacityFrames_(static_cast<std::size_t>(sampleRate) * bounds.queueCapacityMs / 1000) {}

  bool push(std::vector<float> samples, std::uint32_t frames) {
    if (frames == 0 || samples.size() != static_cast<std::size_t>(frames) * channels_ ||
        frames > capacityFrames_) {
      setError("The converted-audio frame is outside the bounded Windows output queue");
      return false;
    }
    std::unique_lock lock(mutex_);
    spaceAvailable_.wait(lock, [&] {
      return stopping_ || queuedFrames_ + frames <= capacityFrames_;
    });
    if (stopping_) return false;
    if (!firstInputAt_.has_value()) firstInputAt_ = std::chrono::steady_clock::now();
    chunks_.push_back(AudioChunk{std::move(samples), 0});
    queuedFrames_ += frames;
    dataAvailable_.notify_all();
    return true;
  }

  void finish() {
    std::lock_guard lock(mutex_);
    inputEnded_ = true;
    dataAvailable_.notify_all();
  }

  void setError(std::string message) {
    std::lock_guard lock(mutex_);
    if (error_.empty()) error_ = std::move(message);
    inputEnded_ = true;
    stopping_ = true;
    dataAvailable_.notify_all();
    spaceAvailable_.notify_all();
  }

  bool waitForStartup() {
    std::unique_lock lock(mutex_);
    while (error_.empty() && !stopping_ && !inputEnded_ && queuedFrames_ < startupFrames_) {
      if (!firstInputAt_.has_value()) {
        dataAvailable_.wait(lock);
      } else {
        const auto deadline = *firstInputAt_ + std::chrono::milliseconds(startupPrebufferMs_);
        if (dataAvailable_.wait_until(lock, deadline) == std::cv_status::timeout) break;
      }
    }
    return error_.empty() && !stopping_ && queuedFrames_ > 0;
  }

  std::size_t pop(float* destination, std::size_t requestedFrames) {
    std::lock_guard lock(mutex_);
    std::size_t copiedFrames = 0;
    while (copiedFrames < requestedFrames && !chunks_.empty()) {
      AudioChunk& chunk = chunks_.front();
      const std::size_t availableSamples = chunk.samples.size() - chunk.offsetSamples;
      const std::size_t availableFrames = availableSamples / channels_;
      const std::size_t frames = std::min(availableFrames, requestedFrames - copiedFrames);
      const std::size_t samples = frames * channels_;
      std::memcpy(destination + copiedFrames * channels_,
                  chunk.samples.data() + chunk.offsetSamples,
                  samples * sizeof(float));
      chunk.offsetSamples += samples;
      copiedFrames += frames;
      queuedFrames_ -= frames;
      if (chunk.offsetSamples == chunk.samples.size()) chunks_.pop_front();
    }
    if (copiedFrames > 0) spaceAvailable_.notify_all();
    return copiedFrames;
  }

  bool inputEnded() const {
    std::lock_guard lock(mutex_);
    return inputEnded_;
  }

  bool empty() const {
    std::lock_guard lock(mutex_);
    return queuedFrames_ == 0;
  }

  std::string error() const {
    std::lock_guard lock(mutex_);
    return error_;
  }

  void stop() {
    std::lock_guard lock(mutex_);
    stopping_ = true;
    dataAvailable_.notify_all();
    spaceAvailable_.notify_all();
  }

 private:
  const std::size_t channels_;
  const std::uint32_t startupPrebufferMs_;
  const std::size_t startupFrames_;
  const std::size_t capacityFrames_;
  mutable std::mutex mutex_;
  std::condition_variable dataAvailable_;
  std::condition_variable spaceAvailable_;
  std::deque<AudioChunk> chunks_;
  std::size_t queuedFrames_{0};
  bool inputEnded_{false};
  bool stopping_{false};
  std::string error_;
  std::optional<std::chrono::steady_clock::time_point> firstInputAt_;
};

bool readExactAfterPrefix(void* destination, std::size_t size, std::size_t prefixBytes) {
  auto* bytes = static_cast<std::uint8_t*>(destination);
  return prefixBytes <= size && cpv::readBytes(stdin, bytes + prefixBytes, size - prefixBytes);
}

void readInput(BoundedAudioQueue* queue, std::uint32_t sampleRate, std::uint16_t channels) {
  std::uint32_t expectedSequence = 0;
  bool firstFrame = true;
  while (!stopRequested.load(std::memory_order_acquire)) {
    cpv::FrameHeader header{};
    const std::size_t first = fread(&header, 1, sizeof(header), stdin);
    if (stopRequested.load(std::memory_order_acquire)) {
      queue->finish();
      return;
    }
    if (first == 0 && feof(stdin)) {
      queue->finish();
      return;
    }
    if (first == 0) {
      queue->setError("Reading the CPV1 input pipe failed");
      return;
    }
    if (first < sizeof(header) && !readExactAfterPrefix(&header, sizeof(header), first)) {
      queue->setError("The CPV1 input stream ended with a truncated header");
      return;
    }
    if (!cpv::validHeader(header)) {
      queue->setError("The Windows output received an invalid CPV1 header");
      return;
    }
    if (header.type != static_cast<std::uint16_t>(cpv::FrameType::Audio) ||
        header.payloadBytes < sizeof(cpv::AudioMetadata)) {
      queue->setError("The Windows output accepts only CPV1 audio frames");
      return;
    }
    std::vector<std::uint8_t> payload(header.payloadBytes);
    if (!cpv::readBytes(stdin, payload.data(), payload.size())) {
      queue->setError("The CPV1 input stream ended with a truncated audio payload");
      return;
    }
    cpv::AudioMetadata metadata{};
    std::memcpy(&metadata, payload.data(), sizeof(metadata));
    const std::uint64_t expectedBytes = sizeof(metadata) +
        static_cast<std::uint64_t>(metadata.samplesPerChannel) * metadata.channels * sizeof(float);
    if (metadata.sampleRate != sampleRate || metadata.channels != channels ||
        metadata.sampleFormat != static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian) ||
        metadata.samplesPerChannel == 0 || expectedBytes != payload.size()) {
      queue->setError("A CPV1 frame does not match the prepared Windows output format");
      return;
    }
    if (!firstFrame && metadata.sequence != expectedSequence) {
      queue->setError("The Windows output received a CPV1 sequence gap");
      return;
    }
    firstFrame = false;
    expectedSequence = metadata.sequence + 1;
    const std::uint64_t durationNumerator =
        static_cast<std::uint64_t>(metadata.samplesPerChannel) * 1000;
    if (durationNumerator > static_cast<std::uint64_t>(sampleRate) * kMaximumFrameDurationMs) {
      queue->setError("A CPV1 frame exceeds the Windows output duration bound");
      return;
    }
    std::vector<float> samples(
        static_cast<std::size_t>(metadata.samplesPerChannel) * metadata.channels);
    std::memcpy(samples.data(), payload.data() + sizeof(metadata), samples.size() * sizeof(float));
    if (!queue->push(std::move(samples), metadata.samplesPerChannel)) return;
  }
  queue->finish();
}

void stopInputReader(BoundedAudioQueue* queue, std::thread* reader) {
  stopRequested.store(true, std::memory_order_release);
  if (stopEvent != nullptr) SetEvent(stopEvent);
  queue->stop();
  if (reader->joinable()) {
    CancelSynchronousIo(static_cast<HANDLE>(reader->native_handle()));
    reader->join();
  }
}

HRESULT resolveDefaultOutput(ComPtr<IMMDevice>* device, std::string* id, std::string* name,
                             bool* suppressionSink) {
  if (device == nullptr || id == nullptr || name == nullptr || suppressionSink == nullptr) {
    return E_POINTER;
  }
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = CoCreateInstance(
      __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      IID_PPV_ARGS(enumerator.GetAddressOf()));
  if (FAILED(result)) return result;
  result = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device->GetAddressOf());
  if (FAILED(result)) return result;

  LPWSTR rawId = nullptr;
  result = (*device)->GetId(&rawId);
  if (FAILED(result)) return result;
  *id = cpv::windows::utf8FromWide(rawId == nullptr ? L"" : std::wstring_view(rawId));
  if (rawId != nullptr) CoTaskMemFree(rawId);
  if (id->empty()) return E_FAIL;

  ComPtr<IPropertyStore> properties;
  result = (*device)->OpenPropertyStore(STGM_READ, properties.GetAddressOf());
  if (FAILED(result)) return result;
  PROPVARIANT value;
  PropVariantInit(&value);
  result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  if (SUCCEEDED(result) && value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
    *name = cpv::windows::utf8FromWide(value.pwszVal);
  } else if (SUCCEEDED(result)) {
    result = E_FAIL;
  }
  PropVariantClear(&value);
  *suppressionSink = cpv::windows::isVbCableInput(device->Get());
  return result;
}

bool emitReady(std::uint32_t sampleRate, std::uint16_t channels,
               std::string_view deviceId, std::string_view deviceName,
               std::uint32_t bufferFrames, OutputMode mode, bool selfTest) {
  const OutputBounds bounds = boundsFor(mode);
  std::ostringstream json;
  json << "{\"type\":\"ready\",\"helper\":\"output\",\"protocolVersion\":1"
       << ",\"backend\":\"wasapi-shared-render\""
       << ",\"sampleRate\":" << sampleRate
       << ",\"channels\":" << channels
       << ",\"sampleFormat\":\"f32le\""
       << ",\"maximumFrameDurationMs\":" << kMaximumFrameDurationMs
       << ",\"supportsJitterBuffer\":true"
       << ",\"startsWhenQueueFull\":true"
       << ",\"mode\":\"" << nameFor(mode) << "\""
       << ",\"startupPrebufferMs\":" << bounds.startupPrebufferMs
       << ",\"queueCapacityMs\":" << bounds.queueCapacityMs
       << ",\"supportsPassthrough\":true"
       << ",\"passthroughSilenceOnInputGap\":true"
       << ",\"passthroughStartupPrebufferMs\":" << kPassthroughStartupPrebufferMs
       << ",\"passthroughQueueCapacityMs\":" << kPassthroughQueueCapacityMs
       << ",\"bufferFrames\":" << bufferFrames
       << ",\"deviceId\":\"" << cpv::windows::jsonEscape(deviceId) << "\""
       << ",\"deviceName\":\"" << cpv::windows::jsonEscape(deviceName) << "\""
       << ",\"suppressionSink\":false"
       << ",\"usesDefaultDevice\":true"
       << ",\"selfTest\":" << (selfTest ? "true" : "false") << "}";
  return cpv::windows::writeJSON(cpv::FrameType::Ready, json.str());
}

bool emitRunning() {
  return cpv::windows::writeJSON(
      cpv::FrameType::Status,
      "{\"type\":\"status\",\"helper\":\"output\",\"state\":\"running\"}");
}

int fail(std::string_view code, std::string_view message) {
  cpv::windows::writeError(code, message);
  return 1;
}

int failHRESULT(std::string_view code, std::string_view operation, HRESULT result) {
  return fail(code, std::string(operation) + " failed: " + cpv::windows::hresultMessage(result));
}

int runOutput(std::uint32_t sampleRate, std::uint16_t channels,
              OutputMode mode, bool selfTest) {
  ComPtr<IMMDevice> device;
  std::string deviceId;
  std::string deviceName;
  bool suppressionSink = false;
  HRESULT result = resolveDefaultOutput(&device, &deviceId, &deviceName, &suppressionSink);
  if (FAILED(result)) return failHRESULT("output_device_missing", "Default Windows output discovery", result);
  if (suppressionSink) {
    return fail(
        "output_device_is_suppression_sink",
        "The default Windows output is VB-CABLE Input; choose a physical listening device");
  }

  if (selfTest) {
    return emitReady(sampleRate, channels, deviceId, deviceName, 0, mode, true) ? 0 : 1;
  }

  ComPtr<IAudioClient> audioClient;
  result = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                            reinterpret_cast<void**>(audioClient.GetAddressOf()));
  if (FAILED(result)) return failHRESULT("output_activation_failed", "WASAPI output activation", result);

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = channels;
  format.nSamplesPerSec = sampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * sizeof(float));
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  constexpr DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  result = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &format, nullptr);
  if (FAILED(result)) return failHRESULT("output_initialization_failed", "WASAPI output initialization", result);

  UINT32 bufferFrames = 0;
  result = audioClient->GetBufferSize(&bufferFrames);
  if (FAILED(result) || bufferFrames == 0) {
    return failHRESULT("output_buffer_failed", "WASAPI output buffer query",
                       FAILED(result) ? result : E_FAIL);
  }
  ScopedHandle samplesNeeded(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!samplesNeeded) return fail("output_event_failed", "The Windows output event could not be created");
  result = audioClient->SetEventHandle(samplesNeeded.get());
  if (FAILED(result)) return failHRESULT("output_event_failed", "WASAPI SetEventHandle", result);

  ComPtr<IAudioRenderClient> renderClient;
  result = audioClient->GetService(IID_PPV_ARGS(renderClient.GetAddressOf()));
  if (FAILED(result)) return failHRESULT("output_service_failed", "WASAPI render service acquisition", result);
  if (!emitReady(sampleRate, channels, deviceId, deviceName, bufferFrames, mode, false)) return 1;

  BoundedAudioQueue queue(sampleRate, channels, boundsFor(mode));
  std::thread reader(readInput, &queue, sampleRate, channels);
  if (!queue.waitForStartup()) {
    stopInputReader(&queue, &reader);
    const std::string error = queue.error();
    return error.empty() ? 0 : fail("output_input_failed", error);
  }

  BYTE* initialBuffer = nullptr;
  result = renderClient->GetBuffer(bufferFrames, &initialBuffer);
  if (FAILED(result)) {
    stopInputReader(&queue, &reader);
    return failHRESULT("output_buffer_failed", "WASAPI initial GetBuffer", result);
  }
  const std::size_t initialFrames = queue.pop(
      reinterpret_cast<float*>(initialBuffer), bufferFrames);
  if (initialFrames < bufferFrames) {
    std::memset(
        reinterpret_cast<float*>(initialBuffer) + initialFrames * channels,
        0,
        static_cast<std::size_t>(bufferFrames - initialFrames) * channels * sizeof(float));
  }
  result = renderClient->ReleaseBuffer(bufferFrames, 0);
  if (FAILED(result)) {
    stopInputReader(&queue, &reader);
    return failHRESULT("output_release_failed", "WASAPI initial ReleaseBuffer", result);
  }
  result = audioClient->Start();
  if (FAILED(result)) {
    stopInputReader(&queue, &reader);
    return failHRESULT("output_start_failed", "WASAPI output start", result);
  }
  if (!emitRunning()) {
    stopInputReader(&queue, &reader);
    audioClient->Stop();
    return 1;
  }

  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  HANDLE waits[] = {stopEvent, samplesNeeded.get()};
  int exitCode = 0;
  while (!stopRequested.load(std::memory_order_acquire)) {
    const DWORD waitResult = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (waitResult == WAIT_OBJECT_0) break;
    if (waitResult != WAIT_OBJECT_0 + 1) {
      fail("output_wait_failed", "Waiting for the Windows output buffer failed");
      exitCode = 1;
      break;
    }

    UINT32 padding = 0;
    result = audioClient->GetCurrentPadding(&padding);
    if (FAILED(result) || padding > bufferFrames) {
      failHRESULT("output_padding_failed", "WASAPI GetCurrentPadding",
                  FAILED(result) ? result : E_FAIL);
      exitCode = 1;
      break;
    }
    if (queue.inputEnded() && queue.empty() && padding == 0) break;
    const UINT32 availableFrames = bufferFrames - padding;
    if (availableFrames == 0) continue;
    if (queue.empty()) {
      if (queue.inputEnded()) continue;
      if (mode == OutputMode::Passthrough) {
        BYTE* silent = nullptr;
        result = renderClient->GetBuffer(availableFrames, &silent);
        if (FAILED(result)) {
          failHRESULT("output_buffer_failed", "WASAPI passthrough-silence GetBuffer", result);
          exitCode = 1;
          break;
        }
        result = renderClient->ReleaseBuffer(
            availableFrames, AUDCLNT_BUFFERFLAGS_SILENT);
        if (FAILED(result)) {
          failHRESULT("output_release_failed", "WASAPI passthrough-silence ReleaseBuffer", result);
          exitCode = 1;
          break;
        }
        continue;
      }
      fail("output_underrun", "The bounded Windows output queue underrun before input completed");
      exitCode = 1;
      break;
    }

    BYTE* raw = nullptr;
    result = renderClient->GetBuffer(availableFrames, &raw);
    if (FAILED(result)) {
      failHRESULT("output_buffer_failed", "WASAPI GetBuffer", result);
      exitCode = 1;
      break;
    }
    const std::size_t copiedFrames = queue.pop(reinterpret_cast<float*>(raw), availableFrames);
    if (copiedFrames < availableFrames) {
      std::memset(
          reinterpret_cast<float*>(raw) + copiedFrames * channels,
          0,
          static_cast<std::size_t>(availableFrames - copiedFrames) * channels * sizeof(float));
    }
    result = renderClient->ReleaseBuffer(availableFrames, 0);
    if (FAILED(result)) {
      failHRESULT("output_release_failed", "WASAPI ReleaseBuffer", result);
      exitCode = 1;
      break;
    }
  }

  stopInputReader(&queue, &reader);
  const std::string inputError = queue.error();
  if (!inputError.empty() && exitCode == 0) {
    fail("output_input_failed", inputError);
    exitCode = 1;
  }
  result = audioClient->Stop();
  if (FAILED(result) && exitCode == 0) {
    failHRESULT("output_stop_failed", "WASAPI output stop", result);
    exitCode = 1;
  }
  if (mmcss != nullptr) AvRevertMmThreadCharacteristics(mmcss);
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (!cpv::windows::setBinaryStandardStreams(true)) return 1;
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) return failHRESULT("com_initialization_failed", "COM initialization", comResult);

  ScopedHandle ownedStopEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!ownedStopEvent) {
    CoUninitialize();
    return fail("output_event_failed", "The Windows stop event could not be created");
  }
  stopEvent = ownedStopEvent.get();
  SetConsoleCtrlHandler(consoleControlHandler, TRUE);

  bool selfTest = false;
  bool invalid = false;
  OutputMode mode = OutputMode::Converted;
  bool modeSpecified = false;
  std::uint32_t sampleRate = 0;
  std::uint32_t channels = 0;
  for (int index = 1; index < argc; ++index) {
    const std::wstring_view argument(argv[index]);
    if (argument == L"--self-test") {
      selfTest = true;
    } else if (argument == L"--sample-rate" && index + 1 < argc) {
      const std::string value = cpv::windows::utf8FromWide(argv[++index]);
      invalid = !cpv::windows::parseUnsigned(value, 8'000, 192'000, &sampleRate);
    } else if (argument == L"--channels" && index + 1 < argc) {
      const std::string value = cpv::windows::utf8FromWide(argv[++index]);
      invalid = !cpv::windows::parseUnsigned(value, 1, 2, &channels);
    } else if (argument == L"--mode" && index + 1 < argc && !modeSpecified) {
      const std::wstring_view value(argv[++index]);
      modeSpecified = true;
      if (value == L"converted") mode = OutputMode::Converted;
      else if (value == L"passthrough") mode = OutputMode::Passthrough;
      else invalid = true;
    } else {
      invalid = true;
    }
  }
  if (selfTest && sampleRate == 0) sampleRate = 24'000;
  if (selfTest && channels == 0) channels = 1;

  int exitCode = 0;
  if (invalid || sampleRate == 0 || channels == 0) {
    exitCode = fail(
        "invalid_arguments",
        "Use --self-test or provide --sample-rate <8000-192000> --channels <1-2>");
  } else {
    exitCode = runOutput(sampleRate, static_cast<std::uint16_t>(channels), mode, selfTest);
  }

  SetConsoleCtrlHandler(consoleControlHandler, FALSE);
  stopEvent = nullptr;
  CoUninitialize();
  return exitCode;
}
