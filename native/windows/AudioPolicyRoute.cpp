#include "WindowsAudioCommon.hpp"

#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl/implements.h>

#include <atomic>
#include <chrono>
#include <limits>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using cpv::windows::ComPtr;
using cpv::windows::ScopedHandle;

constexpr std::chrono::milliseconds kReconciliationInterval{100};
constexpr std::chrono::milliseconds kSessionStopGrace{750};

std::atomic<bool> stopRequested{false};

struct ProcessTreeSnapshot {
  std::set<DWORD> processIds;
  bool anyRootAlive{false};
};

bool processTree(const std::vector<DWORD>& roots, ProcessTreeSnapshot* output) {
  if (output == nullptr) return false;
  output->processIds.clear();
  output->anyRootAlive = false;

  ScopedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.get(), &entry)) return false;

  const std::set<DWORD> rootSet(roots.begin(), roots.end());
  std::vector<std::pair<DWORD, DWORD>> relations;
  do {
    relations.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID);
    if (rootSet.contains(entry.th32ProcessID)) {
      output->processIds.insert(entry.th32ProcessID);
      output->anyRootAlive = true;
    }
    entry.dwSize = sizeof(entry);
  } while (Process32NextW(snapshot.get(), &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) return false;

  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto& [processId, parentId] : relations) {
      if (output->processIds.contains(parentId) &&
          output->processIds.insert(processId).second) {
        changed = true;
      }
    }
  }
  return true;
}

class SessionEventsSignal final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::FtmBase,
          IAudioSessionEvents> {
 public:
  explicit SessionEventsSignal(HANDLE wakeEvent) : wakeEvent_(wakeEvent) {}

  IFACEMETHODIMP OnDisplayNameChanged(LPCWSTR, LPCGUID) override { return S_OK; }
  IFACEMETHODIMP OnIconPathChanged(LPCWSTR, LPCGUID) override { return S_OK; }
  IFACEMETHODIMP OnSimpleVolumeChanged(float, BOOL, LPCGUID) override { return S_OK; }
  IFACEMETHODIMP OnChannelVolumeChanged(DWORD, float[], DWORD, LPCGUID) override {
    return S_OK;
  }
  IFACEMETHODIMP OnGroupingParamChanged(LPCGUID, LPCGUID) override { return S_OK; }
  IFACEMETHODIMP OnStateChanged(AudioSessionState) override {
    signal();
    return S_OK;
  }
  IFACEMETHODIMP OnSessionDisconnected(AudioSessionDisconnectReason) override {
    signal();
    return S_OK;
  }

 private:
  void signal() const {
    if (wakeEvent_ != nullptr) SetEvent(wakeEvent_);
  }

  HANDLE wakeEvent_{nullptr};
};

class SessionInventory;

class SessionCreatedSignal final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::FtmBase,
          IAudioSessionNotification> {
 public:
  SessionCreatedSignal(SessionInventory* inventory, std::wstring endpointId)
      : inventory_(inventory), endpointId_(std::move(endpointId)) {}

  IFACEMETHODIMP OnSessionCreated(IAudioSessionControl* newSession) override;

 private:
  SessionInventory* inventory_{nullptr};
  std::wstring endpointId_;
};

class DeviceChangeSignal final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::FtmBase,
          IMMNotificationClient> {
 public:
  DeviceChangeSignal(std::atomic<bool>* topologyChanged, HANDLE wakeEvent)
      : topologyChanged_(topologyChanged), wakeEvent_(wakeEvent) {}

  IFACEMETHODIMP OnDeviceStateChanged(LPCWSTR, DWORD) override { return changed(); }
  IFACEMETHODIMP OnDeviceAdded(LPCWSTR) override { return changed(); }
  IFACEMETHODIMP OnDeviceRemoved(LPCWSTR) override { return changed(); }
  IFACEMETHODIMP OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override {
    return changed();
  }
  IFACEMETHODIMP OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override {
    return changed();
  }

 private:
  HRESULT changed() const {
    if (topologyChanged_ != nullptr) {
      topologyChanged_->store(true, std::memory_order_release);
    }
    if (wakeEvent_ != nullptr) SetEvent(wakeEvent_);
    return S_OK;
  }

  std::atomic<bool>* topologyChanged_{nullptr};
  HANDLE wakeEvent_{nullptr};
};

struct TrackedSession {
  std::wstring key;
  std::wstring endpointId;
  ComPtr<IAudioSessionControl> control;
  ComPtr<IAudioSessionControl2> control2;
};

struct EndpointRegistration {
  ComPtr<IAudioSessionManager2> manager;
  ComPtr<SessionCreatedSignal> notification;
};

struct Membership {
  bool complete{false};
  bool anyTargetSession{false};
  bool anyTargetSessionOutsideSink{false};
};

class SessionInventory {
 public:
  SessionInventory() : wakeEvent_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}
  ~SessionInventory() { shutdown(); }
  SessionInventory(const SessionInventory&) = delete;
  SessionInventory& operator=(const SessionInventory&) = delete;

  HRESULT initialize() {
    if (!wakeEvent_) return HRESULT_FROM_WIN32(GetLastError());
    sessionEvents_ = Microsoft::WRL::Make<SessionEventsSignal>(wakeEvent_.get());
    deviceEvents_ = Microsoft::WRL::Make<DeviceChangeSignal>(
        &topologyChanged_, wakeEvent_.get());
    if (!sessionEvents_ || !deviceEvents_) return E_OUTOFMEMORY;

    HRESULT result = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        IID_PPV_ARGS(enumerator_.GetAddressOf()));
    if (FAILED(result)) return result;
    result = enumerator_->RegisterEndpointNotificationCallback(deviceEvents_.Get());
    if (FAILED(result)) return result;
    deviceEventsRegistered_ = true;

    ComPtr<IMMDeviceCollection> devices;
    result = enumerator_->EnumAudioEndpoints(
        eRender, DEVICE_STATE_ACTIVE, devices.GetAddressOf());
    if (FAILED(result)) return result;
    UINT count = 0;
    result = devices->GetCount(&count);
    if (FAILED(result)) return result;
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      result = devices->Item(index, device.GetAddressOf());
      if (FAILED(result)) return result;
      LPWSTR rawEndpointId = nullptr;
      result = device->GetId(&rawEndpointId);
      if (FAILED(result) || rawEndpointId == nullptr) {
        if (rawEndpointId != nullptr) CoTaskMemFree(rawEndpointId);
        return FAILED(result) ? result : E_FAIL;
      }
      std::wstring endpointId(rawEndpointId);
      CoTaskMemFree(rawEndpointId);

      ComPtr<IAudioSessionManager2> manager;
      result = device->Activate(
          __uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
          reinterpret_cast<void**>(manager.GetAddressOf()));
      if (FAILED(result)) return result;
      ComPtr<SessionCreatedSignal> notification =
          Microsoft::WRL::Make<SessionCreatedSignal>(this, endpointId);
      if (!notification) return E_OUTOFMEMORY;
      result = manager->RegisterSessionNotification(notification.Get());
      if (FAILED(result)) return result;
      registrations_.push_back(EndpointRegistration{manager, notification});

      ComPtr<IAudioSessionEnumerator> sessions;
      result = manager->GetSessionEnumerator(sessions.GetAddressOf());
      if (FAILED(result)) return result;
      int sessionCount = 0;
      result = sessions->GetCount(&sessionCount);
      if (FAILED(result)) return result;
      for (int sessionIndex = 0; sessionIndex < sessionCount; ++sessionIndex) {
        ComPtr<IAudioSessionControl> control;
        result = sessions->GetSession(sessionIndex, control.GetAddressOf());
        if (FAILED(result)) return result;
        result = add(endpointId, control.Get());
        if (FAILED(result)) return result;
      }
    }
    return S_OK;
  }

  HRESULT add(const std::wstring& endpointId, IAudioSessionControl* control) {
    if (control == nullptr) return E_POINTER;
    ComPtr<IAudioSessionControl> retained;
    HRESULT result = control->QueryInterface(IID_PPV_ARGS(retained.GetAddressOf()));
    if (FAILED(result)) return markIncomplete(result);
    ComPtr<IAudioSessionControl2> control2;
    result = retained.As(&control2);
    if (FAILED(result)) return markIncomplete(result);
    LPWSTR rawIdentifier = nullptr;
    result = control2->GetSessionInstanceIdentifier(&rawIdentifier);
    if (FAILED(result) || rawIdentifier == nullptr) {
      if (rawIdentifier != nullptr) CoTaskMemFree(rawIdentifier);
      return markIncomplete(FAILED(result) ? result : E_FAIL);
    }
    std::wstring key(endpointId);
    key.push_back(L'\n');
    key.append(rawIdentifier);
    CoTaskMemFree(rawIdentifier);

    std::lock_guard lock(mutex_);
    if (!accepting_) return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
    for (const TrackedSession& session : sessions_) {
      if (session.key == key) return S_OK;
    }
    result = retained->RegisterAudioSessionNotification(sessionEvents_.Get());
    if (FAILED(result)) {
      complete_ = false;
      SetEvent(wakeEvent_.get());
      return result;
    }
    sessions_.push_back(TrackedSession{
        std::move(key), endpointId, std::move(retained), std::move(control2)});
    SetEvent(wakeEvent_.get());
    return S_OK;
  }

  Membership evaluate(const std::set<DWORD>& processIds,
                      std::wstring_view sinkId) {
    std::lock_guard lock(mutex_);
    Membership result;
    if (!complete_ || topologyChanged_.load(std::memory_order_acquire)) return result;
    result.complete = true;
    for (const TrackedSession& session : sessions_) {
      DWORD processId = 0;
      AudioSessionState state = AudioSessionStateInactive;
      if (FAILED(session.control2->GetProcessId(&processId)) ||
          FAILED(session.control->GetState(&state))) {
        result.complete = false;
        return result;
      }
      if (state != AudioSessionStateActive || !processIds.contains(processId)) continue;
      result.anyTargetSession = true;
      if (session.endpointId != sinkId) result.anyTargetSessionOutsideSink = true;
    }
    return result;
  }

  HANDLE wakeEvent() const { return wakeEvent_.get(); }

  bool topologyChanged() const {
    return topologyChanged_.load(std::memory_order_acquire);
  }

  void shutdown() {
    {
      std::lock_guard lock(mutex_);
      if (!accepting_) return;
      accepting_ = false;
    }
    if (deviceEventsRegistered_ && enumerator_) {
      enumerator_->UnregisterEndpointNotificationCallback(deviceEvents_.Get());
      deviceEventsRegistered_ = false;
    }
    for (EndpointRegistration& registration : registrations_) {
      registration.manager->UnregisterSessionNotification(registration.notification.Get());
    }
    registrations_.clear();
    {
      std::lock_guard lock(mutex_);
      for (TrackedSession& session : sessions_) {
        session.control->UnregisterAudioSessionNotification(sessionEvents_.Get());
      }
      sessions_.clear();
    }
    deviceEvents_.Reset();
    sessionEvents_.Reset();
    enumerator_.Reset();
  }

 private:
  HRESULT markIncomplete(HRESULT result) {
    {
      std::lock_guard lock(mutex_);
      complete_ = false;
    }
    if (wakeEvent_) SetEvent(wakeEvent_.get());
    return result;
  }

  ScopedHandle wakeEvent_;
  ComPtr<IMMDeviceEnumerator> enumerator_;
  ComPtr<DeviceChangeSignal> deviceEvents_;
  ComPtr<SessionEventsSignal> sessionEvents_;
  std::vector<EndpointRegistration> registrations_;
  std::vector<TrackedSession> sessions_;
  mutable std::mutex mutex_;
  std::atomic<bool> topologyChanged_{false};
  bool deviceEventsRegistered_{false};
  bool accepting_{true};
  bool complete_{true};
};

HRESULT SessionCreatedSignal::OnSessionCreated(IAudioSessionControl* newSession) {
  return inventory_ == nullptr ? E_UNEXPECTED : inventory_->add(endpointId_, newSession);
}

HRESULT validateSink(std::wstring_view requestedId) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = CoCreateInstance(
      __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      IID_PPV_ARGS(enumerator.GetAddressOf()));
  if (FAILED(result)) return result;
  ComPtr<IMMDevice> device;
  result = enumerator->GetDevice(std::wstring(requestedId).c_str(), device.GetAddressOf());
  if (FAILED(result)) return result;
  DWORD state = 0;
  result = device->GetState(&state);
  if (FAILED(result) || (state & DEVICE_STATE_ACTIVE) == 0) {
    return FAILED(result) ? result : HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_AVAILABLE);
  }
  if (!cpv::windows::isVbCableInput(device.Get())) {
    return E_ACCESSDENIED;
  }
  return S_OK;
}

std::vector<std::wstring> installedVbCableInputIds(bool* complete) {
  *complete = false;
  std::vector<std::wstring> matches;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(
          __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
          IID_PPV_ARGS(enumerator.GetAddressOf())))) return matches;
  ComPtr<IMMDeviceCollection> devices;
  if (FAILED(enumerator->EnumAudioEndpoints(
          eRender, DEVICE_STATE_ACTIVE, devices.GetAddressOf()))) return matches;
  UINT count = 0;
  if (FAILED(devices->GetCount(&count))) return matches;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(devices->Item(index, device.GetAddressOf()))) return {};
    if (!cpv::windows::isVbCableInput(device.Get())) continue;
    LPWSTR rawId = nullptr;
    if (FAILED(device->GetId(&rawId)) || rawId == nullptr) {
      if (rawId != nullptr) CoTaskMemFree(rawId);
      return {};
    }
    matches.emplace_back(rawId);
    CoTaskMemFree(rawId);
  }
  *complete = true;
  return matches;
}

bool emitReady(bool selfTest, std::size_t virtualCableCount, bool engaged,
               std::wstring_view endpointId = {}) {
  std::ostringstream json;
  json << "{\"type\":\"ready\",\"helper\":\"route\",\"protocolVersion\":1"
       << ",\"backend\":\"windows-virtual-endpoint-verifier\""
       << ",\"virtualCableInstalled\":" << (virtualCableCount == 1 ? "true" : "false")
       << ",\"virtualCableCount\":" << virtualCableCount
       << ",\"sinkName\":\"CABLE Input (VB-Audio Virtual Cable)\""
       << ",\"sinkIdentity\":\"vb-audio-vb-cable-input-v1\""
       << ",\"routeMutation\":false"
       << ",\"manualAssignmentRequired\":true"
       << ",\"restoreRequired\":true"
       << ",\"restoreMechanism\":\"manual-volume-mixer\""
       << ",\"standbyPassthroughRequired\":true"
       << ",\"supportsCurrentSessionMembershipProof\":true"
       << ",\"supportsEventDrivenMonitoring\":true"
       << ",\"notificationGuaranteesPreAudio\":false"
       << ",\"proofScope\":\"current-live-sessions\""
       << ",\"armed\":true"
       << ",\"state\":\"" << (engaged ? "engaged" : "armed") << "\""
       << ",\"originalSuppressed\":" << (engaged ? "true" : "false")
       << ",\"selfTest\":" << (selfTest ? "true" : "false");
  if (!endpointId.empty()) {
    json << ",\"endpointId\":\""
         << cpv::windows::jsonEscape(cpv::windows::utf8FromWide(endpointId)) << "\"";
  }
  json << "}";
  return cpv::windows::writeJSON(cpv::FrameType::Ready, json.str());
}

bool emitStatus(bool engaged, std::string_view reason) {
  std::ostringstream json;
  json << "{\"type\":\"status\",\"helper\":\"route\",\"state\":\""
       << (engaged ? "engaged" : "armed") << "\",\"reason\":\""
       << cpv::windows::jsonEscape(reason) << "\",\"originalSuppressed\":"
       << (engaged ? "true" : "false")
       << ",\"routeVerified\":true}";
  return cpv::windows::writeJSON(cpv::FrameType::Status, json.str());
}

int fail(std::string_view code, std::string_view message, bool suppressionHeld) {
  cpv::windows::writeError(code, message, true, suppressionHeld);
  return 1;
}

int runGuard(const std::vector<DWORD>& roots, const std::wstring& sinkId) {
  HRESULT result = validateSink(sinkId);
  if (FAILED(result)) {
    return fail(
        "windows_virtual_sink_invalid",
        "The selected suppression endpoint is not the official VB-CABLE Input: " +
            cpv::windows::hresultMessage(result),
        false);
  }

  SessionInventory inventory;
  result = inventory.initialize();
  if (FAILED(result)) {
    return fail(
        "windows_session_monitor_initialization_failed",
        "Windows could not subscribe to every active render endpoint and session: " +
            cpv::windows::hresultMessage(result),
        false);
  }

  ProcessTreeSnapshot tree;
  if (!processTree(roots, &tree)) {
    return fail("windows_process_tree_enumeration_failed",
                "Windows could not prove the selected process tree", false);
  }
  if (!tree.anyRootAlive) {
    return fail("source_process_exited", "The selected Windows application exited", false);
  }
  Membership current = inventory.evaluate(tree.processIds, sinkId);
  if (!current.complete) {
    return fail("windows_session_enumeration_failed",
                "Windows could not prove every active render session", false);
  }
  if (current.anyTargetSessionOutsideSink) {
    return fail(
        "windows_target_route_not_isolated",
        "Route ChatGPT/Codex to CABLE Input (VB-Audio Virtual Cable) in Windows Volume Mixer before starting voice",
        false);
  }
  bool engaged = current.anyTargetSession;
  if (!emitReady(false, 1, engaged, sinkId)) return 1;

  std::thread inputWatcher([wakeEvent = inventory.wakeEvent()] {
    char byte = 0;
    while (fread(&byte, 1, 1, stdin) == 1) {
      if (byte == 'q') break;
    }
    stopRequested.store(true, std::memory_order_release);
    if (wakeEvent != nullptr) SetEvent(wakeEvent);
  });

  auto noSessionSince = std::chrono::steady_clock::now();
  int exitCode = 0;
  while (!stopRequested.load(std::memory_order_acquire)) {
    if (inventory.topologyChanged()) {
      fail("windows_audio_topology_changed",
           "The Windows audio endpoint topology changed; relay stopped until the route is re-probed",
           engaged);
      exitCode = 1;
      break;
    }
    if (!processTree(roots, &tree)) {
      fail("windows_process_tree_enumeration_failed",
           "Windows could no longer prove the selected process tree", engaged);
      exitCode = 1;
      break;
    }
    if (!tree.anyRootAlive) {
      fail("source_process_exited", "The selected Windows application exited", false);
      exitCode = 1;
      break;
    }
    current = inventory.evaluate(tree.processIds, sinkId);
    if (!current.complete) {
      fail("windows_session_enumeration_failed",
           "Windows could no longer prove every render session", engaged);
      exitCode = 1;
      break;
    }
    if (current.anyTargetSessionOutsideSink) {
      fail("windows_target_route_lost",
           "A live target audio session appeared outside VB-CABLE Input; relay stopped fail-closed",
           false);
      exitCode = 1;
      break;
    }
    if (current.anyTargetSession) {
      noSessionSince = std::chrono::steady_clock::now();
      if (!engaged) {
        engaged = true;
        if (!emitStatus(true, "target_session_isolated")) {
          exitCode = 1;
          break;
        }
      }
    } else if (engaged &&
               std::chrono::steady_clock::now() - noSessionSince >= kSessionStopGrace) {
      engaged = false;
      if (!emitStatus(false, "target_session_ended")) {
        exitCode = 1;
        break;
      }
    }
    const DWORD waitResult = WaitForSingleObject(
        inventory.wakeEvent(), static_cast<DWORD>(kReconciliationInterval.count()));
    if (waitResult != WAIT_OBJECT_0 && waitResult != WAIT_TIMEOUT) {
      fail("windows_route_monitor_wait_failed",
           "Waiting for a Windows audio-session notification failed", engaged);
      exitCode = 1;
      break;
    }
  }

  if (exitCode == 0 && engaged && !emitStatus(false, "route_guard_released")) exitCode = 1;
  stopRequested.store(true, std::memory_order_release);
  if (inventory.wakeEvent() != nullptr) SetEvent(inventory.wakeEvent());
  if (inputWatcher.joinable()) {
    CancelSynchronousIo(static_cast<HANDLE>(inputWatcher.native_handle()));
    inputWatcher.join();
  }
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (!cpv::windows::setBinaryStandardStreams(true)) return 1;
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) {
    return fail("com_initialization_failed",
                "COM initialization failed: " + cpv::windows::hresultMessage(comResult), false);
  }

  bool selfTest = false;
  bool invalid = false;
  std::wstring sinkId;
  std::vector<DWORD> roots;
  for (int index = 1; index < argc; ++index) {
    const std::wstring_view argument(argv[index]);
    if (argument == L"--self-test") {
      selfTest = true;
    } else if (argument == L"--root-pid" && index + 1 < argc) {
      std::uint32_t processId = 0;
      const std::string value = cpv::windows::utf8FromWide(argv[++index]);
      if (!cpv::windows::parseUnsigned(
              value, 1, std::numeric_limits<DWORD>::max(), &processId)) {
        invalid = true;
      } else {
        roots.push_back(processId);
      }
    } else if (argument == L"--suppression-endpoint-id" && index + 1 < argc) {
      sinkId = argv[++index];
      if (sinkId.empty() || sinkId.size() > 4'096) invalid = true;
    } else {
      invalid = true;
    }
  }

  int exitCode = 0;
  if (invalid || (!selfTest && (roots.empty() || sinkId.empty())) ||
      (selfTest && (!roots.empty() || !sinkId.empty()))) {
    exitCode = fail(
        "invalid_arguments",
        "Use --self-test or --suppression-endpoint-id <id> with one or more --root-pid values",
        false);
  } else if (selfTest) {
    bool complete = false;
    const std::vector<std::wstring> sinks = installedVbCableInputIds(&complete);
    if (!complete) {
      exitCode = fail("windows_sink_enumeration_failed",
                      "Windows could not enumerate every active render endpoint", false);
    } else {
      exitCode = emitReady(
          true, sinks.size(), false,
          sinks.size() == 1 ? std::wstring_view(sinks.front()) : std::wstring_view{})
          ? 0 : 1;
    }
  } else {
    exitCode = runGuard(roots, sinkId);
  }

  CoUninitialize();
  return exitCode;
}
