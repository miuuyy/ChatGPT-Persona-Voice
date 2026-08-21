#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <audioclient.h>
#include <fcntl.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <io.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <wrl/client.h>

#include "../shared/NativeProtocol.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace cpv::windows {

using Microsoft::WRL::ComPtr;

// These values come from VB-Audio's signed VBCABLE_Driver_Pack45 INF. Unlike
// PKEY_Device_FriendlyName, users cannot rename the endpoint description or
// adapter interface name from the Windows Sound control panel.
inline constexpr wchar_t kVbCableInputDeviceDescription[] = L"CABLE Input";
inline constexpr wchar_t kVbCableInterfaceFriendlyName[] = L"VB-Audio Point";
inline constexpr wchar_t kVbCableInputDisplayName[] = L"CABLE Input (VB-Audio Virtual Cable)";
inline constexpr char kVbCableInputIdentity[] = "vb-audio-vb-cable-input-v1";

inline bool setBinaryStandardStreams(bool includeInput) {
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return false;
  return !includeInput || _setmode(_fileno(stdin), _O_BINARY) != -1;
}

inline std::string jsonEscape(std::string_view value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    switch (character) {
      case '\"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          constexpr char digits[] = "0123456789abcdef";
          output << "\\u00" << digits[(character >> 4) & 0xf] << digits[character & 0xf];
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  return output.str();
}

inline std::string utf8FromWide(std::wstring_view value) {
  if (value.empty()) return {};
  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      nullptr, 0, nullptr, nullptr);
  if (required <= 0) return {};
  std::string result(static_cast<std::size_t>(required), '\0');
  const int written = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      result.data(), required, nullptr, nullptr);
  return written == required ? result : std::string{};
}

inline std::string hresultMessage(HRESULT result) {
  wchar_t* buffer = nullptr;
  const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
      FORMAT_MESSAGE_IGNORE_INSERTS;
  const DWORD length = FormatMessageW(
      flags, nullptr, static_cast<DWORD>(result), 0,
      reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  std::wstring message = length > 0 && buffer != nullptr
      ? std::wstring(buffer, length)
      : std::wstring{};
  if (buffer != nullptr) LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' ||
                              message.back() == L' ' || message.back() == L'.')) {
    message.pop_back();
  }
  std::ostringstream output;
  output << "HRESULT 0x" << std::hex << static_cast<std::uint32_t>(result);
  const std::string detail = utf8FromWide(message);
  if (!detail.empty()) output << " (" << detail << ")";
  return output.str();
}

inline bool writeJSON(cpv::FrameType type, const std::string& json) {
  if (json.size() > cpv::kMaximumPayloadBytes) return false;
  return cpv::writeFrame(
      stdout, type, json.data(), static_cast<std::uint32_t>(json.size()));
}

inline bool writeError(std::string_view code, std::string_view message,
                       bool includeSuppressionTruth = false,
                       bool suppressionHeld = false) {
  std::ostringstream json;
  json << "{\"type\":\"error\",\"code\":\"" << jsonEscape(code)
       << "\",\"message\":\"" << jsonEscape(message) << "\"";
  if (includeSuppressionTruth) {
    json << ",\"suppressionHeld\":" << (suppressionHeld ? "true" : "false");
  }
  json << "}";
  return writeJSON(cpv::FrameType::Error, json.str());
}

inline std::wstring defaultOutputDeviceId(std::wstring* friendlyName = nullptr) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = CoCreateInstance(
      __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      IID_PPV_ARGS(enumerator.GetAddressOf()));
  if (FAILED(result)) return {};
  ComPtr<IMMDevice> device;
  result = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.GetAddressOf());
  if (FAILED(result)) return {};
  LPWSTR rawId = nullptr;
  result = device->GetId(&rawId);
  if (FAILED(result) || rawId == nullptr) return {};
  std::wstring id(rawId);
  CoTaskMemFree(rawId);

  if (friendlyName != nullptr) {
    friendlyName->clear();
    ComPtr<IPropertyStore> properties;
    PROPVARIANT value;
    PropVariantInit(&value);
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf())) &&
        SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
        value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
      *friendlyName = value.pwszVal;
    }
    PropVariantClear(&value);
  }
  return id;
}

inline HRESULT deviceStringProperty(IMMDevice* device, const PROPERTYKEY& key,
                                    std::wstring* output) {
  if (device == nullptr || output == nullptr) return E_POINTER;
  output->clear();
  ComPtr<IPropertyStore> properties;
  HRESULT result = device->OpenPropertyStore(STGM_READ, properties.GetAddressOf());
  if (FAILED(result)) return result;
  PROPVARIANT value;
  PropVariantInit(&value);
  result = properties->GetValue(key, &value);
  if (SUCCEEDED(result) && value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
    *output = value.pwszVal;
  } else if (SUCCEEDED(result)) {
    result = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  }
  PropVariantClear(&value);
  return result;
}

inline bool isVbCableInput(IMMDevice* device) {
  std::wstring description;
  std::wstring interfaceName;
  return SUCCEEDED(deviceStringProperty(device, PKEY_Device_DeviceDesc, &description)) &&
      SUCCEEDED(deviceStringProperty(
          device, PKEY_DeviceInterface_FriendlyName, &interfaceName)) &&
      description == kVbCableInputDeviceDescription &&
      interfaceName == kVbCableInterfaceFriendlyName;
}

inline bool parseUnsigned(std::string_view value, std::uint32_t minimum,
                          std::uint32_t maximum, std::uint32_t* output) {
  if (value.empty() || output == nullptr) return false;
  std::uint64_t parsed = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') return false;
    parsed = parsed * 10 + static_cast<unsigned>(character - '0');
    if (parsed > maximum) return false;
  }
  if (parsed < minimum) return false;
  *output = static_cast<std::uint32_t>(parsed);
  return true;
}

class ScopedHandle {
 public:
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE value) : value_(value) {}
  ~ScopedHandle() { reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : value_(other.release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_{nullptr};
};

}  // namespace cpv::windows
