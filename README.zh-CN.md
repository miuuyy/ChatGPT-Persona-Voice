<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>在 ChatGPT 桌面应用说话时，实时替换它的声音。</strong><br>
  通过本地优先的 Seed-VC 实现近实时播放。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/app-desktop-black?logo=electron" alt="桌面应用">
  <img src="https://img.shields.io/badge/inference-local-10a37f" alt="Local inference">
  <img src="https://img.shields.io/badge/engine-Seed--VC-7c5cff" alt="Seed-VC engine">
</p>

<p align="center">
  <img src="assets/architecture-visual-v2.png" alt="ChatGPT 音频经过本地 Seed-VC 层后输出到扬声器" width="1200">
</p>

Codex Persona Voice 是一款独立桌面应用，能够近实时改变 ChatGPT 与 Codex 语音模式的
声音。对话仍留在原应用中，语音转换则在你的设备上本地运行。输出质量与时序会因
硬件、输入音频和所选参考而异。

> [!IMPORTANT]
> 当前语音转换在日语和中文输入上效果最佳。英语及其他语言也可以工作，但发音和音色一致性
> 可能有所波动。我们尤其欢迎帮助改进多语言质量、参考音频处理与引擎配置的贡献。

## 为什么选择 Persona Voice

- **近实时转换。** 当前 Seed-VC 配置以短音频块处理语音，并在转换完成后立即流式输出。
  实际延迟会因硬件和音频路由而异。
- **替换原声，而不是叠加播放。** Persona Voice 会抑制所选应用的原始播放，
  并把转换后的声音发送到扬声器。
- **本地推理。** 安装后的转换在你的设备上运行，不需要语音 API 密钥。
- **预设声音与私有参考音频。** 内置目录包含标注来源的 VOICEVOX 角色，以及少量社区和
  演示参考。你也可以添加自己有权使用的私有参考音频。
- **个性化。** 选择内置音色、添加你有权使用的私有参考音频，并为每个声音搭配独立角色场景，
  让声音与角色保持一致。
- **可控的本地历史。** 历史记录默认关闭。启用后也只保存转换后的音频，并默认在六小时后
  自动清理，也可立即清空。

## 工作原理

```text
ChatGPT / Codex 应用
        │ 语音输出
        ▼
Persona Voice 音频路由
        ▼
本地 Seed-VC 转换
        │
        ▼
扬声器
```

Persona Voice 会在所选应用、本地引擎和输出路由全部就绪后才替换原始播放。
如果无法安全建立路由，转换不会开始。

详细内容参见[架构](docs/ARCHITECTURE.md)、[原生协议](docs/NATIVE_PROTOCOL.md)和
[引擎契约](docs/ENGINE_CONTRACT.md)。

## 演示

https://github.com/user-attachments/assets/f43f9f90-a76f-4984-b061-145aa7db5467

## 快速开始

### 下载并使用

从 [Releases](https://github.com/miuuyy/ChatGPT-Persona-Voice/releases/latest) 下载最新的 macOS、Windows 或 Linux 版本。
Windows 设置会打开官方 [VB-CABLE](https://vb-audio.com/Cable/) 下载页面；请单独安装、重启
Windows，然后按应用内的音量合成器步骤操作。

1. 启动 Persona Voice，按引导完成引擎与系统音频设置。
2. 打开 ChatGPT 或 Codex，然后在 Persona Voice 中选择来源应用和目标声音。
3. 点击 **启动语音转换**，再进入 ChatGPT 或 Codex 的语音模式。

要求见[平台状态](#平台状态)；如果设置受阻，请查看[故障排除](docs/TROUBLESHOOTING.md)。

### 从源码运行

你需要：

- Git、Bun 1.3.14、Node.js 22.12+ 和 [`uv`](https://docs.astral.sh/uv/)；
- 以下任一合格主机配置：带 MPS 的 Apple Silicon macOS 14.2+、带受支持 NVIDIA CUDA
  驱动的 x64 Linux，或 Windows build 20348+ x64 与受支持 NVIDIA CUDA 驱动；
- 平台原生工具链：macOS 上的 Xcode Command Line Tools，Linux 上的 C++20 编译器与
  `pkg-config`/PipeWire 开发头文件，或 Windows 上的 MSVC/CMake/Windows SDK；
- 引擎空间：macOS 安装约 2.5 GiB且至少空闲 6 GiB；Windows 安装约 9 GiB且至少空闲
  15 GiB；Linux 安装约 11 GiB且至少空闲 15 GiB。
- Windows 还需要单独安装 VB-Audio 官方 VB-CABLE 驱动。

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

Linux 源码运行还需要 PipeWire 和 WirePlumber。平台设置、原生构建命令与贡献者
验证步骤见[开发指南](docs/DEVELOPMENT.md)。

## 平台状态

| 平台 | 可用性 | 要求与当前限制 |
| --- | --- | --- |
| Apple Silicon macOS 14.2+ | 提供预览包 | MPS；仍需生产签名／公证和全新设备验证 |
| Linux x64 + NVIDIA | 提供预览包 | CUDA 13.0、PipeWire 和 WirePlumber；仍需更广泛的发行版覆盖 |
| Windows x64 + NVIDIA，build 20348+ | 提供预览包 | CUDA 13.0 和单独安装的 VB-CABLE；欢迎提供实体 Windows 主机反馈 |
| 其他主机 | 不可用 | 不支持 |

详见[平台矩阵](docs/PLATFORM_MATRIX.md)与
[发布门槛](docs/RELEASE.md)。

## 声音参考

内置目录目前包括四国めたん、ずんだもん、春日部つむぎ、冥鳴ひまり、九州そら、
WhiteCUL、櫻歌ミコ、小夜/SAYO、春歌ナナ、猫使アル、満別花丸、
琴詠ニア、社区 JARVIS 参考，以及未获官方关联的 Donald Trump 演示音色。

VOICEVOX 样本由官方展示音频构建，并保留必要署名。社区与公众人物参考继续受各自条款
约束，不得被描述为真实录音或官方背书。请只使用你有权使用的声音。详见
[声音 manifest](voices/manifest.json)与单一的
[第三方声明清单](THIRD_PARTY_NOTICES.md)。

## 安全与隐私

- 原始捕获 PCM 不会被有意保存或写入日志。
- 历史记录只接受已提交给输出会话的转换后帧。
- 只有在本地引擎和音频路由就绪后，才会开始语音替换。
- 设置、日志、模型、参考音频和可选历史在使用期间保留在本地工作区或应用数据中。
- 在 macOS 上，BlackHole 与 OBS 是独立信任边界。使用“仅转换音频”录制总线时，必须在 OBS 中静音
  macOS Screen Capture 的音频，否则 OBS 也会录下原始系统音轨。

处理敏感音频前，请阅读[隐私](docs/PRIVACY.md)、[安全](SECURITY.md)和
[故障排除](docs/TROUBLESHOOTING.md)。

## 开发

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run smoke:engine
```

- [开发指南](docs/DEVELOPMENT.md)
- [架构](docs/ARCHITECTURE.md)
- [平台矩阵](docs/PLATFORM_MATRIX.md)
- [原生协议](docs/NATIVE_PROTOCOL.md)
- [引擎契约](docs/ENGINE_CONTRACT.md)
- [模型适配器](docs/MODEL_ADAPTERS.md)
- [发布工程](docs/RELEASE.md)

## 贡献与许可证

欢迎在当前实验性范围内贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和
[行为准则](CODE_OF_CONDUCT.md)。

启动器原创代码采用 [MIT License](LICENSE)。Seed-VC 继续采用 GPL-3.0；模型文件、声音
参考与依赖保留各自许可证和条款。参见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 免责声明

Codex Persona Voice 是独立软件，与 OpenAI 无隶属或背书关系。ChatGPT、Codex 与 OpenAI
标志属于 OpenAI。本项目不会绕过身份验证、订阅、权限或访问控制。
