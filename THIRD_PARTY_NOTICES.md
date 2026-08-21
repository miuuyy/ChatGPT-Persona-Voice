# Third-party notices

This is the repository's single human-readable inventory for third-party code, executables, model
artifacts, voice references, and character material. The original Codex Persona Voice launcher is
licensed separately under [LICENSE](LICENSE). Machine-verifiable revisions, hashes, and required
voice credits remain in `engine/seed-vc/model-lock.json` and `voices/manifest.json`.

Inclusion here records provenance and redistribution information; it does not grant trademark,
publicity, personality, character, or other rights beyond the identified upstream terms. Users and
redistributors remain responsible for the law and terms that apply to their use.

## Persona-derived Core Audio discovery

The initial macOS Core Audio process-object discovery and private aggregate-device setup in
`native/macos/VoiceCapture.mm` was derived from the open-source Persona project and substantially
adapted for muted PCM transport.

Upstream: <https://github.com/xikhar/persona>

```text
MIT License

Copyright (c) 2026 xikhar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## React renderer runtime

The packaged renderer includes React 19.2.8, React DOM 19.2.8, and Scheduler 0.27.0. All three use
the same Meta Platforms MIT license text. The byte-for-byte upstream text is shipped as
`third_party_licenses/REACT-19-LICENSE`.

Upstreams:

- <https://github.com/facebook/react/tree/v19.2.8/packages/react>
- <https://github.com/facebook/react/tree/v19.2.8/packages/react-dom>
- <https://github.com/facebook/react/tree/v19.2.8/packages/scheduler>

## Seed-VC inference sidecar and model artifacts

The separate Python inference process under `engine/seed-vc` uses the Seed-VC source pinned at
commit `51383efd921027683c89e5348211d93ff12ac2a8`. That component is GPL-3.0. Its complete
corresponding source and GPL-3.0 license are included in the `engine/vendor/seed-vc` submodule.

Upstream: <https://github.com/Plachtaa/seed-vc>

The model files are downloaded by the engine installer and are not committed to this repository.
They come from the following immutable upstream revisions:

| Repository | Revision | License metadata | Exact source |
| --- | --- | --- | --- |
| `Plachta/Seed-VC` | `257283f9f41585055e8f858fba4fd044e5caed6e` | GPL-3.0 | <https://huggingface.co/Plachta/Seed-VC/tree/257283f9f41585055e8f858fba4fd044e5caed6e> |
| `facebook/wav2vec2-xls-r-300m` | `1a640f32ac3e39899438a2931f9924c02f080a54` | Apache-2.0 | <https://huggingface.co/facebook/wav2vec2-xls-r-300m/tree/1a640f32ac3e39899438a2931f9924c02f080a54> |
| `funasr/campplus` | `e4b6ede7ce16997aff4ae69fbca1f0175e2afede` | Apache-2.0 | <https://huggingface.co/funasr/campplus/tree/e4b6ede7ce16997aff4ae69fbca1f0175e2afede> |
| `FunAudioLLM/CosyVoice-300M` | `24c40509c3c5ea6fe06b5f8790ff99e3714a6bee` | Apache-2.0 | <https://huggingface.co/FunAudioLLM/CosyVoice-300M/tree/24c40509c3c5ea6fe06b5f8790ff99e3714a6bee> |

Their immutable revisions and exact SHA-256 hashes are recorded in
`engine/seed-vc/model-lock.json`. Each artifact retains its upstream license and terms.

## Voice references

The checked-in files under `voices/references` are short target-voice references, not trained voice
models. `voices/manifest.json` is the authoritative catalog for each file's identity, locale,
required credit, terms URL, and SHA-256 digest. The catalog verifies those digests before listing or
using a reference.

### VOICEVOX showcase references

Twelve references are deterministic concatenations of the three normal-style showcase samples
served by the official VOICEVOX 0.25.2 website. `scripts/build-voicevox-references.cjs` records the
exact source URLs and reproduces the transformation: `001`, `002`, and `003` are concatenated in
that order and resampled to mono PCM16 at 22.05 kHz. The application does not include the VOICEVOX
synthesis engine or official VOICEVOX character artwork.

VOICEVOX requires the applicable voice-library terms and credit when its audio is used. The bundled
catalog records the following credits and character-specific terms:

| Voice | Required credit | Terms |
| --- | --- | --- |
| Shikoku Metan | `VOICEVOX:四国めたん` | <https://zunko.jp/con_ongen_kiyaku.html> |
| Zundamon | `VOICEVOX:ずんだもん` | <https://zunko.jp/con_ongen_kiyaku.html> |
| Kasukabe Tsumugi | `VOICEVOX:春日部つむぎ` | <https://tsumugi-official.studio.site/rule> |
| Meimei Himari | `VOICEVOX:冥鳴ひまり` | <https://meimeihimari.wixsite.com/himari/terms-of-use> |
| Kyushu Sora | `VOICEVOX:九州そら` | <https://zunko.jp/con_ongen_kiyaku.html> |
| WhiteCUL | `VOICEVOX:WhiteCUL` | <https://www.whitecul.com/guideline> |
| Ouka Miko | `VOICEVOX:櫻歌ミコ` | <https://voicevox35miko.studio.site/rule> |
| Sayo | `VOICEVOX:小夜/SAYO` | <https://316soramegu.wixsite.com/sayo-official/guideline> |
| Haruka Nana | `VOICEVOX:春歌ナナ` | <https://nanahira.jp/haruka_nana/guideline.html> |
| Nekotsuka Aru | `VOICEVOX:猫使アル` | <https://nekotukarb.wixsite.com/nekonohako/利用規約> |
| Manbetsu Hanamaru | `VOICEVOX:満別花丸` | <https://100hanamaru.wixsite.com/manbetsu-hanamaru/rule> |
| Kotoyomi Nia | `VOICEVOX:琴詠ニア` | <https://commons.nicovideo.jp/works/nc315435> |

General sources:

- VOICEVOX website and character catalog: <https://voicevox.hiroshiba.jp/>
- Voice-model and library terms: <https://github.com/VOICEVOX/voicevox_vvm/blob/main/TERMS.txt>
- VOICEVOX 0.25.2 release: <https://github.com/VOICEVOX/voicevox/releases/tag/0.25.2>

### Character session scenes

The session-card PNGs below are project-specific derivative illustrations generated with OpenAI
ImageGen on 2026-08-20. They use one shared 2:1 matte-charcoal composition and contain newly
generated pixels; they are not official character artwork. Official VOICEVOX profile portraits were
inspected as temporary identity references and are not included in this repository.

| Character | Project scene and SHA-256 | Stable official profile | Visual terms |
| --- | --- | --- | --- |
| Shikoku Metan | `shikoku-metan-session-scene.png` · `2f10e708eec1b0233fba0684867cb6e0c09aa60d1eb4cf0541109fefe7b3cb2f` | <https://voicevox.hiroshiba.jp/dormitory/shikoku_metan/> | <https://zunko.jp/guideline.html> |
| Zundamon | `zundamon-session-scene.png` · `29f6749c05bc7268899f0593885797c846b47446edf791f8b2294c435dc1dc54` | <https://voicevox.hiroshiba.jp/dormitory/zundamon/> | <https://zunko.jp/guideline.html> |
| Kasukabe Tsumugi | `kasukabe-tsumugi-session-scene.png` · `60305673f4200922bdafab47706e7ef4e65a100717d471173b6e59833ffe02e4` | <https://voicevox.hiroshiba.jp/dormitory/kasukabe_tsumugi/> | <https://tsumugi-official.studio.site/rule> |
| Meimei Himari | `meimei-himari-session-scene.png` · `7613542fd6b8af16064557d052816e0eebbc3e55abbd2c228f8645a2c8188ad4` | <https://voicevox.hiroshiba.jp/dormitory/meimei_himari/> | <https://www.meimeihimari.com/terms-of-use> |
| Kyushu Sora | `kyushu-sora-session-scene.png` · `cea63d050dd57a0d90df3be9b5f147f73c9d3bc30f4543ae6852a12a99362c43` | <https://voicevox.hiroshiba.jp/dormitory/kyushu_sora/> | <https://zunko.jp/guideline.html> |
| WhiteCUL | `whitecul-session-scene.png` · `ecb23812f2bfb440a82d3e0ecc339f6e53cea9660c8df10ba4f70dc9fcd35afa` | <https://voicevox.hiroshiba.jp/dormitory/white_cul/> | <https://zan-shin.net/guideline/> |
| Ouka Miko | `ouka-miko-session-scene.png` · `2b468723dbf1b1dac0492521fd08a1afe991f97eed42b1aa400c1b6f108a0581` | <https://voicevox.hiroshiba.jp/dormitory/ouka_miko/> | <https://voicevox35miko.studio.site/rule> |
| Sayo | `sayo-session-scene.png` · `fb2f1235bfedf0a0b6e8f0a732557ecc857afac061b3b46beb6df49fc72f2a82` | <https://voicevox.hiroshiba.jp/dormitory/sayo/> | <https://316soramegu.wixsite.com/sayo-official/guideline> |
| Haruka Nana | `haruka-nana-session-scene.png` · `d67e68477b207d7db320fcbd121428f5041da0ff3fb7a46812e20d366ec258f0` | <https://voicevox.hiroshiba.jp/dormitory/haruka_nana/> | <https://nanahira.jp/haruka_nana/guideline.html> |
| Nekotsuka Aru | `nekotsuka-aru-session-scene.png` · `79fee1aa287c6b0c9515db7da87df626abf7aa901b6a38fc89229a086aed5c8f` | <https://voicevox.hiroshiba.jp/dormitory/nekotsuka_aru/> | <https://nekotukarb.wixsite.com/nekonohako/利用規約> |
| Manbetsu Hanamaru | `manbetsu-hanamaru-session-scene.png` · `df931d48eb8cd673b5f78c54abb497c7fb55a013efb8ab7dbeba6f7a1f0022bb` | <https://voicevox.hiroshiba.jp/dormitory/manbetsu_hanamaru/> | <https://100hanamaru.wixsite.com/manbetsu-hanamaru/rule> |
| Kotoyomi Nia | `kotoyomi-nia-session-scene.png` · `b5abc219bb028e4a7362b3fb80cc9e60057cfd1558841639b11ff6def785d7d1` | <https://voicevox.hiroshiba.jp/dormitory/kotoyomi_nia/> | <https://commons.nicovideo.jp/works/nc315435> |

Each character and scene remains subject to its linked terms and required credit. The scenes must
not be presented as official art or endorsement.

### JARVIS community reference

`jarvis-community-high` is a 22.05 kHz mono WAV conversion of the high-quality sample published
with the `jgkawell/jarvis` Piper voice model.

- Model card: <https://huggingface.co/jgkawell/jarvis>
- Sample: <https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high/samples/speaker_0.mp3>
- Model-card license metadata: MIT
- Required credit: `jgkawell/jarvis (MIT)`
- Reference SHA-256: `ce8aeeb8ac1bdeb30844eb31353310af58cb3f7e00f44543ceaa386cd91ee011`

The upstream card describes the model as an emulation of the JARVIS voice from the Marvel movies.
This project labels it **JARVIS (community)** and does not claim affiliation with or endorsement by
Marvel, Disney, the production, or any actor. Copyright and model-license metadata do not by
themselves grant trademark, performer, personality, or publicity rights.

### Donald Trump public-figure reference

`seed-vc-donald-trump-example` is the exact `examples/reference/trump_0.wav` file distributed by
the pinned Seed-VC source and declared by its demo as a Donald Trump target.

- Upstream: <https://github.com/Plachtaa/seed-vc>
- Pinned commit: `51383efd921027683c89e5348211d93ff12ac2a8`
- Reference source: <https://github.com/Plachtaa/seed-vc/blob/51383efd921027683c89e5348211d93ff12ac2a8/examples/reference/trump_0.wav>
- Upstream repository license: GPL-3.0
- Required credit: `Plachtaa/seed-vc upstream Trump example (GPL-3.0)`
- Reference SHA-256: `716becc9daf00351dfe324398edea9e8378f9453408b27612d92b6721f80ddbc`

This is an AI voice-likeness target for a real public figure. It is not an official voice,
endorsement, or affiliation. Generated audio must be clearly disclosed as AI-converted and must not
be used to deceive listeners, fabricate authentic statements, or imply authorization.

## Electron and Chromium runtime

Packaged desktop applications include Electron and Chromium. On macOS the exact Electron license
is shipped as `Contents/Resources/LICENSE.electron.txt` and the complete generated Chromium notice
set as `Contents/Resources/LICENSES.chromium.html`; packaging verifies both against the pinned
Electron distribution. Other target builders retain their platform-standard Electron license
payloads. Upstream: <https://github.com/electron/electron/tree/v41.10.3>.

## Bun 1.3.14 updater-worker runtime

Packaged desktop artifacts include the pinned Bun 1.3.14 executable solely to run the detached,
checksummed update worker after Electron exits. The following inventory is derived from the upstream
version-specific notice at <https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md>.

Bun itself is MIT-licensed. The packaged updater runtime also carries the byte-for-byte upstream
version-specific notice as `BUN-1.3.14-LICENSE.md`; the source copy is
`third_party_licenses/BUN-1.3.14-LICENSE.md`.

### JavaScriptCore

Bun statically links JavaScriptCore (and WebKit), which is LGPL-2 licensed. WebCore files from
WebKit are also licensed under LGPL2. The patched WebKit source and relinking instructions are at
<https://github.com/oven-sh/webkit>.

### Linked libraries

| Library | License |
| --- | --- |
| [boringssl](https://boringssl.googlesource.com/boringssl/) | [several licenses](https://boringssl.googlesource.com/boringssl/+/refs/heads/master/LICENSE) |
| [brotli](https://github.com/google/brotli) | MIT |
| [libarchive](https://github.com/libarchive/libarchive) | [several licenses](https://github.com/libarchive/libarchive/blob/master/COPYING) |
| [lol-html](https://github.com/cloudflare/lol-html/tree/master/c-api) | BSD 3-Clause |
| [mimalloc](https://github.com/microsoft/mimalloc) | MIT |
| [picohttp](https://github.com/h2o/picohttpparser) | Perl License or MIT |
| [zstd](https://github.com/facebook/zstd) | BSD or GPLv2 |
| [simdutf](https://github.com/simdutf/simdutf) | Apache-2.0 |
| [tinycc](https://github.com/tinycc/tinycc) | LGPL-2.1 |
| [uSockets](https://github.com/uNetworking/uSockets) | Apache-2.0 |
| [zlib-cloudflare](https://github.com/cloudflare/zlib) | zlib |
| [c-ares](https://github.com/c-ares/c-ares) | MIT |
| [libicu 72](https://github.com/unicode-org/icu) | [ICU license](https://github.com/unicode-org/icu/blob/main/icu4c/LICENSE) |
| [libbase64](https://github.com/aklomp/base64) | BSD 2-Clause |
| [libuv](https://github.com/libuv/libuv) (Windows) | MIT |
| [libdeflate](https://github.com/ebiggers/libdeflate) | MIT |
| [uucode](https://github.com/jacobsandlund/uucode) | MIT |
| [uWebSockets fork](https://github.com/jarred-sumner/uwebsockets) | Apache-2.0 |
| [TigerBeetle IO code](https://github.com/tigerbeetle/tigerbeetle/blob/532c8b70b9142c17e07737ab6d3da68d7500cbca/src/io/windows.zig#L1) | Apache-2.0 |

### Embedded polyfills

The Bun binary embeds polyfills for `assert`, `browserify-zlib`, `buffer`, `constants-browserify`,
`crypto-browserify`, `domain-browser`, `events`, `https-browserify`, `os-browserify`,
`path-browserify`, `process`, `punycode`, `querystring-es3`, `stream-browserify`, `stream-http`,
`string_decoder`, `timers-browserify`, `tty-browserify`, `url`, `util`, and `vm-browserify`. The
upstream Bun notice identifies each as MIT-licensed.

Bun's JavaScript transpiler, CSS lexer, and Node.js module resolver are Zig ports of esbuild. The
upstream notice also credits `@kipply` for the Bun name.

## uv 0.11.14 engine-installer runtime

Target packages include uv 0.11.14 solely to install the Seed-VC runtime into private application
data. uv is dual-licensed under Apache-2.0 or MIT; this distribution uses the MIT option. Upstream:
<https://github.com/astral-sh/uv/tree/0.11.14>

The packaged engine installer also carries the byte-for-byte upstream MIT text as
`UV-0.11.14-LICENSE-MIT`; the source copy is
`third_party_licenses/UV-0.11.14-LICENSE-MIT`.

```text
MIT License

Copyright (c) 2025 Astral Software Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
