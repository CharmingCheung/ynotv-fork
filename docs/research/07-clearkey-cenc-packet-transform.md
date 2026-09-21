# ClearKey CENC packet transform between FFmpeg MOV and mpv

Research/experiment snapshot: 2026-09-20 (Asia/Singapore)

ynoTV revision at the start of this phase: `914c69c73e4df5acb59de86652a2064d01a1a66e`

## Scope and result

This phase proves the narrow packet path below:

```text
CENC init + fragmented media
        |
FFmpeg MOV AVPacket + AVEncryptionInfo
        |
experiment-only ClearKey KID lookup and AES-CTR transform
        |
clear compressed packet (same length/timestamps/config generation)
        |
existing C3 bounded packet queue and demux_rustdash
        |
unchanged mpv decoders, hwdec, A/V sync, and output
```

The result is positive for ordinary `cenc` AES-CTR. Every one of 217 local
encrypted H.264/AAC packets was independently matched to its clear-source
packet after decryption. The resulting packet fixture decoded in software,
VideoToolbox-copy, and direct VideoToolbox. An authorized external dynamic DASH
sample also passed: FFmpeg exposed the manifest KID on 400 HEVC and 500 AAC
packets, the supplied key was selected by that KID, and the clear packets
played through the same adapter in all three decode modes.

This code remains under `experiments/clearkey-cenc-packet-transform/`. It is not
called by ynoTV, does not modify decoder internals, and is not a production MPD
parser, scheduler, or network engine. No Widevine, PlayReady, CBCS, license
server, ABR, key rotation, or normal-playback integration was implemented.

## Toolchain and crypto API

Tests ran on macOS 26.6.2 arm64 with:

```text
FFmpeg 8.0 / libavformat 62.3.100 / libavcodec 62.11.100
Bento4 MP4 Encrypter 1.7 (Bento4 1.6.0.0)
OpenSSL 3.6.2
Apple clang 21.0.0
mpv cfd818bcaef262f82596f49444ee80073fa6d49a
```

The transform uses OpenSSL EVP, specifically `EVP_CIPHER_CTX_new()`,
`EVP_DecryptInit_ex(..., EVP_aes_128_ctr(), ...)`, one or more
`EVP_DecryptUpdate()` calls, and `EVP_DecryptFinal_ex()`. AES itself is not
implemented in the experiment. The build discovers OpenSSL and FFmpeg with
`pkg-config`.

## Deterministic local fixture

`generate-fixture.sh` reuses C1's synthetic `testsrc2` H.264 plus generated
1-kHz sine AAC source. It derives a deterministic test-only KID and 128-bit key
from fixed labels, writes them to gitignored mode-0600-equivalent
`local-test.env`, and never prints them. Bento4 encrypts both track IDs with
MPEG-CENC and the same KID, using different deterministic IV seeds. It also
adds an empty common-system PSSH. The script then splits both clear and
encrypted fMP4 files into init and media fragments with C1's
`split_fmp4.py`.

Reproduction:

```sh
cd experiments/clearkey-cenc-packet-transform
./generate-fixture.sh
./build.sh
./run-local-tests.sh
```

The material encryption command is equivalent to the following; values remain
environment variables so no key appears in output:

```sh
mp4encrypt --method MPEG-CENC \
  --key "1:${RUSTDASH_TEST_KEY}:<deterministic-video-IV-seed>" \
  --key "2:${RUSTDASH_TEST_KEY}:<deterministic-audio-IV-seed>" \
  --property "1:KID:${RUSTDASH_TEST_KID}" \
  --property "2:KID:${RUSTDASH_TEST_KID}" \
  clear-av-full.mp4 cenc-av-full.mp4
```

Generated media, binaries, results, packet files, and the environment file are
gitignored.

## ClearKey lookup and packet-state model

The experimental store is an array of independent entries:

```text
KeyStore = [{ kid[16], key[16] }, ...]
lookup_key(kid) -> key pointer or KeyUnavailable
```

Lookup compares the effective 16-byte KID on each packet. Nothing caches one
key per track. The local fixture has one KID, but the interface can contain
multiple KIDs without changing packet processing.

The transform returns one of:

```text
ClearPacket
EncryptedPacket
KeyUnavailable
UnsupportedScheme
MalformedEncryptionInfo
DecryptFailure
Cancelled
```

`ClearPacket` means the caller explicitly supplied no encryption record for a
known-clear packet. Both encrypted producers require
`AV_PKT_DATA_ENCRYPTION_INFO`; absent or unparsable encrypted metadata is fatal
and is never silently passed as clear. EOF remains solely the adapter's normal
drained-input state, not a key or decrypt error.

## FFmpeg encryption metadata mapping

For every encrypted packet the producers call:

```text
av_packet_get_side_data(packet, AV_PKT_DATA_ENCRYPTION_INFO, ...)
av_encryption_info_get_side_data(...)
```

The resulting public `AVEncryptionInfo` fields map directly as follows:

| FFmpeg field | Transform use |
|---|---|
| `scheme` | big-endian fourcc; must equal `cenc` |
| `key_id` / `key_id_size` | must be 16 bytes; used for per-packet lookup |
| `iv` / `iv_size` | accepted only as 8 or 16 bytes |
| `subsamples[]` | exact clear/protected spans |
| `crypt_byte_block` / `skip_byte_block` | recorded and required to be zero for this phase |

PSSH/init data remains stream-level
`AVCodecParameters.coded_side_data` with type
`AV_PKT_DATA_ENCRYPTION_INIT_INFO`. The transform records its presence but does
not interpret it as a license protocol. Codec parameters and extradata are
copied from the encrypted init into the existing `RDPKT001` track
configuration; only packet payload bytes are transformed.

## AES-CTR and subsample handling

For a 16-byte IV, the complete value initializes EVP CTR. For an 8-byte IV,
the transform copies it into the high eight bytes of a 16-byte counter block
and zero-fills the low eight bytes, matching CENC's 64-bit IV form. FFmpeg MOV
zero-filled the observed fixture and real-sample IVs to 16 bytes, while the
unit test directly exercises both accepted input sizes.

The output buffer begins as an exact packet copy. Clear spans are left in
place. Only protected spans are passed through successive calls on the same
EVP context, so AES-CTR keystream position advances across protected bytes and
does not advance across clear bytes. This preserves CTR continuity across
multiple encrypted spans.

Before decryption, checked addition must show that all clear plus protected
subsample sizes equal the packet size exactly. With zero subsamples, the whole
packet is protected. KID size, IV size, pointers, packet size, scheme, and
pattern fields are also validated. The returned payload length is always the
input length, and PTS, DTS, duration, keyframe flag, and codec/config generation
are copied unchanged.

Unit coverage includes the NIST AES-128-CTR vector, an 8-byte-IV packet with
two protected spans separated by clear bytes, clear-packet copying, unknown
KID, malformed size totals, unsupported `cbcs`, and cancellation. The
sanitizer build (`-fsanitize=address,undefined`) passed.

## Independent local packet proof

`cenc_packet_producer` opens the clear and Bento4-encrypted fragmented sources
as separate FFmpeg MOV inputs. It verifies matching codec configuration and,
packet by packet, compares:

```text
track/type
PTS
DTS
duration
keyframe
payload size
payload SHA-256
payload bytes
```

Result:

```text
comparison=PASS packets=217 video=75 audio=142
scheme=cenc iv_size=16..16 subsample_packets=75 max_subsamples=1
pssh=present key_lookup=success
```

All 75 H.264 packets used one clear/protected subsample pair; all 142 AAC
packets used whole-sample encryption. Exact packetization matched, so no weaker
elementary-stream fallback was needed. This equivalence check runs before mpv
and proves that the bytes sent to the adapter are the clear compressed bytes,
not merely bytes that happened to decode.

## Local mpv result

The verified clear packets were serialized in the unchanged C2/C3
`RDPKT001` format and consumed by the unchanged C3 bounded producer and
`demux_rustdash`.

Software playback selected ordinary H.264 and AAC decoders, reported two
tracks, reached `experimental producer final EOF`, drained, and ended with
`finished playback, success`. A decoded-output run produced FFV1 plus PCM;
`ffprobe -count_frames` found all 75 video frames and a 3.072-second output.

VideoToolbox-copy succeeded with `320x180 nv12`. Direct VideoToolbox with
`gpu-next`/Vulkan succeeded with `320x180 videotoolbox[nv12]`. The direct and
copy smoke tests decoded 20 frames; the full software run drained all A/V.

Reproduction:

```sh
./run-playback-tests.sh /path/to/C3-patched/mpv /path/to/extra/dylibs
```

## Authorized real ClearKey sample

The supplied MPD URL, KID, and key were passed only through:

```text
RUSTDASH_TEST_MPD
RUSTDASH_TEST_KID
RUSTDASH_TEST_KEY
```

They are not present in tracked files. The report and logs never contain the
content key. `fetch_real_sample.py` followed the redirect chain and received a
dynamic MPD. Its deliberately narrow SegmentTemplate/SegmentTimeline path
selected two available media segments plus init for one ordinary video and one
audio representation; it is not a general MPD parser or scheduler.

Observed manifest/init/packet metadata:

| Field | Video | Audio |
|---|---|---|
| AdaptationSet | `1` | `3` (`zh`) |
| Representation | `v1500000` | `a128000` |
| codec | `hev1.1.6.L123.b0` / FFmpeg `hevc` | `mp4a.40.2` / FFmpeg `aac` |
| timescale | 180000 | 32000 |
| protection | `cenc` | `cenc` |
| manifest default KID | `acd9...fd96` | `acd9...fd96` |
| packet KID | `acd9...fd96` | same effective lookup |
| PSSH | two manifest `cenc:pssh` elements; FFmpeg init side data present | same |
| packet IV | 16 bytes | 16 bytes |
| packets | 400 | 500 |
| subsamples | one per packet on all 400 packets | zero; whole-sample encryption |

The two manifest PSSH entries were for the advertised non-ClearKey protection
systems. They were only observed and counted; no Widevine or PlayReady code was
added. The effective packet KID matched the supplied test KID because the
per-packet lookup succeeded; no KID was inferred from track identity.

`cenc_component_producer` interleaved the two component streams and rebased
this short extracted clip to each component's first DTS. It reported:

```text
real_transform=PASS video_codec=hevc audio_codec=aac
video_packets=400 audio_packets=500 key_lookup=success
video_iv=16..16 video_subsample_packets=400 video_max_subsamples=1
audio_iv=16..16 audio_subsample_packets=0 audio_max_subsamples=0
```

The full software run selected HEVC and AAC, played both tracks, reached normal
producer EOF, and ended successfully. A decoded-output check produced all 400
video frames and 16.384 seconds of FFV1/PCM output. VideoToolbox-copy succeeded
at `1024x576 nv12`; direct VideoToolbox succeeded at
`1024x576 videotoolbox[nv12]`. Each hardware smoke test decoded 50 frames.

Reproduction uses runtime-only values:

```sh
RUSTDASH_TEST_MPD=... \
RUSTDASH_TEST_KID=... \
RUSTDASH_TEST_KEY=... \
./run-real-sample.sh /path/to/C3-patched/mpv /path/to/extra/dylibs
```

## Negative cases

### Missing key

The unit test supplies an encrypted packet whose KID is absent from the store.
The integrated local producer also uses a deliberately different KID and exits
with its dedicated status after logging only:

```text
transform=KeyUnavailable
```

It does not emit EOF or send the encrypted payload to mpv.

### Wrong key

The local harness preserves the correct KID but supplies a deliberately wrong
128-bit key. Decryption mechanically completes, as expected for unauthenticated
CTR, but the first payload SHA-256/byte comparison fails. Exit status 4 is the
expected negative result, and no wrong-key packet fixture is played.

### Malformed subsample metadata

The unit test describes only 15 bytes of a 16-byte packet. The transform
returns `MalformedEncryptionInfo` before allocating/decrypting output for the
encrypted path.

### Unsupported scheme

The unit test changes the fourcc to `cbcs`. The transform returns
`UnsupportedScheme`. Nonzero crypt/skip pattern fields are rejected by the
same unsupported-mode result. There is no fallback to clear content.

## Regression results

The existing C2 suite was rerun:

```sh
cd experiments/mpv-packet-demux-adapter
./run-tests.sh /path/to/patched/mpv /path/to/extra/dylibs
```

Result:

```text
PASS: producer, software decode, decoded output, seek, hwdec, A/V sync, EOF, and bounded queue
```

The C3 live/cancellation and codec-generation suite was rerun:

```sh
./run-live-generation-tests.sh \
  /path/to/patched/mpv /path/to/extra/dylibs /path/to/mpv/source
python3 verify_live_generation.py
```

Result:

```text
PASS: bounded live waits/cancellation, packet filtering/failure, and software/VideoToolbox generation transition
```

This covers blocked seek, stop, quit, queued stop, producer failure,
`mpv_terminate_destroy()`, disabled-audio filtering, stable-track codec
generation, software decode, VideoToolbox-copy, and direct VideoToolbox. Thus
the ClearKey experiment did not alter queue ownership, capacity, cancellation,
or generation behavior.

The pinned mpv suite was rerun with:

```sh
PKG_CONFIG_PATH=/path/to/libplacebo/pkgconfig \
DYLD_LIBRARY_PATH=/path/to/libplacebo/lib \
meson test -C build-probe --print-errorlogs
```

Result: **39 passed, 0 failed, 0 skipped**.

`git diff --check` passed in both the ynoTV workspace and patched mpv checkout.

## Files changed

No existing ynoTV playback, mpv patch, decoder, Cargo, or lock file changed.
The new experiment contains:

| File | Purpose |
|---|---|
| `.gitignore` | excludes secrets, generated media, packet files, binaries, and logs |
| `cenc_transform.h/.c` | typed packet states, multi-KID store, OpenSSL AES-CTR transform |
| `test_cenc_transform.c` | vectors, IV/subsample, state, and error tests |
| `cenc_packet_producer.c` | local clear-vs-decrypted oracle and `RDPKT001` writer |
| `cenc_component_producer.c` | real separate-component decrypt/interleave writer |
| `generate-fixture.sh` | deterministic synthetic H.264/AAC CENC fixture |
| `fetch_real_sample.py` | redirect-following narrow real-sample extractor |
| `build.sh` | strict FFmpeg/OpenSSL builds |
| `run-local-tests.sh` / `verify_results.py` | local positive and negative checks |
| `run-playback-tests.sh` | local software/hardware mpv checks |
| `run-real-sample.sh` | environment-only real probe and mpv checks |
| `README.md` | entry points and isolation notes |

This report is `docs/research/07-clearkey-cenc-packet-transform.md`.

## Exact tests run

```sh
cd experiments/clearkey-cenc-packet-transform
./run-local-tests.sh
./run-playback-tests.sh \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

RUSTDASH_TEST_MPD=... RUSTDASH_TEST_KID=... RUSTDASH_TEST_KEY=... \
./run-real-sample.sh \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/mpv/build-probe/mpv \
  /private/tmp/ynotv-mpv-adapter.d2hA1O/deps/libplacebo/7.360.1/lib

cc -std=c11 -Wall -Wextra -Wpedantic -Werror \
  -fsanitize=address,undefined $(pkg-config --cflags libavutil openssl) \
  cenc_transform.c test_cenc_transform.c \
  -o /tmp/ynotv-cenc-transform-asan \
  $(pkg-config --libs libavutil openssl)
/tmp/ynotv-cenc-transform-asan

cd ../mpv-packet-demux-adapter
./run-tests.sh /path/to/patched/mpv /path/to/extra/dylibs
./run-live-generation-tests.sh \
  /path/to/patched/mpv /path/to/extra/dylibs /path/to/mpv/source
python3 verify_live_generation.py

cd /path/to/mpv/source
PKG_CONFIG_PATH=/path/to/libplacebo/pkgconfig \
DYLD_LIBRARY_PATH=/path/to/libplacebo/lib \
meson test -C build-probe --print-errorlogs

cd /Users/charming/IdeaProjects/ynotv
git diff --check
```

## Failures and unknowns

1. The first local verifier expectation incorrectly assumed AAC would also use
   subsamples. The observation was 75 subsampled video packets and 142
   whole-sample encrypted AAC packets; the assertion was corrected without
   changing the transform.
2. A playback command was initially rejected by the execution safety wrapper
   because it included `rm -f` for a generated output. A new output filename
   was used instead; this was not a media failure.
3. The real extractor implements only the supplied MPD's inheritance-free
   SegmentTemplate/SegmentTimeline shape, follows redirects, selects fixed
   representations, and fetches a two-segment slice. It deliberately does not
   refresh the MPD, schedule production playback, implement ABR, or cover other
   addressing modes.
4. The real component clip rebases each stream from its first DTS. It proves
   demux/decrypt/adapter/decode, not final DASH Period/PTO placement or a
   production A/V scheduling policy.
5. Only `cenc` AES-CTR was accepted. The fixture exposed 16-byte normalized
   IVs; the 8-byte form is covered by a direct unit vector rather than an
   FFmpeg/Bento packet observation.
6. No key rotation, multiple effective packet KIDs in one run, constant-IV
   track encryption, `saiz`/`saio`-only source, `cens`, `cbc1`, or `cbcs` was
   tested. The store shape is rotation-compatible, but rotation behavior is
   not claimed.
7. AES-CTR is unauthenticated, so the transform cannot intrinsically detect a
   wrong key. The deterministic clear-packet oracle detects it in this phase;
   a future DRM/session layer must treat key status separately.
8. Direct hardware results are limited to VideoToolbox on this Apple M4 host.
   Windows D3D11VA, Linux VA-API, and other hardware paths remain untested.
9. `DecryptFailure` is a distinct state for EVP/allocation failure but was not
   fault-injected. `Cancelled` was unit-tested at the packet boundary; the
   unchanged C3 suite remains the evidence for blocking queue cancellation.
10. Clear compressed bytes and keys exist in ordinary process memory. This is
    an experimental ClearKey path and makes no secure-decode/output claim.

```text
Can the native DASH packet pipeline perform ClearKey CENC AES-CTR decryption
between FFmpeg MOV demux and the existing mpv packet adapter?

YES

Evidence:
FFmpeg MOV supplied cenc KID/IV/subsample metadata for every encrypted packet.
The OpenSSL EVP transform selected keys by packet KID, preserved clear spans
and CTR continuity, and produced 217/217 local H.264/AAC packets that matched
the clear source in timing, flags, size, SHA-256, and bytes. Those packets
decoded through the unchanged bounded demux_rustdash queue in software,
VideoToolbox-copy, and direct VideoToolbox with normal EOF. A runtime-only
authorized DASH probe followed redirects, fetched HEVC/AAC init plus media,
matched the manifest and packet KID to the supplied key, decrypted 900 packets,
and succeeded through the same software and hardware paths. Missing keys,
wrong keys, malformed subsamples, and unsupported schemes produced explicit
negative results, while all C2, C3, codec-generation, cancellation, and pinned
mpv regressions remained green.
```
