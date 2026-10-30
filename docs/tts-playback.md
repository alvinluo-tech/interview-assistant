# Interviewer speech

The interviewer first produces and saves its complete question. Speech reads that question independently of the chat model. A failed synthesis never removes the question or prevents a text answer.

## Configuration

In **Settings → AI services**, add a MiMo or regional Alibaba Cloud connection, assign a model to **Speech synthesis**, select a voice, save, and preview. Existing connections can add the exact model ID manually if their model catalog omits speech models. Switching voice families selects the corresponding default voice; custom voice IDs remain editable.

| Service | Model examples | Transport | Default voice |
| --- | --- | --- | --- |
| Xiaomi MiMo | `mimo-v2.5-tts` | Chat Completions SSE, assistant text, `audio.voice` | `苏打` |
| Alibaba Qwen TTS | `qwen3-tts-flash` | Multimodal generation HTTP/SSE | `Cherry` |
| Alibaba Qwen Audio TTS | `qwen-audio-3.1-tts-flash` | Native SpeechSynthesizer HTTP/SSE | `longanhuan_v3.6` |
| Alibaba CosyVoice | `cosyvoice-v3-flash` | Native SpeechSynthesizer HTTP/SSE, Beijing only | `longanyang` |
| Compatible service | Provider-specific model ID | `/audio/speech`, complete encoded audio | Provider-specific |
| No selected route | System voice | Windows SAPI / macOS `say` | OS default |

Model and voice availability depends on region and account access. MiMo voice-clone/design models require additional inputs and are rejected by this preset-voice entry point. Qwen `-realtime` models require another protocol and are rejected with a suggestion to use their HTTP counterparts. Other CosyVoice versions may require an already-created custom voice ID.

Alibaba requests retain the configured Beijing/Singapore **and workspace hostname**, replacing only `/compatible-mode/v1` with `/api/v1`. No cross-region credential forwarding occurs. Nonofficial gateways retain their configured URL prefixes and OpenAI-compatible protocol for Qwen models. MiMo models use the MiMo message schema, including through compatible gateways that support that schema.

## Playback behavior

- The header speaker controls automatic question speech; the preference persists.
- The question button stops the current reading or replays the question. Preparation is visible and cancellable.
- MiMo and native Alibaba streams produce mono PCM16 at 24 kHz. Web Audio schedules buffers against its audio clock with a 120 ms initial scheduling margin; this is not a guarantee of service latency.
- Long text is split at sentence boundaries, up to 500 Unicode code points per native request. Segments retain all text and play in order. Compatible encoded-audio services receive the full text in one request.
- Starting voice input, submitting an answer, disabling speech, changing questions, finishing, or leaving the room cancels the request and stops all queued audio. Late responses cannot restart it.
- Complete successful audio can be replayed from an in-memory LRU cache, at most eight questions / 12 MB, with an 8 MB maximum entry. No audio is persisted. Settings changes invalidate the cache; finishing or leaving clears it. Failed, incomplete, and cancelled audio is not cached.
- A configured cloud service error is displayed; it does not silently switch the user's selected voice. Removing the TTS route uses the system voice.

SSE parsing handles UTF-8/network boundaries, multiline events, timeout and cancellation. Audio is bounded to 32 MB per question; stream records are bounded to 4 MB. If an Alibaba endpoint returns only a completed audio URL, only official result buckets in the supported regions are accepted, via HTTPS, without authentication headers or cookies. Completed URLs are not fetched when streamed audio has already arrived.

## Validation

- `pnpm test:tts`: protocol, playback, cache, cancellation and error regressions with 80% minimum aggregate line/branch/function coverage.
- `pnpm test:byok`: provider config, model discovery and text-test guards.
- `pnpm test:platform`: includes the speech regressions.
- `node scripts/experience-ui-smoke.mjs`: isolated synthetic settings/room flow covering MiMo and Singapore Alibaba voice selection, stopping preparation, streaming before completion, cached replay and answer interruption. It uses synthetic networking and audio, never real credentials or personal app state.
- `pnpm build`: TypeScript and frontend production build.

Live provider requests, subjective voice quality, Windows audio-device behavior and macOS runtime playback still require real-device verification. Tests do not spend API credits.

## Official references

- [MiMo synthesis](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)
- [Qwen TTS HTTP/SSE](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
- [Qwen Audio TTS HTTP](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)
- [CosyVoice HTTP](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api)
