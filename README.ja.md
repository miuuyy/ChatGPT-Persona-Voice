<h1 align="center">ChatGPT Persona Voice</h1>

<p align="center">
  <strong>ChatGPT デスクトップアプリが話している最中に、その声を変える。</strong><br>
  ローカルファーストの Seed-VC による、ほぼリアルタイムの再生。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/ChatGPT-Persona-Voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/app-desktop-black?logo=electron" alt="デスクトップアプリ">
  <img src="https://img.shields.io/badge/inference-local-10a37f" alt="Local inference">
  <img src="https://img.shields.io/badge/engine-Seed--VC-7c5cff" alt="Seed-VC engine">
</p>

<p align="center">
  <img src="assets/architecture-visual-v2.png" alt="ChatGPT の音声がローカル Seed-VC レイヤーを経由してスピーカーへ流れる構成" width="1200">
</p>

Codex Persona Voice は、ChatGPT と Codex の音声モードの声をほぼリアルタイムで
変える独立したデスクトップアプリです。会話は元のアプリに残り、音声変換は手元の端末で
実行されます。品質とタイミングは、ハードウェア、入力音声、選択した参照音声によって
変わります。

> [!IMPORTANT]
> 現在の音声変換は、日本語と中国語の入力音声で最も良い結果が得られます。英語やその他の
> 言語も動作しますが、発音や声質の一貫性には差が出ることがあります。多言語品質、参照音声
> の準備、エンジンプロファイルを改善するコントリビューションを特に歓迎します。

## Persona Voice を使う理由

- **ほぼリアルタイムの変換。** 現在の Seed-VC プロファイルは音声を短いブロックで
  処理し、変換済み音声を準備でき次第ストリーミングします。実際の遅延はハードウェアと
  音声経路によって異なります。
- **元の声へ重ねず、置き換える。** Persona Voice は選択アプリの元の再生音を
  抑制し、変換済みの声をスピーカーへ送ります。
- **ローカル推論。** インストール後の変換は手元の端末で実行されます。音声 API キーは不要です。
- **プリセットとローカル参照音声。** クレジット付き VOICEVOX キャラクターと、少数の
  コミュニティ／デモ参照音声を収録しています。使用権限のある非公開の参照音声も追加できます。
- **パーソナライゼーション。** 収録済みの声を選ぶほか、権利を持つ非公開の参照音声を追加し、
  それぞれに専用のキャラクターシーンを組み合わせられます。
- **ローカル履歴を管理可能。** 履歴は既定で無効です。有効にした場合も保存対象は変換済み
  音声だけで、既定では 6 時間後に自動削除され、すぐに全消去できます。

## 仕組み

```text
ChatGPT / Codex アプリ
        │ 音声出力
        ▼
Persona Voice の音声経路
        ▼
ローカル Seed-VC 変換
        │
        ▼
スピーカー
```

Persona Voice は、選択したアプリ、ローカルエンジン、出力経路の準備が整ってから
元の再生を置き換えます。安全に経路を確立できない場合、変換は始まりません。

詳しくは[アーキテクチャ](docs/ARCHITECTURE.md)、[ネイティブプロトコル](docs/NATIVE_PROTOCOL.md)、
[エンジン契約](docs/ENGINE_CONTRACT.md)を参照してください。

## デモ

https://github.com/user-attachments/assets/f43f9f90-a76f-4984-b061-145aa7db5467

## クイックスタート

### ダウンロードして使う

[Releases](https://github.com/miuuyy/ChatGPT-Persona-Voice/releases/latest) から最新の macOS、
Windows、Linux 版をダウンロードできます。Windows の設定画面から公式
[VB-CABLE](https://vb-audio.com/Cable/) を開き、別途インストールして Windows を再起動した後、
アプリ内の音量ミキサー手順に従ってください。

1. Persona Voice を起動し、案内に従ってエンジンとシステム音声を設定します。
2. ChatGPT または Codex を開き、Persona Voice で対象アプリと変換先の声を選びます。
3. **音声を開始** を押し、ChatGPT または Codex で音声モードを開始します。

必要条件は[プラットフォーム状況](#プラットフォーム状況)、セットアップで止まる場合は
[トラブルシューティング](docs/TROUBLESHOOTING.md) を参照してください。

### ソースから実行

必要なもの：

- Git、Bun 1.3.14、Node.js 22.12+、[`uv`](https://docs.astral.sh/uv/)
- 対象となるホストプロファイルのいずれか：MPS を搭載した Apple Silicon macOS 14.2+、
  対応 NVIDIA CUDA ドライバーを備えた x64 Linux、または Windows build 20348+ x64
  と対応 NVIDIA CUDA ドライバー
- 各 OS のネイティブツールチェーン：macOS の Xcode Command Line Tools、Linux の
  C++20 コンパイラーと `pkg-config`／PipeWire 開発ヘッダー、または Windows の
  MSVC／CMake／Windows SDK
- エンジン容量：macOS はインストール約 2.5 GiB・空き 6 GiB、Windows は約 9 GiB・
  空き 15 GiB、Linux は約 11 GiB・空き 15 GiB
- Windows では、VB-Audio 公式の VB-CABLE ドライバも別途インストールする必要があります。

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
bun run setup:engine
bun run dev
```

Linux のソース実行には PipeWire と WirePlumber も必要です。プラットフォーム設定、
ネイティブビルド、コントリビューター向けの確認手順は[開発ガイド](docs/DEVELOPMENT.md) を
参照してください。

## プラットフォーム状況

| プラットフォーム | 入手方法 | 必要条件と現在の制限 |
| --- | --- | --- |
| Apple Silicon macOS 14.2+ | プレビューパッケージあり | MPS。本番署名／公証とクリーンマシン検証は未完了 |
| Linux x64 + NVIDIA | プレビューパッケージあり | CUDA 13.0、PipeWire、WirePlumber。より広いディストリビューション対応は未検証 |
| Windows x64 + NVIDIA、build 20348+ | プレビューパッケージあり | CUDA 13.0 と別途インストールした VB-CABLE。実機フィードバックを歓迎 |
| その他のホスト | 入手不可 | 非対応 |

詳細は
[プラットフォームマトリクス](docs/PLATFORM_MATRIX.md)と
[リリースゲート](docs/RELEASE.md)を参照してください。

## 参照音声

同梱カタログには現在、四国めたん、ずんだもん、春日部つむぎ、冥鳴ひまり、九州そら、
WhiteCUL、櫻歌ミコ、小夜/SAYO、春歌ナナ、猫使アル、満別花丸、
琴詠ニア、コミュニティ版 JARVIS 参照音声、および非公式の Donald Trump デモ音声が
含まれています。

VOICEVOX サンプルは公式ショーケース音声から作成され、必要なクレジットを保持します。
コミュニティおよび著名人の参照音声にはそれぞれの条件が適用され、実在の発言や公式な
推薦として示してはいけません。使用権限のある声だけを利用してください。詳しくは
[voice manifest](voices/manifest.json) と単一の
[third-party notice inventory](THIRD_PARTY_NOTICES.md)を参照してください。

## 安全性とプライバシー

- 取得した生 PCM は意図的に保存・記録されません。
- 履歴が受け取るのは、出力セッションへ渡された変換済みフレームだけです。
- 音声置換は、ローカルエンジンと音声経路の準備が整ってから始まります。
- 設定、ログ、モデル、参照音声、任意の履歴は、使用中ローカルのワークスペースまたは
  アプリデータ内に留まります。
- macOS では BlackHole と OBS は別の信頼境界です。変換済み音声のみの録音バスを使う場合、OBS の
  macOS Screen Capture 音声をミュートしてください。そうしないと元のシステム音声も
  同時に録音されます。

機密性の高い音声で試す前に、[プライバシー](docs/PRIVACY.md)、[セキュリティ](SECURITY.md)、
[トラブルシューティング](docs/TROUBLESHOOTING.md)を確認してください。

## 開発

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run smoke:engine
```

- [開発ガイド](docs/DEVELOPMENT.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [プラットフォームマトリクス](docs/PLATFORM_MATRIX.md)
- [ネイティブプロトコル](docs/NATIVE_PROTOCOL.md)
- [エンジン契約](docs/ENGINE_CONTRACT.md)
- [モデルアダプター](docs/MODEL_ADAPTERS.md)
- [リリースエンジニアリング](docs/RELEASE.md)

## コントリビューションとライセンス

現在の実験的スコープに沿ったコントリビューションを歓迎します。
[CONTRIBUTING.md](CONTRIBUTING.md) と [行動規範](CODE_OF_CONDUCT.md)をお読みください。

ランチャーのオリジナルコードは [MIT License](LICENSE) で提供されます。Seed-VC は
GPL-3.0 のままであり、モデル、参照音声、依存関係には各自のライセンスと条件が適用
されます。[Third-party notices](THIRD_PARTY_NOTICES.md)も参照してください。

## 免責事項

Codex Persona Voice は独立したソフトウェアであり、OpenAI との提携や承認関係は
ありません。ChatGPT、Codex、OpenAI の商標は OpenAI に帰属します。本プロジェクトは、
認証、サブスクリプション、権限、アクセス制御を回避するものではありません。
