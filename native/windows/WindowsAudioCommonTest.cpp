#include "WindowsAudioCommon.hpp"

#include <iostream>
#include <string_view>

namespace {

int expect(bool condition, std::string_view message) {
  if (condition) return 0;
  std::cerr << message << '\n';
  return 1;
}

cpv::windows::VbCableDeviceIdentity pack45Identity() {
  return {
      .description = L"CABLE Input",
      .manufacturer = L"VB-Audio Software",
      .hardwareIds = {L"VBAudioVACWDM"},
      .service = L"VBAudioVACMME",
  };
}

}  // namespace

int main() {
  int failures = 0;

  failures += expect(
      cpv::windows::matchesVbCableInputIdentity(pack45Identity()),
      "Pack45 identity must remain valid when the legacy interface friendly name is absent");

  auto sixteenChannel = pack45Identity();
  sixteenChannel.description = L"CABLE In 16ch";
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(sixteenChannel),
      "The 16-channel endpoint must not be accepted as the base CABLE Input");

  auto wrongManufacturer = pack45Identity();
  wrongManufacturer.manufacturer = L"Unrelated Vendor";
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(wrongManufacturer),
      "A lookalike endpoint from another manufacturer must be rejected");

  auto wrongHardwareId = pack45Identity();
  wrongHardwareId.hardwareIds = {L"UNRELATED_AUDIO_DEVICE"};
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(wrongHardwareId),
      "A lookalike endpoint with another hardware ID must be rejected");

  auto wrongService = pack45Identity();
  wrongService.service = L"UnrelatedAudioService";
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(wrongService),
      "A lookalike endpoint using another service must be rejected");

  auto caseVariant = pack45Identity();
  caseVariant.manufacturer = L"vb-audio software";
  caseVariant.hardwareIds = {L"vbaudiovacwdm"};
  caseVariant.service = L"vbaudiovacmme";
  failures += expect(
      cpv::windows::matchesVbCableInputIdentity(caseVariant),
      "PnP identifiers must be compared case-insensitively");

  return failures == 0 ? 0 : 1;
}
