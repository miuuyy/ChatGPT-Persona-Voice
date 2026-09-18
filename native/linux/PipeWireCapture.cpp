#include "PipeWireCommon.hpp"

#include <pipewire/pipewire.h>

#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>
#include <spa/pod/parser.h>
#include <spa/utils/result.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/eventfd.h>
#include <sys/file.h>
#include <sys/poll.h>
#include <sys/prctl.h>
#include <unistd.h>

namespace {

constexpr std::uint32_t kSampleRate = 48'000;
constexpr std::uint16_t kChannels = 2;
constexpr std::uint32_t kMaximumFrames = 8'192;
constexpr std::size_t kCaptureQueueSlots = 64;
constexpr std::uint32_t kPolicyVersion = 3;
constexpr auto kControlInterval = std::chrono::milliseconds(25);
constexpr auto kMuteProofTimeout = std::chrono::seconds(2);
constexpr std::array<const char*, 3> kRouteIds{"chatgpt", "codex", "grok-bot"};

std::atomic<bool> stopRequested{false};
int wakeFd = -1;

void wakeControl() {
  if (wakeFd < 0) return;
  const std::uint64_t value = 1;
  const ssize_t ignored = write(wakeFd, &value, sizeof(value));
  (void)ignored;
}

void handleSignal(int) {
  stopRequested.store(true, std::memory_order_release);
  wakeControl();
}

std::string property(const spa_dict* props, const char* key) {
  if (props == nullptr) return {};
  const char* value = spa_dict_lookup(props, key);
  return value == nullptr ? std::string{} : std::string(value);
}

std::uint32_t idProperty(const spa_dict* props, const char* key) {
  const std::string value = property(props, key);
  return cpv::linux_audio::parseU32(value.c_str()).value_or(SPA_ID_INVALID);
}

struct NodeRecord {
  std::uint32_t id = SPA_ID_INVALID;
  std::string name;
  std::string mediaClass;
};

struct PortRecord {
  std::uint32_t id = SPA_ID_INVALID;
  std::uint32_t nodeId = SPA_ID_INVALID;
  std::string direction;
};

struct LinkRecord {
  std::uint32_t id = SPA_ID_INVALID;
  std::uint32_t outputNode = SPA_ID_INVALID;
  std::uint32_t outputPort = SPA_ID_INVALID;
  std::uint32_t inputNode = SPA_ID_INVALID;
  std::uint32_t inputPort = SPA_ID_INVALID;
};

struct CapturedChunk {
  std::uint32_t frames = 0;
  std::array<float, static_cast<std::size_t>(kMaximumFrames) * kChannels> pcm{};
};

class CaptureQueue {
 public:
  CaptureQueue() : chunks_(std::make_unique<Chunks>()) {}

  bool push(const float* pcm, std::uint32_t frames) {
    if (pcm == nullptr || frames == 0 || frames > kMaximumFrames) return false;
    const std::uint32_t writeIndex = writeIndex_.load(std::memory_order_relaxed);
    const std::uint32_t next = (writeIndex + 1) % kCaptureQueueSlots;
    if (next == readIndex_.load(std::memory_order_acquire)) return false;
    CapturedChunk& target = (*chunks_)[writeIndex];
    target.frames = frames;
    std::copy_n(pcm, static_cast<std::size_t>(frames) * kChannels, target.pcm.begin());
    writeIndex_.store(next, std::memory_order_release);
    return true;
  }

  bool pop(CapturedChunk* output) {
    if (output == nullptr) return false;
    const std::uint32_t readIndex = readIndex_.load(std::memory_order_relaxed);
    if (readIndex == writeIndex_.load(std::memory_order_acquire)) return false;
    *output = (*chunks_)[readIndex];
    readIndex_.store((readIndex + 1) % kCaptureQueueSlots, std::memory_order_release);
    return true;
  }

 private:
  using Chunks = std::array<CapturedChunk, kCaptureQueueSlots>;
  std::unique_ptr<Chunks> chunks_;
  std::atomic<std::uint32_t> readIndex_{0};
  std::atomic<std::uint32_t> writeIndex_{0};
};

class SessionLock {
 public:
  ~SessionLock() {
    if (descriptor_ >= 0) close(descriptor_);
  }

  bool acquire(std::string* error) {
    const char* runtime = std::getenv("XDG_RUNTIME_DIR");
    if (runtime == nullptr || runtime[0] != '/') {
      return fail(error, "XDG_RUNTIME_DIR must be an absolute path for the Linux capture lease");
    }
    const std::string destination = std::string(runtime) + "/chatgpt-persona-voice.capture.lock";
    descriptor_ = open(destination.c_str(), O_CREAT | O_CLOEXEC | O_RDWR, 0600);
    if (descriptor_ < 0) return fail(error, cpv::linux_audio::errnoMessage("Unable to open the Linux capture lease"));
    if (flock(descriptor_, LOCK_EX | LOCK_NB) < 0) {
      return fail(error, "Another ChatGPT Persona Voice capture helper owns the Linux audio route");
    }
    return true;
  }

 private:
  static bool fail(std::string* error, std::string message) {
    if (error != nullptr) *error = std::move(message);
    return false;
  }

  int descriptor_ = -1;
};

class PipeWireCapture {
 public:
  explicit PipeWireCapture(std::string routeId)
      : routeId_(std::move(routeId)),
        ingressNode_("chatgpt-persona-voice.ingress." + routeId_),
        bypassNode_("chatgpt-persona-voice.bypass." + routeId_) {}

  ~PipeWireCapture() { shutdown(); }

  bool connect(std::string* error) {
    pw_init(nullptr, nullptr);
    loop_ = pw_thread_loop_new("cpv-pipewire-capture", nullptr);
    if (loop_ == nullptr) return fail(error, "Unable to create the PipeWire capture loop");
    context_ = pw_context_new(pw_thread_loop_get_loop(loop_), nullptr, 0);
    if (context_ == nullptr) return fail(error, cpv::linux_audio::errnoMessage("Unable to create the PipeWire context"));
    core_ = pw_context_connect(
        context_,
        pw_properties_new(PW_KEY_REMOTE_INTENTION, "manager", nullptr),
        0);
    if (core_ == nullptr) return fail(error, cpv::linux_audio::errnoMessage("Unable to connect to PipeWire"));
    pw_core_add_listener(core_, &coreListener_, &coreEvents_, this);
    registry_ = pw_core_get_registry(core_, PW_VERSION_REGISTRY, 0);
    if (registry_ == nullptr) return fail(error, "Unable to acquire the PipeWire registry");
    pw_registry_add_listener(registry_, &registryListener_, &registryEvents_, this);
    if (pw_thread_loop_start(loop_) < 0) {
      return fail(error, cpv::linux_audio::errnoMessage("Unable to start the PipeWire capture loop"));
    }
    loopStarted_ = true;
    pw_thread_loop_lock(loop_);
    const bool synchronized = roundtripLocked(error);
    const bool nodesPresent = synchronized && ingressNodeId_ != SPA_ID_INVALID &&
        bypassNodeId_ != SPA_ID_INVALID && bypassProxy_ != nullptr;
    pw_thread_loop_unlock(loop_);
    if (!synchronized) return false;
    if (!nodesPresent) {
      return fail(error, "The installed Persona Voice ingress/bypass policy is not active in this PipeWire session");
    }
    return true;
  }

  bool selfTest(std::string* error) {
    if (!connect(error)) return false;
    if (!probePrelinkedPolicy(error)) return false;
    return true;
  }

  bool emitReady(bool selfTest = false) const {
    std::ostringstream json;
    json << "{\"type\":\"ready\",\"helper\":\"capture\",\"protocolVersion\":1"
         << ",\"source\":\"Linux PipeWire pre-linked ingress\""
         << ",\"sampleRate\":" << kSampleRate
         << ",\"channels\":" << kChannels
         << ",\"sampleFormat\":\"f32le\""
         << ",\"supportsArming\":true"
         << ",\"supportsDeferredRoute\":true"
         << ",\"supportsCaptureProof\":true"
         << ",\"supportsProcessScopedRouting\":true"
         << ",\"supportsRollbackProof\":true"
         << ",\"supportsPrelinkedIngress\":true"
         << ",\"supportsDynamicProcessStreams\":true"
         << ",\"supportsCrashRecovery\":true"
         << ",\"policyVersion\":" << kPolicyVersion
         << ",\"routeOwner\":\"wireplumber-prelink-policy\""
         << ",\"routeId\":\"" << cpv::linux_audio::jsonEscape(routeId_) << "\""
         << ",\"supportedRouteIds\":[\"chatgpt\",\"codex\",\"grok-bot\"]"
         << ",\"policyProbeVerified\":" << (selfTest ? "true" : "false");
    if (!selfTest) {
      json << ",\"armed\":true,\"state\":\"armed\""
           << ",\"originalSuppressed\":false,\"tapActive\":false"
           << ",\"routeOwnershipVerified\":false"
           << ",\"activationSignal\":\"owned_ingress_capture\"";
    }
    json << '}';
    return cpv::linux_audio::writeJson(cpv::FrameType::Ready, json.str());
  }

  bool engage(std::string* error) {
    pw_thread_loop_lock(loop_);
    const bool created = createCaptureStreamLocked(error);
    pw_thread_loop_unlock(loop_);
    if (!created) return false;
    if (!waitForCaptureLinks(kMuteProofTimeout, error)) return false;
    if (!waitForBypassMute(true, kMuteProofTimeout, error)) return false;

    pw_thread_loop_lock(loop_);
    const bool routeValid = roundtripLocked(error) && auditCaptureLinksLocked(error);
    if (routeValid) {
      engaged_ = true;
      suppressed_.store(true, std::memory_order_release);
      captureEnabled_.store(true, std::memory_order_release);
    }
    pw_thread_loop_unlock(loop_);
    if (!routeValid) return false;

    cpv::linux_audio::writeJson(
        cpv::FrameType::Status,
        "{\"type\":\"status\",\"helper\":\"capture\",\"state\":\"engaged\","
        "\"reason\":\"prelinked_ingress_guarded\",\"originalSuppressed\":true,"
        "\"tapActive\":true,\"captureVerified\":true,"
        "\"routeOwnershipVerified\":true,\"bypassMuteVerified\":true,"
        "\"prelinkPolicyVerified\":true}");
    return true;
  }

  void startWriter() {
    writer_ = std::thread([this] { writerLoop(); });
  }

  bool controlTick(std::string* error) {
    if (captureOverflow_.load(std::memory_order_acquire)) {
      return fail(error, "The bounded PipeWire capture queue overflowed");
    }
    if (writerFailed_.load(std::memory_order_acquire)) {
      return fail(error, "The CPV1 capture writer closed while suppression was active");
    }
    pw_thread_loop_lock(loop_);
    const bool synchronized = roundtripLocked(error);
    if (!synchronized) {
      pw_thread_loop_unlock(loop_);
      return false;
    }
    if (ingressNodeId_ == SPA_ID_INVALID || bypassNodeId_ == SPA_ID_INVALID || captureNodeId_ == SPA_ID_INVALID) {
      pw_thread_loop_unlock(loop_);
      return fail(error, "A policy-owned PipeWire node disappeared while capture was active");
    }
    if (!refreshBypassMuteLocked(error)) {
      pw_thread_loop_unlock(loop_);
      return false;
    }
    if (bypassMuteKnown_ && !bypassMuted_) {
      captureEnabled_.store(false, std::memory_order_release);
      suppressed_.store(false, std::memory_order_release);
      pw_thread_loop_unlock(loop_);
      return fail(error, "The policy bypass became unmuted while converted capture was active");
    }
    const bool valid = auditCaptureLinksLocked(error);
    pw_thread_loop_unlock(loop_);
    return valid;
  }

  bool release(std::string* error) {
    captureEnabled_.store(false, std::memory_order_release);
    if (!engaged_) return true;
    if (!setAndProveBypassMute(false, error)) return false;

    pw_thread_loop_lock(loop_);
    suppressed_.store(false, std::memory_order_release);
    engaged_ = false;
    destroyCaptureStreamLocked();
    const bool synchronized = roundtripLocked(error);
    pw_thread_loop_unlock(loop_);
    if (!synchronized) return false;
    cpv::linux_audio::writeJson(
        cpv::FrameType::Status,
        "{\"type\":\"status\",\"helper\":\"capture\",\"state\":\"armed\","
        "\"reason\":\"bypass_restored\",\"originalSuppressed\":false,"
        "\"tapActive\":false,\"captureVerified\":false,"
        "\"routeOwnershipVerified\":false,\"bypassMuteVerified\":true}");
    return true;
  }

  bool isSuppressed() const { return suppressed_.load(std::memory_order_acquire); }

 private:
  bool fail(std::string* error, std::string message) const {
    if (error != nullptr) *error = std::move(message);
    return false;
  }

  static void onCoreDone(void* data, std::uint32_t id, int sequence) {
    auto* self = static_cast<PipeWireCapture*>(data);
    if (id == PW_ID_CORE) self->completedSequence_ = sequence;
    pw_thread_loop_signal(self->loop_, false);
  }

  static void onCoreError(
      void* data,
      std::uint32_t,
      int,
      int result,
      const char* message) {
    auto* self = static_cast<PipeWireCapture*>(data);
    self->coreError_ = std::string(message == nullptr ? "PipeWire core error" : message) +
        " (" + spa_strerror(result) + ')';
    pw_thread_loop_signal(self->loop_, false);
  }

  static void onRegistryGlobal(
      void* data,
      std::uint32_t id,
      std::uint32_t,
      const char* type,
      std::uint32_t version,
      const spa_dict* props) {
    auto* self = static_cast<PipeWireCapture*>(data);
    if (std::strcmp(type, PW_TYPE_INTERFACE_Node) == 0) {
      NodeRecord record{id, property(props, PW_KEY_NODE_NAME), property(props, PW_KEY_MEDIA_CLASS)};
      self->nodes_[id] = record;
      if (record.name == self->ingressNode_) self->ingressNodeId_ = id;
      if (record.name == self->bypassNode_) {
        self->bypassNodeId_ = id;
        if (self->bypassProxy_ == nullptr) {
          self->bypassProxy_ = static_cast<pw_node*>(pw_registry_bind(
              self->registry_, id, PW_TYPE_INTERFACE_Node,
              std::min(version, static_cast<std::uint32_t>(PW_VERSION_NODE)), 0));
          if (self->bypassProxy_ != nullptr) {
            pw_node_add_listener(self->bypassProxy_, &self->bypassListener_, &bypassEvents_, self);
          }
        }
      }
    } else if (std::strcmp(type, PW_TYPE_INTERFACE_Port) == 0) {
      self->ports_[id] = PortRecord{
          id,
          idProperty(props, PW_KEY_NODE_ID),
          property(props, PW_KEY_PORT_DIRECTION),
      };
    } else if (std::strcmp(type, PW_TYPE_INTERFACE_Link) == 0) {
      LinkRecord record{
          id,
          idProperty(props, PW_KEY_LINK_OUTPUT_NODE),
          idProperty(props, PW_KEY_LINK_OUTPUT_PORT),
          idProperty(props, PW_KEY_LINK_INPUT_NODE),
          idProperty(props, PW_KEY_LINK_INPUT_PORT),
      };
      self->links_[id] = record;
      self->linkHistory_.push_back(record);
    }
  }

  static void onRegistryRemove(void* data, std::uint32_t id) {
    auto* self = static_cast<PipeWireCapture*>(data);
    self->nodes_.erase(id);
    self->ports_.erase(id);
    self->links_.erase(id);
    if (self->ingressNodeId_ == id) self->ingressNodeId_ = SPA_ID_INVALID;
    if (self->bypassNodeId_ == id) {
      self->bypassNodeId_ = SPA_ID_INVALID;
      self->bypassMuteKnown_ = false;
      if (self->bypassProxy_ != nullptr) {
        spa_hook_remove(&self->bypassListener_);
        pw_proxy_destroy(reinterpret_cast<pw_proxy*>(self->bypassProxy_));
        self->bypassProxy_ = nullptr;
      }
    }
  }

  static void onBypassInfo(void* data, const pw_node_info* info) {
    auto* self = static_cast<PipeWireCapture*>(data);
    if ((info->change_mask & PW_NODE_CHANGE_MASK_PARAMS) != 0 && self->bypassProxy_ != nullptr) {
      pw_node_enum_params(self->bypassProxy_, 0, SPA_PARAM_Props, 0, UINT32_MAX, nullptr);
    }
  }

  static void onBypassParam(
      void* data,
      int,
      std::uint32_t id,
      std::uint32_t,
      std::uint32_t,
      const spa_pod* param) {
    auto* self = static_cast<PipeWireCapture*>(data);
    if (id != SPA_PARAM_Props || param == nullptr) return;
    int muted = 0;
    const int result = spa_pod_parse_object(
        param,
        SPA_TYPE_OBJECT_Props,
        nullptr,
        SPA_PROP_mute, SPA_POD_OPT_Bool(&muted));
    if (result >= 0) {
      self->bypassMuted_ = muted != 0;
      self->bypassMuteKnown_ = true;
      pw_thread_loop_signal(self->loop_, false);
    }
  }

  static void onCaptureState(
      void* data,
      pw_stream_state,
      pw_stream_state state,
      const char* error) {
    auto* self = static_cast<PipeWireCapture*>(data);
    self->captureState_ = state;
    self->captureStateError_ = error == nullptr ? std::string{} : std::string(error);
    pw_thread_loop_signal(self->loop_, false);
  }

  static void onCaptureProcess(void* data) {
    static_cast<PipeWireCapture*>(data)->processCapture();
  }

  static void onProbeState(
      void* data,
      pw_stream_state,
      pw_stream_state state,
      const char* error) {
    auto* self = static_cast<PipeWireCapture*>(data);
    self->probeState_ = state;
    self->probeStateError_ = error == nullptr ? std::string{} : std::string(error);
    pw_thread_loop_signal(self->loop_, false);
  }

  static void onProbeProcess(void* data) {
    auto* self = static_cast<PipeWireCapture*>(data);
    if (self->probeStream_ == nullptr) return;
    pw_buffer* pipewireBuffer = pw_stream_dequeue_buffer(self->probeStream_);
    if (pipewireBuffer == nullptr) return;
    spa_buffer* buffer = pipewireBuffer->buffer;
    if (buffer != nullptr && buffer->n_datas > 0 && buffer->datas[0].data != nullptr &&
        buffer->datas[0].chunk != nullptr) {
      spa_data& output = buffer->datas[0];
      const std::size_t frames = std::min<std::size_t>(
          pipewireBuffer->requested == 0 ? output.maxsize / (sizeof(float) * kChannels)
                                        : pipewireBuffer->requested,
          output.maxsize / (sizeof(float) * kChannels));
      std::memset(output.data, 0, frames * sizeof(float) * kChannels);
      output.chunk->offset = 0;
      output.chunk->stride = sizeof(float) * kChannels;
      output.chunk->size = frames * sizeof(float) * kChannels;
    }
    pw_stream_queue_buffer(self->probeStream_, pipewireBuffer);
  }

  void processCapture() {
    if (captureStream_ == nullptr) return;
    pw_buffer* pipewireBuffer = pw_stream_dequeue_buffer(captureStream_);
    if (pipewireBuffer == nullptr) return;
    spa_buffer* buffer = pipewireBuffer->buffer;
    if (buffer == nullptr || buffer->n_datas != 1 || buffer->datas[0].data == nullptr ||
        buffer->datas[0].chunk == nullptr) {
      captureOverflow_.store(true, std::memory_order_release);
      pw_stream_queue_buffer(captureStream_, pipewireBuffer);
      wakeControl();
      return;
    }
    const spa_data& input = buffer->datas[0];
    const spa_chunk* chunk = input.chunk;
    const std::size_t sampleBytes = sizeof(float) * kChannels;
    if (chunk->offset > input.maxsize || chunk->size > input.maxsize - chunk->offset ||
        chunk->size % sampleBytes != 0) {
      captureOverflow_.store(true, std::memory_order_release);
    } else if (captureEnabled_.load(std::memory_order_acquire) && chunk->size > 0) {
      const std::uint32_t frames = static_cast<std::uint32_t>(chunk->size / sampleBytes);
      const auto* pcm = reinterpret_cast<const float*>(
          static_cast<const std::uint8_t*>(input.data) + chunk->offset);
      if (frames > kMaximumFrames || !captureQueue_.push(pcm, frames)) {
        captureOverflow_.store(true, std::memory_order_release);
      }
    }
    pw_stream_queue_buffer(captureStream_, pipewireBuffer);
    wakeControl();
  }

  void writerLoop() {
    std::uint32_t sequence = 0;
    while (!writerStop_.load(std::memory_order_acquire)) {
      pollfd descriptor{wakeFd, POLLIN, 0};
      const int result = poll(&descriptor, 1, 100);
      if (result > 0 && (descriptor.revents & POLLIN) != 0) {
        std::uint64_t value = 0;
        while (read(wakeFd, &value, sizeof(value)) > 0) {}
      }
      CapturedChunk chunk;
      while (captureQueue_.pop(&chunk)) {
        if (!captureEnabled_.load(std::memory_order_acquire)) continue;
        if (!cpv::linux_audio::writeAudio(
                sequence++, kSampleRate, kChannels, chunk.frames, chunk.pcm.data())) {
          writerFailed_.store(true, std::memory_order_release);
          stopRequested.store(true, std::memory_order_release);
          break;
        }
      }
    }
  }

  bool roundtripLocked(std::string* error) {
    coreError_.clear();
    const int sequence = pw_core_sync(core_, PW_ID_CORE, 0);
    if (sequence < 0) return fail(error, std::string("PipeWire sync failed: ") + spa_strerror(sequence));
    while (completedSequence_ != sequence && coreError_.empty()) pw_thread_loop_wait(loop_);
    if (!coreError_.empty()) return fail(error, coreError_);
    return true;
  }

  std::array<const spa_pod*, 1> buildAudioFormat(
      std::array<std::uint8_t, 1'024>* storage,
      spa_pod_builder* builder) const {
    spa_pod_builder_init(builder, storage->data(), static_cast<std::uint32_t>(storage->size()));
    spa_audio_info_raw format = SPA_AUDIO_INFO_RAW_INIT(
        .format = SPA_AUDIO_FORMAT_F32,
        .rate = kSampleRate,
        .channels = kChannels);
    format.position[0] = SPA_AUDIO_CHANNEL_FL;
    format.position[1] = SPA_AUDIO_CHANNEL_FR;
    return {spa_format_audio_raw_build(builder, SPA_PARAM_EnumFormat, &format)};
  }

  bool createCaptureStreamLocked(std::string* error) {
    if (captureStream_ != nullptr) return fail(error, "The PipeWire ingress capture stream already exists");
    linkHistory_.clear();
    captureState_ = PW_STREAM_STATE_UNCONNECTED;
    captureStateError_.clear();
    captureStream_ = pw_stream_new(
        core_,
        "cpv-ingress-capture",
        pw_properties_new(
            PW_KEY_MEDIA_TYPE, "Audio",
            PW_KEY_MEDIA_CATEGORY, "Capture",
            PW_KEY_MEDIA_ROLE, "Communication",
            PW_KEY_MEDIA_CLASS, "Stream/Input/Audio",
            PW_KEY_NODE_NAME, ("chatgpt-persona-voice.capture-guard." + routeId_).c_str(),
            PW_KEY_NODE_DESCRIPTION, "ChatGPT Persona Voice guarded ingress capture",
            PW_KEY_NODE_AUTOCONNECT, "true",
            PW_KEY_NODE_DONT_RECONNECT, "true",
            PW_KEY_STREAM_CAPTURE_SINK, "true",
            PW_KEY_TARGET_OBJECT, ingressNode_.c_str(),
            "chatgpt.persona.voice.capture-guard", "true",
            "chatgpt.persona.voice.route", routeId_.c_str(),
            "chatgpt.persona.voice.policy-version", "3",
            nullptr));
    if (captureStream_ == nullptr) return fail(error, cpv::linux_audio::errnoMessage("Unable to create ingress capture"));
    pw_stream_add_listener(captureStream_, &captureListener_, &captureEvents_, this);
    std::array<std::uint8_t, 1'024> storage{};
    spa_pod_builder builder{};
    auto params = buildAudioFormat(&storage, &builder);
    const int result = pw_stream_connect(
        captureStream_,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(
            PW_STREAM_FLAG_AUTOCONNECT |
            PW_STREAM_FLAG_MAP_BUFFERS |
            PW_STREAM_FLAG_RT_PROCESS),
        params.data(),
        params.size());
    if (result < 0) {
      destroyCaptureStreamLocked();
      return fail(error, std::string("Unable to connect the ingress capture: ") + spa_strerror(result));
    }
    while (captureState_ != PW_STREAM_STATE_PAUSED && captureState_ != PW_STREAM_STATE_STREAMING &&
           captureState_ != PW_STREAM_STATE_ERROR) {
      pw_thread_loop_wait(loop_);
    }
    if (captureState_ == PW_STREAM_STATE_ERROR) {
      const std::string detail = captureStateError_.empty()
          ? "The ingress capture stream entered an error state" : captureStateError_;
      destroyCaptureStreamLocked();
      return fail(error, detail);
    }
    if (!roundtripLocked(error)) {
      destroyCaptureStreamLocked();
      return false;
    }
    captureNodeId_ = pw_stream_get_node_id(captureStream_);
    if (captureNodeId_ == SPA_ID_INVALID) {
      destroyCaptureStreamLocked();
      return fail(error, "PipeWire did not assign the guarded capture node an id");
    }
    return true;
  }

  bool waitForCaptureLinks(std::chrono::milliseconds timeout, std::string* error) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    std::string lastError = "The guarded ingress capture link was not observed";
    while (std::chrono::steady_clock::now() < deadline) {
      pw_thread_loop_lock(loop_);
      const bool synchronized = roundtripLocked(&lastError);
      const bool valid = synchronized && auditCaptureLinksLocked(&lastError);
      pw_thread_loop_unlock(loop_);
      if (valid) return true;
      if (!synchronized) return fail(error, lastError);
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return fail(error, lastError);
  }

  bool auditCaptureLinksLocked(std::string* error) const {
    std::set<std::uint32_t> inputPorts;
    for (const auto& [id, port] : ports_) {
      if (port.nodeId == captureNodeId_ && port.direction == "in") inputPorts.insert(id);
    }
    if (inputPorts.size() != kChannels) {
      return fail(error, "The guarded ingress capture did not expose exactly two input ports");
    }
    for (const std::uint32_t inputPort : inputPorts) {
      std::size_t ownedLinks = 0;
      for (const auto& [id, link] : links_) {
        (void)id;
        if (link.inputPort != inputPort) continue;
        if (link.inputNode != captureNodeId_ || link.outputNode != ingressNodeId_) {
          return fail(error, "The guarded capture received an unowned PipeWire link");
        }
        ++ownedLinks;
      }
      if (ownedLinks != 1) return fail(error, "The guarded capture link was not uniquely proven");
    }
    return true;
  }

  void destroyCaptureStreamLocked() {
    if (captureStream_ != nullptr) {
      spa_hook_remove(&captureListener_);
      pw_stream_destroy(captureStream_);
      captureStream_ = nullptr;
    }
    captureNodeId_ = SPA_ID_INVALID;
    captureState_ = PW_STREAM_STATE_UNCONNECTED;
    captureStateError_.clear();
  }

  bool refreshBypassMuteLocked(std::string* error) {
    if (bypassProxy_ == nullptr) return fail(error, "The policy bypass node is unavailable");
    bypassMuteKnown_ = false;
    const int result = pw_node_enum_params(
        bypassProxy_, 0, SPA_PARAM_Props, 0, UINT32_MAX, nullptr);
    if (result < 0) return fail(error, std::string("Unable to inspect bypass mute: ") + spa_strerror(result));
    return roundtripLocked(error);
  }

  bool waitForBypassMute(bool expected, std::chrono::milliseconds timeout, std::string* error) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      pw_thread_loop_lock(loop_);
      const bool refreshed = refreshBypassMuteLocked(error);
      const bool matches = refreshed && bypassMuteKnown_ && bypassMuted_ == expected;
      pw_thread_loop_unlock(loop_);
      if (!refreshed) return false;
      if (matches) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return fail(error, expected
        ? "WirePlumber did not prove bypass suppression within two seconds"
        : "WirePlumber did not prove bypass restoration within two seconds");
  }

  bool setAndProveBypassMute(bool muted, std::string* error) {
    pw_thread_loop_lock(loop_);
    if (bypassProxy_ == nullptr) {
      pw_thread_loop_unlock(loop_);
      return fail(error, "The policy bypass disappeared before restoration");
    }
    std::array<std::uint8_t, 256> storage{};
    spa_pod_builder builder{};
    spa_pod_builder_init(&builder, storage.data(), static_cast<std::uint32_t>(storage.size()));
    const auto* param = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_Props,
        SPA_PARAM_Props,
        SPA_PROP_mute, SPA_POD_Bool(muted)));
    const int result = pw_node_set_param(bypassProxy_, SPA_PARAM_Props, 0, param);
    pw_thread_loop_unlock(loop_);
    if (result < 0) return fail(error, std::string("Unable to restore the policy bypass: ") + spa_strerror(result));
    return waitForBypassMute(muted, kMuteProofTimeout, error);
  }

  bool probePrelinkedPolicy(std::string* error) {
    pw_thread_loop_lock(loop_);
    linkHistory_.clear();
    probeState_ = PW_STREAM_STATE_UNCONNECTED;
    probeStateError_.clear();
    probeStream_ = pw_stream_new(
        core_,
        "cpv-policy-probe",
        pw_properties_new(
            PW_KEY_MEDIA_TYPE, "Audio",
            PW_KEY_MEDIA_CATEGORY, "Playback",
            PW_KEY_MEDIA_ROLE, "Communication",
            PW_KEY_MEDIA_CLASS, "Stream/Output/Audio",
            PW_KEY_NODE_NAME, ("chatgpt-persona-voice.policy-probe." + routeId_).c_str(),
            PW_KEY_NODE_DESCRIPTION, "ChatGPT Persona Voice pre-link policy probe",
            PW_KEY_NODE_AUTOCONNECT, "true",
            PW_KEY_NODE_DONT_RECONNECT, "true",
            PW_KEY_APP_NAME,
            routeId_ == "chatgpt" ? "ChatGPT" : routeId_ == "codex" ? "Codex" : "Grok Bot",
            "chatgpt.persona.voice.policy-probe", routeId_.c_str(),
            nullptr));
    if (probeStream_ == nullptr) {
      pw_thread_loop_unlock(loop_);
      return fail(error, cpv::linux_audio::errnoMessage("Unable to create the pre-link policy probe"));
    }
    pw_stream_add_listener(probeStream_, &probeListener_, &probeEvents_, this);
    std::array<std::uint8_t, 1'024> storage{};
    spa_pod_builder builder{};
    auto params = buildAudioFormat(&storage, &builder);
    const int connectResult = pw_stream_connect(
        probeStream_,
        PW_DIRECTION_OUTPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(
            PW_STREAM_FLAG_AUTOCONNECT |
            PW_STREAM_FLAG_MAP_BUFFERS |
            PW_STREAM_FLAG_RT_PROCESS),
        params.data(),
        params.size());
    if (connectResult < 0) {
      destroyProbeLocked();
      pw_thread_loop_unlock(loop_);
      return fail(error, std::string("Unable to connect the pre-link policy probe: ") + spa_strerror(connectResult));
    }
    while (probeState_ != PW_STREAM_STATE_PAUSED && probeState_ != PW_STREAM_STATE_STREAMING &&
           probeState_ != PW_STREAM_STATE_ERROR) {
      pw_thread_loop_wait(loop_);
    }
    if (probeState_ == PW_STREAM_STATE_ERROR) {
      const std::string detail = probeStateError_.empty()
          ? "The pre-link policy probe entered an error state" : probeStateError_;
      destroyProbeLocked();
      pw_thread_loop_unlock(loop_);
      return fail(error, detail);
    }
    const std::uint32_t probeNodeId = pw_stream_get_node_id(probeStream_);
    std::size_t observedLinks = 0;
    bool physicalObserved = false;
    const auto deadline = std::chrono::steady_clock::now() + kMuteProofTimeout;
    while (std::chrono::steady_clock::now() < deadline && observedLinks < kChannels && !physicalObserved) {
      if (!roundtripLocked(error)) {
        destroyProbeLocked();
        pw_thread_loop_unlock(loop_);
        return false;
      }
      observedLinks = 0;
      physicalObserved = false;
      for (const LinkRecord& link : linkHistory_) {
        if (link.outputNode != probeNodeId) continue;
        ++observedLinks;
        if (link.inputNode != ingressNodeId_) physicalObserved = true;
      }
      if (observedLinks >= kChannels || physicalObserved) break;
      pw_thread_loop_unlock(loop_);
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
      pw_thread_loop_lock(loop_);
    }
    destroyProbeLocked();
    const bool synchronized = roundtripLocked(error);
    pw_thread_loop_unlock(loop_);
    if (!synchronized) return false;
    if (probeNodeId == SPA_ID_INVALID || observedLinks != kChannels || physicalObserved) {
      if (std::getenv("CPV_PIPEWIRE_DEBUG") != nullptr) {
        std::fprintf(
            stderr,
            "cpv policy probe node=%u ingress=%u observed=%zu physical=%s history=%zu\n",
            probeNodeId,
            ingressNodeId_,
            observedLinks,
            physicalObserved ? "true" : "false",
            linkHistory_.size());
        for (const LinkRecord& link : linkHistory_) {
          std::fprintf(stderr, "cpv link out=%u in=%u out-port=%u in-port=%u\n",
              link.outputNode, link.inputNode, link.outputPort, link.inputPort);
        }
      }
      return fail(error, "WirePlumber did not prove that the first policy-probe links target only Persona ingress");
    }
    return true;
  }

  void destroyProbeLocked() {
    if (probeStream_ != nullptr) {
      spa_hook_remove(&probeListener_);
      pw_stream_destroy(probeStream_);
      probeStream_ = nullptr;
    }
    probeState_ = PW_STREAM_STATE_UNCONNECTED;
    probeStateError_.clear();
  }

  void shutdown() {
    writerStop_.store(true, std::memory_order_release);
    wakeControl();
    if (writer_.joinable()) writer_.join();
    if (loop_ != nullptr && loopStarted_) pw_thread_loop_lock(loop_);
    destroyCaptureStreamLocked();
    destroyProbeLocked();
    if (bypassProxy_ != nullptr) {
      spa_hook_remove(&bypassListener_);
      pw_proxy_destroy(reinterpret_cast<pw_proxy*>(bypassProxy_));
      bypassProxy_ = nullptr;
    }
    if (registry_ != nullptr) {
      spa_hook_remove(&registryListener_);
      pw_proxy_destroy(reinterpret_cast<pw_proxy*>(registry_));
      registry_ = nullptr;
    }
    if (core_ != nullptr) {
      spa_hook_remove(&coreListener_);
      pw_core_disconnect(core_);
      core_ = nullptr;
    }
    if (loop_ != nullptr && loopStarted_) {
      pw_thread_loop_unlock(loop_);
      pw_thread_loop_stop(loop_);
      loopStarted_ = false;
    }
    if (context_ != nullptr) {
      pw_context_destroy(context_);
      context_ = nullptr;
    }
    if (loop_ != nullptr) {
      pw_thread_loop_destroy(loop_);
      loop_ = nullptr;
    }
    pw_deinit();
  }

  inline static const pw_core_events coreEvents_ = {
      .version = PW_VERSION_CORE_EVENTS,
      .done = onCoreDone,
      .error = onCoreError,
  };
  inline static const pw_registry_events registryEvents_ = {
      .version = PW_VERSION_REGISTRY_EVENTS,
      .global = onRegistryGlobal,
      .global_remove = onRegistryRemove,
  };
  inline static const pw_node_events bypassEvents_ = {
      .version = PW_VERSION_NODE_EVENTS,
      .info = onBypassInfo,
      .param = onBypassParam,
  };
  inline static const pw_stream_events captureEvents_ = {
      .version = PW_VERSION_STREAM_EVENTS,
      .state_changed = onCaptureState,
      .process = onCaptureProcess,
  };
  inline static const pw_stream_events probeEvents_ = {
      .version = PW_VERSION_STREAM_EVENTS,
      .state_changed = onProbeState,
      .process = onProbeProcess,
  };

  pw_thread_loop* loop_ = nullptr;
  pw_context* context_ = nullptr;
  pw_core* core_ = nullptr;
  pw_registry* registry_ = nullptr;
  pw_node* bypassProxy_ = nullptr;
  pw_stream* captureStream_ = nullptr;
  pw_stream* probeStream_ = nullptr;
  spa_hook coreListener_{};
  spa_hook registryListener_{};
  spa_hook bypassListener_{};
  spa_hook captureListener_{};
  spa_hook probeListener_{};
  bool loopStarted_ = false;
  int completedSequence_ = -1;
  std::string coreError_;
  std::map<std::uint32_t, NodeRecord> nodes_;
  std::map<std::uint32_t, PortRecord> ports_;
  std::map<std::uint32_t, LinkRecord> links_;
  std::vector<LinkRecord> linkHistory_;
  std::uint32_t ingressNodeId_ = SPA_ID_INVALID;
  std::uint32_t bypassNodeId_ = SPA_ID_INVALID;
  std::uint32_t captureNodeId_ = SPA_ID_INVALID;
  bool bypassMuteKnown_ = false;
  bool bypassMuted_ = false;
  pw_stream_state captureState_ = PW_STREAM_STATE_UNCONNECTED;
  pw_stream_state probeState_ = PW_STREAM_STATE_UNCONNECTED;
  std::string captureStateError_;
  std::string probeStateError_;
  bool engaged_ = false;
  std::atomic<bool> suppressed_{false};
  std::atomic<bool> captureEnabled_{false};
  CaptureQueue captureQueue_;
  std::atomic<bool> captureOverflow_{false};
  std::atomic<bool> writerFailed_{false};
  std::atomic<bool> writerStop_{false};
  std::thread writer_;
  const std::string routeId_;
  const std::string ingressNode_;
  const std::string bypassNode_;
};

void armParentDeathSignal() {
  const pid_t parent = getppid();
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) {
    stopRequested.store(true, std::memory_order_release);
  }
}

int runSelfTest() {
  for (const char* routeId : kRouteIds) {
    PipeWireCapture capture(routeId);
    std::string error;
    if (!capture.selfTest(&error)) {
      cpv::linux_audio::writeError(
          "self_test_failed",
          std::string("Route ") + routeId + ": " + error,
          false);
      return 1;
    }
  }
  PipeWireCapture capture("chatgpt");
  return capture.emitReady(true) ? 0 : 1;
}

int runCapture(const std::string& routeId) {
  SessionLock lease;
  std::string error;
  if (!lease.acquire(&error)) {
    cpv::linux_audio::writeError("capture_lease_unavailable", error, false);
    return 1;
  }
  armParentDeathSignal();
  if (stopRequested.load(std::memory_order_acquire)) {
    cpv::linux_audio::writeError("parent_process_lost", "The capture parent exited before acquisition", false);
    return 1;
  }

  PipeWireCapture capture(routeId);
  if (!capture.connect(&error)) {
    cpv::linux_audio::writeError("pipewire_unavailable", error, false);
    return 1;
  }
  if (!capture.emitReady(false)) return 1;
  if (!capture.engage(&error)) {
    const bool held = capture.isSuppressed();
    cpv::linux_audio::writeError("route_engage_failed", error, held);
    std::string releaseError;
    if (!capture.release(&releaseError)) {
      cpv::linux_audio::writeError("route_disengage_failed", releaseError, capture.isSuppressed());
    }
    return 1;
  }
  capture.startWriter();

  bool healthy = true;
  while (!stopRequested.load(std::memory_order_acquire)) {
    pollfd descriptor{wakeFd, POLLIN, 0};
    const int result = poll(&descriptor, 1, static_cast<int>(kControlInterval.count()));
    if (result > 0 && (descriptor.revents & POLLIN) != 0) {
      std::uint64_t value = 0;
      while (read(wakeFd, &value, sizeof(value)) > 0) {}
    }
    if (!capture.controlTick(&error)) {
      healthy = false;
      stopRequested.store(true, std::memory_order_release);
      cpv::linux_audio::writeError("route_liveness_failed", error, capture.isSuppressed());
    }
  }

  std::string releaseError;
  if (!capture.release(&releaseError)) {
    cpv::linux_audio::writeError("route_disengage_failed", releaseError, capture.isSuppressed());
    return 1;
  }
  return healthy ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  bool selfTest = false;
  std::string routeId;
  for (int index = 1; index < argc; ++index) {
    if (std::strcmp(argv[index], "--self-test") == 0) selfTest = true;
    else if (std::strcmp(argv[index], "--route") == 0 && index + 1 < argc) routeId = argv[++index];
    else {
      cpv::linux_audio::writeError(
          "invalid_arguments",
          "Usage: cpv-audio-capture --self-test | --route <chatgpt|codex|grok-bot>",
          false);
      return 2;
    }
  }
  const bool routeValid = std::find(kRouteIds.begin(), kRouteIds.end(), routeId) != kRouteIds.end();
  if ((selfTest && !routeId.empty()) || (!selfTest && !routeValid)) {
    cpv::linux_audio::writeError(
        "invalid_arguments",
        "Usage: cpv-audio-capture --self-test | --route <chatgpt|codex|grok-bot>",
        false);
    return 2;
  }

  std::signal(SIGINT, handleSignal);
  std::signal(SIGTERM, handleSignal);
  wakeFd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (wakeFd < 0) {
    cpv::linux_audio::writeError(
        "eventfd_failed",
        cpv::linux_audio::errnoMessage("Unable to create the capture wake event"),
        false);
    return 1;
  }
  const int result = selfTest ? runSelfTest() : runCapture(routeId);
  close(wakeFd);
  wakeFd = -1;
  return result;
}
