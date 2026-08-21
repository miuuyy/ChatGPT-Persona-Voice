"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

function state(value) {
  return {
    status: value.status,
    code: value.code,
    detail: value.detail,
    canInstall: value.canInstall === true,
    canActivate: value.canActivate === true,
    requiresRouteAssignment: value.requiresRouteAssignment === true,
    canRemove: value.canRemove === true,
  };
}

function runLinuxPolicyWorker(action, {
  workerPath = path.join(__dirname, "linux-audio-policy-worker.cjs"),
  WorkerClass = Worker,
} = {}) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(workerPath, { workerData: { action } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    worker.once("message", (message) => {
      if (message?.ok === true) {
        finish(null, message.value);
        return;
      }
      const error = new Error(message?.error?.message || "Linux audio policy worker failed");
      if (typeof message?.error?.code === "string") error.code = message.error.code;
      finish(error);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Linux audio policy worker exited with code ${String(code)}`));
      else if (!settled) finish(new Error("Linux audio policy worker exited without a result"));
    });
  });
}

class PlatformAudioSetupController {
  constructor({
    platform = process.platform,
    linuxPolicy = null,
    linuxProcessRoute = null,
    windowsIntegration = null,
    runLinuxAction = runLinuxPolicyWorker,
    publish = null,
    logger = null,
  } = {}) {
    this.platform = platform;
    this.linuxPolicy = linuxPolicy;
    this.linuxProcessRoute = linuxProcessRoute;
    this.windowsIntegration = windowsIntegration;
    this.runLinuxAction = runLinuxAction;
    this.publish = publish;
    this.logger = logger;
    this.current = state({
      status: platform === "darwin" ? "ready" : "unavailable",
      code: platform === "darwin" ? "ready" : "platform_audio_setup_unavailable",
      detail: platform === "darwin"
        ? "Core Audio process routing is built into this application"
        : "Platform audio setup has not been inspected",
      canRemove: false,
    });
    this.operation = null;
  }

  getState() {
    return { ...this.current };
  }

  transition(next) {
    this.current = state(next);
    this.publish?.(this.getState());
    return this.getState();
  }

  async inspect(settings) {
    if (this.platform === "darwin") {
      return this.transition({
        status: "ready",
        code: "ready",
        detail: "Core Audio process routing is built into this application",
      });
    }
    if (this.platform === "linux") return this.inspectLinux();
    if (this.platform === "win32") return this.inspectWindows(settings);
    return this.transition({
      status: "unavailable",
      code: "platform_audio_setup_unsupported",
      detail: `Audio routing is not supported on ${this.platform}`,
    });
  }

  async inspectLinux() {
    if (!this.linuxPolicy || !this.linuxProcessRoute) {
      return this.transition({
        status: "unavailable",
        code: "linux_audio_setup_missing",
        detail: "The Linux audio policy components are not bundled",
      });
    }
    try {
      const policy = this.linuxPolicy.inspectPolicy();
      if (policy.conflict) {
        return this.transition({
          status: "error",
          code: "linux_audio_policy_conflict",
          detail: "An unmanaged file conflicts with the Persona Voice PipeWire policy",
        });
      }
      if (!policy.installed || policy.reloadRequired) {
        return this.transition({
          status: "action-required",
          code: policy.installed ? "linux_audio_reload_required" : "linux_audio_policy_required",
          detail: policy.installed
            ? "The Persona Voice audio policy must be activated once"
            : "Install the owned PipeWire and WirePlumber route before using voice conversion",
          canInstall: true,
          canRemove: policy.installed,
        });
      }
      const helper = await this.linuxProcessRoute.helperReadiness();
      if (!helper.ready) {
        return this.transition({
          status: "error",
          code: helper.code || "linux_audio_policy_probe_failed",
          detail: helper.detail || "The live Linux audio policy probe failed",
          canInstall: true,
          canRemove: true,
        });
      }
      return this.transition({
        status: "ready",
        code: "ready",
        detail: "The owned PipeWire and WirePlumber route passed its live isolation probe",
        canRemove: true,
      });
    } catch (error) {
      return this.transition({
        status: "error",
        code: error?.code || "linux_audio_setup_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async inspectWindows(settings) {
    const integration = this.windowsIntegration;
    if (!integration) {
      return this.transition({
        status: "unavailable",
        code: "windows_audio_setup_missing",
        detail: "The Windows audio integration is not bundled",
      });
    }
    const lifecycle = integration.routeLifecycle.snapshot();
    if (lifecycle.standbyActive) {
      return this.transition({
        status: "ready",
        code: "ready",
        detail: "VB-CABLE Input is isolated and standby passthrough is active",
      });
    }
    const helper = await integration.rawProcessRoute.helperReadiness();
    if (!helper.ready) {
      const cableMissing = helper.code === "windows_vb_cable_required";
      return this.transition({
        status: cableMissing ? "action-required" : "error",
        code: helper.code || "windows_audio_setup_failed",
        detail: cableMissing
          ? "Install VB-CABLE from the official VB-Audio site, restart Windows, then check again"
          : helper.detail,
      });
    }
    if (!settings) {
      return this.transition({
        status: "action-required",
        code: "windows_source_required",
        detail: "Open ChatGPT or Codex before verifying its Windows output route",
        canActivate: true,
        requiresRouteAssignment: true,
      });
    }
    return this.transition({
      status: "action-required",
      code: "windows_route_assignment_required",
      detail: "Assign ChatGPT or Codex output to CABLE Input in Windows Volume Mixer",
      canActivate: true,
      requiresRouteAssignment: true,
    });
  }

  runExclusive(label, operation) {
    if (this.operation) throw new Error(`Platform audio ${this.operation.label} is already running`);
    const pending = (async () => operation())();
    this.operation = { label, pending };
    return pending.finally(() => {
      if (this.operation?.pending === pending) this.operation = null;
    });
  }

  install(settings) {
    if (this.platform !== "linux") {
      throw new Error("Platform audio installation is available only for the Linux user policy");
    }
    return this.runExclusive("installation", async () => {
      this.transition({
        status: "installing",
        code: "linux_audio_policy_installing",
        detail: "Installing the owned Linux audio route and restarting the user audio session",
      });
      try {
        await this.runLinuxAction("install");
        return await this.inspectLinux();
      } catch (error) {
        this.logger?.error("linux.audio_policy_install_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return this.transition({
          status: "error",
          code: error?.code || "linux_audio_policy_install_failed",
          detail: error instanceof Error ? error.message : String(error),
          canInstall: true,
        });
      }
    });
  }

  activate(settings, handlers = {}) {
    if (this.platform !== "win32" || !this.windowsIntegration) {
      throw new Error("Platform audio route verification is available only on Windows");
    }
    return this.runExclusive("activation", async () => {
      this.transition({
        status: "installing",
        code: "windows_route_verifying",
        detail: "Verifying the selected application route and starting standby passthrough",
      });
      try {
        await this.windowsIntegration.routeLifecycle.startStandby(settings, handlers);
        return await this.inspectWindows(settings);
      } catch (error) {
        this.logger?.error("windows.audio_route_activation_failed", {
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        });
        return this.transition({
          status: "error",
          code: error?.code || "windows_route_activation_failed",
          detail: error instanceof Error ? error.message : String(error),
          canActivate: true,
          requiresRouteAssignment: true,
        });
      }
    });
  }

  remove() {
    if (this.platform !== "linux") {
      throw new Error("Platform audio removal is available only for the Linux user policy");
    }
    return this.runExclusive("removal", async () => {
      this.transition({
        status: "installing",
        code: "linux_audio_policy_removing",
        detail: "Removing the owned Linux audio route and restarting the user audio session",
      });
      try {
        await this.runLinuxAction("remove");
        return await this.inspectLinux();
      } catch (error) {
        return this.transition({
          status: "error",
          code: error?.code || "linux_audio_policy_remove_failed",
          detail: error instanceof Error ? error.message : String(error),
          canRemove: true,
        });
      }
    });
  }

  routeError(error) {
    return this.transition({
      status: "error",
      code: error?.code || "platform_audio_route_failed",
      detail: error instanceof Error ? error.message : String(error),
      canActivate: this.platform === "win32",
      requiresRouteAssignment: this.platform === "win32",
    });
  }
}

module.exports = { PlatformAudioSetupController, runLinuxPolicyWorker, state };
