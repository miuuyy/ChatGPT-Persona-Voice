#import <AudioToolbox/AudioQueue.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include "../shared/NativeProtocol.hpp"

#include <atomic>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>
#include <vector>
#include <poll.h>
#include <unistd.h>

namespace {

constexpr std::size_t kOutputBufferCount = 64;
constexpr std::uint32_t kMaximumFrameDurationMs = 40;
constexpr std::uint32_t kDefaultStartupPrebufferMs = 500;

std::atomic<bool> stopRequested{false};

bool emitJSON(cpv::FrameType type, NSDictionary* object) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil || data.length > cpv::kMaximumPayloadBytes) return false;
  return cpv::writeFrame(
      stdout,
      type,
      data.bytes,
      static_cast<std::uint32_t>(data.length));
}

bool emitError(NSString* message, NSString* code = @"output_failed", OSStatus status = noErr) {
  NSString* detail = status == noErr
      ? message
      : [NSString stringWithFormat:@"%@ (OSStatus %d)", message, status];
  return emitJSON(cpv::FrameType::Error, @{
    @"type" : @"error",
    @"code" : code,
    @"message" : detail,
  });
}

void handleSignal(int) {
  stopRequested.store(true, std::memory_order_release);
}

NSString* copyStringProperty(AudioObjectID object, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address{
      selector,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(object, &address, 0, nullptr, &size, &value) != noErr ||
      value == nullptr) {
    return nil;
  }
  return CFBridgingRelease(value);
}

bool hasOutputStreams(AudioObjectID device) {
  AudioObjectPropertyAddress address{
      kAudioDevicePropertyStreams,
      kAudioObjectPropertyScopeOutput,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  return AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) == noErr &&
      size >= sizeof(AudioStreamID);
}

bool activeSubdeviceUIDs(
    AudioObjectID device,
    NSArray<NSString*>** output,
    bool* aggregateDevice) {
  if (output == nullptr || aggregateDevice == nullptr) return false;
  *output = @[];
  AudioObjectPropertyAddress address{
      kAudioAggregateDevicePropertyActiveSubDeviceList,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  *aggregateDevice = AudioObjectHasProperty(device, &address);
  if (!*aggregateDevice) return true;
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr ||
      size % sizeof(AudioObjectID) != 0) return false;
  if (size == 0) return true;
  std::vector<AudioObjectID> subdevices(size / sizeof(AudioObjectID));
  if (AudioObjectGetPropertyData(
          device, &address, 0, nullptr, &size, subdevices.data()) != noErr) {
    return false;
  }
  NSMutableArray<NSString*>* result = [NSMutableArray arrayWithCapacity:subdevices.size()];
  for (const AudioObjectID subdevice : subdevices) {
    NSString* uid = copyStringProperty(subdevice, kAudioDevicePropertyDeviceUID);
    if (uid.length == 0) return false;
    [result addObject:uid];
  }
  *output = result;
  return true;
}

bool resolveOutputDevice(NSString* requestedUID, AudioObjectID* device,
                         NSString** resolvedUID, NSString** resolvedName) {
  if (device == nullptr || resolvedUID == nullptr || resolvedName == nullptr) return false;
  *device = kAudioObjectUnknown;
  if (requestedUID == nil) {
    UInt32 size = sizeof(*device);
    AudioObjectPropertyAddress address{
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    if (AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, 0, nullptr, &size, device) != noErr) {
      return false;
    }
  } else {
    AudioObjectPropertyAddress address{
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr ||
        size < sizeof(AudioObjectID)) {
      return false;
    }
    std::vector<AudioObjectID> devices(size / sizeof(AudioObjectID));
    if (AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, 0, nullptr, &size, devices.data()) != noErr) {
      return false;
    }
    for (const AudioObjectID candidate : devices) {
      NSString* uid = copyStringProperty(candidate, kAudioDevicePropertyDeviceUID);
      if ([uid isEqualToString:requestedUID]) {
        *device = candidate;
        break;
      }
    }
  }
  if (*device == kAudioObjectUnknown || !hasOutputStreams(*device)) return false;
  *resolvedUID = copyStringProperty(*device, kAudioDevicePropertyDeviceUID);
  *resolvedName = copyStringProperty(*device, kAudioObjectPropertyName);
  return *resolvedUID != nil && *resolvedName != nil;
}

class OutputPool {
 public:
  AudioQueueBufferRef acquire() {
    std::unique_lock lock(mutex_);
    condition_.wait(lock, [this] {
      return !available_.empty() || stopRequested.load(std::memory_order_acquire);
    });
    if (available_.empty()) return nullptr;
    AudioQueueBufferRef buffer = available_.back();
    available_.pop_back();
    ++inFlight_;
    return buffer;
  }

  void add(AudioQueueBufferRef buffer) {
    std::lock_guard lock(mutex_);
    available_.push_back(buffer);
    condition_.notify_all();
  }

  void completed(AudioQueueBufferRef buffer) {
    std::lock_guard lock(mutex_);
    if (inFlight_ > 0) --inFlight_;
    if (inFlight_ == 0) starved_ = true;
    available_.push_back(buffer);
    condition_.notify_all();
  }

  void returnUnqueued(AudioQueueBufferRef buffer) {
    completed(buffer);
  }

  bool waitUntilDrained(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return condition_.wait_for(lock, timeout, [this] { return inFlight_ == 0; });
  }

  bool consumeStarvation() {
    std::lock_guard lock(mutex_);
    const bool value = starved_;
    starved_ = false;
    return value;
  }

  std::size_t inFlight() const {
    std::lock_guard lock(mutex_);
    return inFlight_;
  }

  void wake() { condition_.notify_all(); }

 private:
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::vector<AudioQueueBufferRef> available_;
  std::size_t inFlight_{0};
  bool starved_{false};
};

void outputCallback(void* userData, AudioQueueRef, AudioQueueBufferRef buffer) {
  auto* pool = static_cast<OutputPool*>(userData);
  if (pool != nullptr) pool->completed(buffer);
}

bool parsePositiveInteger(const char* value, std::uint32_t minimum,
                          std::uint32_t maximum, std::uint32_t* output) {
  if (value == nullptr || output == nullptr) return false;
  char* end = nullptr;
  const unsigned long parsed = strtoul(value, &end, 10);
  if (end == value || *end != '\0' || parsed < minimum || parsed > maximum) return false;
  *output = static_cast<std::uint32_t>(parsed);
  return true;
}

}  // namespace

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    setvbuf(stdin, nullptr, _IONBF, 0);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);

    bool selfTest = false;
    std::uint32_t sampleRate = 0;
    std::uint32_t channels = 0;
    std::uint32_t startupPrebufferMs = kDefaultStartupPrebufferMs;
    std::uint32_t startupDelayMs = 0;
    NSString* requestedDeviceUID = nil;
    for (int index = 1; index < argc; ++index) {
      if (strcmp(argv[index], "--self-test") == 0) selfTest = true;
      else if (strcmp(argv[index], "--sample-rate") == 0 && index + 1 < argc) {
        if (!parsePositiveInteger(argv[++index], 8000, 192000, &sampleRate)) {
          emitError(@"Sample rate must be between 8000 and 192000 Hz.", @"invalid_arguments");
          return 1;
        }
      } else if (strcmp(argv[index], "--channels") == 0 && index + 1 < argc) {
        if (!parsePositiveInteger(argv[++index], 1, 2, &channels)) {
          emitError(@"Output supports one or two channels.", @"invalid_arguments");
          return 1;
        }
      } else if (strcmp(argv[index], "--startup-prebuffer-ms") == 0) {
        if (index + 1 >= argc || !parsePositiveInteger(argv[++index], 200, 1000, &startupPrebufferMs) || startupPrebufferMs % 20 != 0) {
          emitError(@"Startup prebuffer must be a multiple of 20 ms between 200 and 1000 ms.", @"invalid_arguments");
          return 1;
        }
      } else if (strcmp(argv[index], "--startup-delay-ms") == 0) {
        if (index + 1 >= argc || !parsePositiveInteger(argv[++index], 0, 500, &startupDelayMs)) {
          emitError(@"Startup delay must be between 0 and 500 ms.", @"invalid_arguments");
          return 1;
        }
      } else if (strcmp(argv[index], "--device-uid") == 0 && index + 1 < argc) {
        requestedDeviceUID = [NSString stringWithUTF8String:argv[++index]];
        if (requestedDeviceUID == nil || requestedDeviceUID.length == 0 ||
            requestedDeviceUID.length > 4096) {
          emitError(@"Output device UID must contain 1-4096 UTF-8 characters.", @"invalid_arguments");
          return 1;
        }
      }
    }

    AudioObjectID outputDevice = kAudioObjectUnknown;
    NSString* outputDeviceUID = nil;
    NSString* outputDeviceName = nil;
    if (!resolveOutputDevice(
            requestedDeviceUID, &outputDevice, &outputDeviceUID, &outputDeviceName)) {
      emitError(requestedDeviceUID == nil
          ? @"No default Core Audio output device is available."
          : [NSString stringWithFormat:@"Core Audio output device %@ is unavailable.",
                                       requestedDeviceUID],
          @"output_device_missing");
      return 1;
    }
    NSArray<NSString*>* memberDeviceUIDs = @[];
    bool aggregateDevice = false;
    const bool memberDeviceUIDsVerified = activeSubdeviceUIDs(
        outputDevice, &memberDeviceUIDs, &aggregateDevice);
    if (selfTest) {
      emitJSON(cpv::FrameType::Ready, @{
        @"type" : @"ready",
        @"helper" : @"output",
        @"protocolVersion" : @(cpv::kProtocolVersion),
        @"supportsJitterBuffer" : @YES,
        @"startsWhenQueueFull" : @YES,
        @"startupPrebufferMs" : @(startupPrebufferMs),
        @"startupDelayMs" : @(startupDelayMs),
        @"queueCapacityFrames" : @(kOutputBufferCount),
        @"deviceUid" : outputDeviceUID,
        @"deviceName" : outputDeviceName,
        @"usesDefaultDevice" : @(requestedDeviceUID == nil),
        @"memberDeviceUids" : memberDeviceUIDs,
        @"memberDeviceUidsVerified" : @(memberDeviceUIDsVerified),
        @"isAggregateDevice" : @(aggregateDevice),
      });
      return 0;
    }
    if (sampleRate == 0 || channels == 0) {
      emitError(@"--sample-rate and --channels are required.", @"invalid_arguments");
      return 1;
    }

    AudioStreamBasicDescription format{};
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    format.mBytesPerPacket = channels * sizeof(float);
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = channels * sizeof(float);
    format.mChannelsPerFrame = channels;
    format.mBitsPerChannel = 32;

    OutputPool pool;
    AudioQueueRef queue = nullptr;
    OSStatus status = AudioQueueNewOutput(
        &format, outputCallback, &pool, nullptr, nullptr, 0, &queue);
    if (status != noErr || queue == nullptr) {
      emitError(@"Unable to create the Core Audio output queue.", @"output_queue_create_failed", status);
      return 1;
    }
    CFStringRef queueDeviceUID = (__bridge CFStringRef)outputDeviceUID;
    status = AudioQueueSetProperty(
        queue, kAudioQueueProperty_CurrentDevice, &queueDeviceUID, sizeof(queueDeviceUID));
    if (status != noErr) {
      emitError(@"Unable to bind converted output to the resolved Core Audio device.",
                @"output_device_bind_failed", status);
      AudioQueueDispose(queue, true);
      return 1;
    }

    const std::uint32_t maximumFrames =
        static_cast<std::uint32_t>((static_cast<std::uint64_t>(sampleRate) *
        kMaximumFrameDurationMs + 999) / 1000);
    const std::uint32_t bufferBytes = maximumFrames * channels * sizeof(float);
    bool setupFailed = false;
    for (std::size_t index = 0; index < kOutputBufferCount; ++index) {
      AudioQueueBufferRef buffer = nullptr;
      status = AudioQueueAllocateBuffer(queue, bufferBytes, &buffer);
      if (status != noErr || buffer == nullptr) {
        emitError(@"Unable to allocate a bounded audio output buffer.", @"output_buffer_create_failed", status);
        setupFailed = true;
        break;
      }
      pool.add(buffer);
    }
    if (setupFailed) {
      AudioQueueDispose(queue, true);
      return 1;
    }

    const bool readyWritten = emitJSON(cpv::FrameType::Ready, @{
      @"type" : @"ready",
      @"helper" : @"output",
      @"protocolVersion" : @(cpv::kProtocolVersion),
      @"sampleRate" : @(sampleRate),
      @"channels" : @(channels),
      @"sampleFormat" : @"f32le",
      @"maximumFrameDurationMs" : @(kMaximumFrameDurationMs),
      @"queueCapacityFrames" : @(kOutputBufferCount),
      @"supportsJitterBuffer" : @YES,
      @"startsWhenQueueFull" : @YES,
      @"startupPrebufferMs" : @(startupPrebufferMs),
      @"startupDelayMs" : @(startupDelayMs),
      @"deviceUid" : outputDeviceUID,
      @"deviceName" : outputDeviceName,
      @"usesDefaultDevice" : @(requestedDeviceUID == nil),
      @"memberDeviceUids" : memberDeviceUIDs,
      @"memberDeviceUidsVerified" : @(memberDeviceUIDsVerified),
      @"isAggregateDevice" : @(aggregateDevice),
    });

    bool failed = !readyWritten;
    bool queueRunning = false;
    bool queueEverStarted = false;
    std::uint64_t bufferedSamples = 0;
    std::uint32_t underruns = 0;
    bool startScheduled = false;
    std::chrono::steady_clock::time_point startDeadline;
    const std::uint64_t prebufferSamples =
        (static_cast<std::uint64_t>(sampleRate) * startupPrebufferMs + 999) / 1000;
    auto startBufferedQueue = [&]() -> bool {
      startScheduled = false;
      status = AudioQueueStart(queue, nullptr);
      if (status != noErr) {
        emitError(@"Unable to start buffered Core Audio output.",
                  @"output_queue_start_failed", status);
        return false;
      }
      queueRunning = true;
      const bool recovered = queueEverStarted;
      queueEverStarted = true;
      emitJSON(cpv::FrameType::Status, @{
        @"type" : @"status",
        @"helper" : @"output",
        @"state" : @"running",
        @"reason" : recovered ? @"jitter_buffer_recovered" : @"jitter_buffer_primed",
        @"underruns" : @(underruns),
        @"bufferedMs" : @(
            static_cast<double>(bufferedSamples) * 1000.0 /
            static_cast<double>(sampleRate)),
      });
      bufferedSamples = 0;
      return true;
    };
    while (!failed && !stopRequested.load(std::memory_order_acquire)) {
      int pollTimeoutMs = 50;
      if (startScheduled) {
        const auto now = std::chrono::steady_clock::now();
        if (now >= startDeadline) {
          if (!startBufferedQueue()) { failed = true; break; }
        } else {
          const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(startDeadline - now).count();
          pollTimeoutMs = static_cast<int>(std::max<std::int64_t>(1, std::min<std::int64_t>(50, remaining)));
        }
      }
      pollfd inputPoll{STDIN_FILENO, static_cast<short>(POLLIN | POLLHUP), 0};
      const int pollResult = poll(&inputPoll, 1, pollTimeoutMs);
      if (pollResult < 0) {
        if (errno == EINTR) continue;
        emitError(@"Unable to wait for converted audio input.", @"output_input_failed");
        failed = true;
        break;
      }
      if (pollResult == 0) continue;

      cpv::FrameHeader header{};
      const std::size_t headerBytes = fread(&header, 1, sizeof(header), stdin);
      if (headerBytes == 0 && feof(stdin)) break;
      if (headerBytes != sizeof(header) || !cpv::validHeader(header)) {
        emitError(@"Output received an invalid native frame header.", @"output_protocol_error");
        failed = true;
        break;
      }
      if (header.type != static_cast<std::uint16_t>(cpv::FrameType::Audio) ||
          header.payloadBytes < sizeof(cpv::AudioMetadata) ||
          header.payloadBytes > sizeof(cpv::AudioMetadata) + bufferBytes) {
        emitError(@"Output accepts only bounded audio frames.", @"output_protocol_error");
        failed = true;
        break;
      }
      std::vector<std::uint8_t> payload(header.payloadBytes);
      if (header.payloadBytes > 0 && !cpv::readBytes(stdin, payload.data(), payload.size())) {
        emitError(@"Output received a truncated native frame.", @"output_protocol_error");
        failed = true;
        break;
      }
      cpv::AudioMetadata metadata{};
      memcpy(&metadata, payload.data(), sizeof(metadata));
      const std::uint64_t expectedPCMBytes = static_cast<std::uint64_t>(metadata.samplesPerChannel) *
          metadata.channels * sizeof(float);
      const bool durationValid = static_cast<std::uint64_t>(metadata.samplesPerChannel) * 1000 <=
          static_cast<std::uint64_t>(sampleRate) * kMaximumFrameDurationMs;
      if (metadata.sampleRate != sampleRate || metadata.channels != channels ||
          metadata.sampleFormat != static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian) ||
          metadata.samplesPerChannel == 0 ||
          expectedPCMBytes + sizeof(metadata) != payload.size() || !durationValid ||
          expectedPCMBytes > bufferBytes) {
        emitError(@"Output frame format or duration does not match the prepared sink.",
                  @"output_frame_rejected");
        failed = true;
        break;
      }

      if (queueRunning && pool.consumeStarvation()) {
        UInt32 isRunning = 0;
        UInt32 propertySize = sizeof(isRunning);
        status = AudioQueueGetProperty(
            queue, kAudioQueueProperty_IsRunning, &isRunning, &propertySize);
        if (status == noErr && isRunning != 0) status = AudioQueuePause(queue);
        if (status != noErr) {
          emitError(@"Unable to pause starved converted output.",
                    @"output_rebuffer_failed", status);
          failed = true;
          break;
        }
        queueRunning = false;
        startScheduled = false;
        bufferedSamples = 0;
        ++underruns;
        emitJSON(cpv::FrameType::Status, @{
          @"type" : @"status",
          @"helper" : @"output",
          @"state" : @"rebuffering",
          @"underruns" : @(underruns),
          @"targetBufferedMs" : @(startupPrebufferMs),
        });
      }

      AudioQueueBufferRef buffer = pool.acquire();
      if (buffer == nullptr) break;
      memcpy(buffer->mAudioData, payload.data() + sizeof(metadata), expectedPCMBytes);
      buffer->mAudioDataByteSize = static_cast<UInt32>(expectedPCMBytes);
      status = AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
      if (status != noErr) {
        pool.returnUnqueued(buffer);
        emitError(@"Core Audio rejected a converted output frame.", @"output_enqueue_failed", status);
        failed = true;
        break;
      }
      if (!queueRunning) {
        bufferedSamples += metadata.samplesPerChannel;
        const bool prebufferReady = bufferedSamples >= prebufferSamples ||
            pool.inFlight() >= kOutputBufferCount;
        if (prebufferReady) {
          // A clock reserve absorbs processing jitter even when the model emits
          // one large block at a time. Keep reading while that reserve elapses.
          // A full pool starts immediately to preserve bounded backpressure.
          if (startupDelayMs == 0 || pool.inFlight() >= kOutputBufferCount) {
            if (!startBufferedQueue()) { failed = true; break; }
          } else if (!startScheduled) {
            startDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(startupDelayMs);
            startScheduled = true;
          }
        }
      }
    }

    pool.wake();
    if (!failed && !stopRequested.load(std::memory_order_acquire)) {
      if (!queueRunning && pool.inFlight() > 0) {
        if (!startBufferedQueue()) {
          failed = true;
        }
      }
      if (!failed && queueEverStarted) AudioQueueStop(queue, false);
      if (!pool.waitUntilDrained(std::chrono::seconds(5))) {
        emitError(@"Converted output did not drain within its bounded shutdown window.",
                  @"output_drain_timeout");
        failed = true;
      }
    }
    AudioQueueStop(queue, true);
    AudioQueueDispose(queue, true);
    return failed ? 1 : 0;
  }
}
