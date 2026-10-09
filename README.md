# YuE2 Studio

A local song creation app for Windows. Write lyrics, describe the sound, and generate music on your own GPU using YuE2 through audio.cpp. Use SheetSage2 to transcribe recordings into printable sheet music. No subscription required.

## Open the app

Double-click **Start YuE2 Studio.cmd** to start the server and open the app in your browser. If the server is already running, the launcher opens the existing app. Both setup scripts also open the app automatically after a successful installation. Keep the server window running while using the app. Alternatively, run `npm start` in this folder and open http://127.0.0.1:3210.

The generation runtime and Q4 model have been installed in this project. On a new computer, install Node.js 22 or newer, then double-click **Setup YuE2.cmd**. Setup downloads audio.cpp v0.9.0 (CUDA 13.3), the YuE2 Q4 model, the F16 VAE, and required tokenizer/config files. Large model downloads are checked against Hugging Face's SHA-256 hashes; release archives are verified when the publisher supplies a digest. Re-running setup skips already verified files. Allow roughly 6 GB of disk space including runtime archives.

## Create a song

1. Enter a title and a style prompt. Include language, genre, instruments, mood, and vocal character.
2. Write lyrics with `[Verse]`, `[Chorus]`, `[Bridge]`, or `[Outro]` sections. **Try an original example** supplies a short starting point.
3. Choose **Full composition** for melody and chord planning, **Melody first** for a melody plan with free accompaniment, or **Direct audio** to skip the score.
   To use sheet music with your own lyrics, choose a saved transcription or song score under **What music should your lyrics follow?**. You can also select **Paste my own ABC sheet music**. Choosing a score preserves your title, lyrics, and style. Full composition uses melody and chords; Melody first guides the tune with freer accompaniment. Review or edit the ABC in the expandable score panel. Direct audio is disabled while a score is selected. Choose **Compose new music for my lyrics** to remove the score. Match lyric phrasing to the tune; score conditioning guides generation and does not guarantee a note-for-note rendition.
4. Click **Generate song**, or press Ctrl+Enter. Jobs run one at a time so they don't compete for GPU memory.
5. Listen in the listening room or library. Download the WAV, lyrics, settings JSON, and ABC score when available.

Drafts save automatically. **Details → Edit & create a new version** loads a track's settings and score into the editor. You can change the lyrics, style, or ABC before generating again. A new version creates a new recording.

## Transcribe an audio file

Open **Sheet music**, enter a score title, choose an audio file, and click **Create sheet music**. WAV, MP3, FLAC, M4A, OGG, AAC, AIFF, and Opus are supported through the bundled local FFmpeg converter. Uploads are limited to 128 MB; only the first 10 minutes are transcribed.

The SheetSage2 model is installed in this project. To install on another computer, run **Setup SheetSage2.cmd**, which installs the locked npm dependencies and downloads the self-contained 2.7 GB model, verified with SHA-256. You must also have the audio.cpp runtime from **Setup YuE2.cmd**. All audio processing stays local.

The result is an estimated melody-and-chord score, rendered with abcjs. Download the original **ABC** or rendered **SVG**, or use **Print / Save PDF** to open your browser's print dialog. Print layout separates the score from the app controls. Review the transcription against the recording; this is not a complete arrangement for every instrument. **Use score in YuE2** loads the transcription into the song editor with full score conditioning, keeping its chord symbols. Add your desired style and lyrics before generating.

Transcription and song generation share a single queue to avoid competing for GPU memory. Saved transcriptions survive app restarts. Files live in `data/transcriptions/<id>/`, including the uploaded file, converted source WAV, ABC, event JSON, rendered SVG, and session log. SVG export is saved when you view a completed score.

## Find and download a public-domain recording

Open **Find a song**, enter a title, and click **Search**. The finder searches Wikimedia Commons audio files and includes only recordings whose metadata explicitly reports public domain or CC0. It excludes other Creative Commons licenses, disputed files, MIDI, videos, and files over 128 MB. Search examines up to 150 matching files and shows up to 20 eligible results; some songs have no eligible version in this collection.

Review **View source & terms** before reuse: these are source-reported labels, not a legal determination, and recording and composition rights can differ by country. Click **Save recording locally** to save the original audio and its source metadata in `data/recordings/<id>/`. Downloaded recordings support playback, **Download audio**, and **Create sheet music**, which sends the saved audio directly to the existing SheetSage2 queue. Internet access is required for search and download; playback and transcription stay local. The download checks the current source metadata again, accepts only Wikimedia's HTTPS media host, and rejects redirects, oversized files, and incomplete downloads.

## Local or RunPod generation

Choose **Where should YuE2 run?** in the song editor. Local generation uses the precision selected in Engine settings (Q4 by default). RunPod generation connects to the included authenticated GPU worker, which uses BF16 model weights and the F32 VAE. Both paths take your lyrics, style, seed and optional sheet music; cloud WAVs download into the same local song library. Each song records its execution target and model precision.

RunPod uses higher precision for the same YuE2 model, rather than a separate larger model architecture. It may improve quality relative to Q4, but there is no guarantee that it fixes incorrect lyrics. Compare the same lyrics, style, score and seed, and review lyric phrasing against the selected melody.

See [cloud/README.md](cloud/README.md) for the worker and deployment instructions. In **Engine settings**, save the worker's HTTPS proxy URL and worker token, then click **Check worker**. The worker token is separate from your RunPod account API key. The app never starts or bills a pod automatically. RunPod charges for a running pod, including idle time and setup downloads; stop or terminate it when finished. Lyrics, style and ABC are sent to your pod when you select RunPod. SheetSage2 stays local. Cloud connection secrets are kept out of browser state and song exports.

## Hardware and length

The installed configuration uses **Q4 on NVIDIA CUDA**, selected for this computer's RTX 5070 with 12 GB VRAM. Memory and generation time depend on lyric length, score length, and token limit. Start with short or medium tracks. The token limit caps generation; it does not set an exact song duration, and reaching it can cut off the ending. Full song mode can require more memory. Close other GPU-heavy applications or lower the limit if generation fails with an out-of-memory error.

Advanced controls expose seed, variation, render steps, length limit, and an optional ABC score. A seed helps repeat a request within the same engine and configuration; identical outputs across different hardware or runtime versions are not guaranteed. The app generates vocal songs; an instrumental-only workflow is not included.

Engine settings can point to another audio.cpp executable or model folder. Q8 and BF16 options require their corresponding files to be downloaded separately. GPU backends require a matching runtime build. The installed binary is CUDA-enabled.

## Hum or sing a melody

The **Song length** slider accepts 10–360 seconds. Uncheck **Automatic** to choose a duration. Choose **Target length** to prevent an end marker until about two seconds before that length, or **Maximum only** to allow an earlier ending. Check **Automatic** to allow a natural ending within the visible **Maximum length for Automatic**. Choose up to 1, 2, 3, or 6 minutes. Automatic is still capped and may stop before finishing all lyrics; the selected maximum is shown beside the slider. The studio maps seconds to YuE2's 25 audio tokens per second and applies the minimum/maximum on local and RunPod generation. For short hummed scores, choose **Develop as a motif** to add repetition, variation and arrangement guidance while retaining the supplied ABC as conditioning. This does not generate new written score bars; the model may repeat musical material, and reaching the cap may cut off the ending. Previously exported songs retain their original length mode. Existing deployed cloud workers need the updated worker bundle.

To generate without lyrics, leave **Lyrics · optional** empty. The studio sends YuE2 an `[instrumental]` marker and adds instrumental/no-vocals guidance to the style, on both local and RunPod workers. Your saved lyrics remain empty, and optional ABC sheet music is retained. This guides the base model; it does not guarantee complete suppression of vocal-like sounds. Existing deployed cloud workers need the updated `worker.py` bundle.

Open **Sheet music**, choose **Hum or sing into my microphone**, and click **Record melody**. Allow microphone access when your browser asks. Hum, sing, or whistle a single melody with a steady rhythm using your default microphone. Click **Stop recording** (takes stop after two minutes), then listen back. You can download the take, discard it, or record again. Click **Create sheet music**, review the estimated notes, then **Use score in YuE2** to compose with your lyrics and style. Existing lyrics are preserved when loading the score.

Capture starts only on a Record click. The microphone is released when recording stops or you leave the page. Unsubmitted takes stay in the current tab; download or transcribe them before closing it. Transcription saves the source audio and score locally. If this browser does not support microphone recording or blocks access, open `http://127.0.0.1:3210/` in Chrome or Edge, or upload an audio recording. Supported recording formats are chosen with the browser's [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).

Microphone lifecycle tests cover stop/release, denied permission, cancelled permission requests, maximum duration, and matching WebM/M4A filenames. A real local SheetSage2 test transcribed a 12-second synthetic melody encoded as WebM/Opus and returned a rendered melody-and-chord score; physical microphone capture still needs a user-recorded take.

## Write lyrics with OpenRouter

Open **Engine settings** to add your [OpenRouter API key](https://openrouter.ai/keys) and choose a writing model from the live catalog. Then open **Write lyrics** in the sidebar, or **Write with AI** beside the composer lyrics. The writing page also links back to **Writing partner settings**. A **Key saved** badge confirms that your API key is stored locally. Use the **Choose your writing model** dropdown, grouped into **Anthropic · Claude** and **OpenAI · ChatGPT**; you do not need to type a model ID. Pricing is shown per million input/output tokens when supplied by the catalog.

Describe your song in the conversation and ask for revisions. Each message includes the previous conversation and your current editable lyric draft. You can change models between turns. Click **Use this lyric draft** under a suggestion to put the complete proposed lyrics in your editor, then make your own changes. Suggestions do not automatically replace your draft.

**Save draft** saves the lyrics and conversation on this computer. Unsaved editor changes and the message you are typing are also kept in this browser. Saved drafts can be reopened from the workspace sidebar. **Use in song** saves the draft and loads its title and lyrics into the song composer, preserving your existing sound, score, duration, and engine settings. Generate the song from there. **Bring in composer lyrics** starts a new writing draft from the composer.

OpenRouter requests require internet access and are billed to your OpenRouter account. Sending a message transmits the conversation and current lyrics to OpenRouter and the selected provider. The API key is stored locally in `data/openrouter-connection.json` and is never included in responses or browser storage. **Disconnect** clears the saved key. No paid model call is made until you send a message. Failed replies preserve your draft and leave your message available for retry.

## Files and troubleshooting

- `data/studio.json`: draft, song library, and engine settings.
- `data/lyrics-workspace.json`: saved lyric drafts and conversations.
- `data/openrouter-connection.json`: local OpenRouter API key; keep this file private.
- `data/songs/<id>/`: WAV, request, lyrics, score, and generation log for each session.
- `models/YuE2/installation.json`: installed model revision and runtime version.
- `runtime/`: portable executable and DLLs, installed only inside this project.

The app listens only on `127.0.0.1`, checks the request origin, and uses a session token for mutations. Local song generation can run offline after setup. Setup and public recording search use internet access. Optional RunPod generation sends your song request to your worker; optional OpenRouter lyric chat sends the conversation and editable draft to your selected writing model.

If a track fails, use **Details → Generation log**. Cancel stops the running generator or removes a waiting job from the queue. Sessions interrupted by a restart stay in the library and can be loaded for another attempt. Run `npm test` to verify request validation, queue behavior, cancellation, failures, downloads, audio seeking, and persistence using an isolated CLI fixture. Real GPU generation is checked separately.

## Upstream

- [YuE2 project and model terms](https://github.com/multimodal-art-projection/YuE)
- [audio.cpp runtime](https://github.com/0xShug0/audio.cpp)
- [GGUF model package](https://huggingface.co/audio-cpp/Yue2-3B-GGUF)
- [SheetSage2 GGUF model](https://huggingface.co/audio-cpp/SheetSage2-GGUF)
- [abcjs notation renderer](https://abcjs.net/) and [Windows FFmpeg package](https://www.npmjs.com/package/@ffmpeg-installer/win32-x64) (licenses included in `node_modules`)

This interface is an independent local app. Upstream runtime and model licenses apply to those components; review the linked model terms for your intended use.

### Automatic WAV mastering

Click **Master this song** on a finished song in the listening room, song library, or session details. Choose **Balanced** for gentle cleanup and even loudness, **Warm** for softer highs and a little low-mid warmth, or **Punchy** for gentle compression and a louder presentation. Click **Create master** and wait for **Master ready**, then compare the original and mastered audio or download the mastered WAV.

Mastering runs locally with the bundled FFmpeg processor, without a GPU or RunPod. It uses measured two-pass loudness normalization: Balanced and Warm target -14 LUFS; Punchy targets -12 LUFS, with a -1.5 dB true-peak limit. Masters are saved separately under `data/masters/` as 48 kHz stereo, 24-bit WAVs. The original recording and its duration are preserved. This polishes the existing audio; it does not regenerate the song, repair incorrect lyrics, or recover detail lost during generation. A 24-bit export does not itself add detail to the source.

### Music videos

Use **Engine settings → Music video engines** to save two separate fal.ai keys: a regular key for generation and model pricing, and an optional admin-scope key only for credit balance and billing-event reads. The admin key is never used to generate media; billing never falls back to the generation key. With an admin key saved, Engine settings and Video library show your credit balance and its last checked time. The balance refreshes when the app opens, after saving an admin key, and after syncing video costs; **Refresh balance** checks it again. **Sync actual costs** saves request-matched charges on video cards, including partial totals while recent billing events are still arriving. Both keys remain in the ignored local `data/` folder and are never returned to the browser.

Open **Music videos** in the sidebar, or click **Create music video** on a finished song. Choose the original recording or one of its mastered versions. The default provider is **fal.ai**. Add your fal.ai API key under **Engine settings → Music video engines**; the key stays on this computer and is never returned to the browser.

Choose MiniMax H3 Max Turbo, MiniMax H3, Kling 2.5 Turbo Pro, Seedance 2.5, or LTX 2.5 Fast. Each model exposes its supported scene durations, resolutions, and frame shapes. Describe the overall look and optionally enter one storyboard scene per paragraph. Choose a one-scene preview or a full-song video. Full-song videos repeat the storyboard in order until the soundtrack is covered. **Review video plan** shows the number of paid scene generations, total generated seconds, and the current fal.ai base billing rate when available. Pricing varies by model and output settings; a base unit rate is not a guaranteed total. Click **Generate music video · paid** to submit requests.

Scenes are generated sequentially, downloaded, normalized, joined, and exported locally to H.264 MP4 with the selected recording as an AAC soundtrack. Model-generated audio is discarded. The original WAV stays unchanged. Downloads, provider request IDs, scene progress, and finished MP4s are retained under `data/videos/`. After interruption, **Resume saved scenes** reuses completed scenes and known requests rather than resubmitting them. If a submission acknowledgement is lost, check provider request history before creating another job; the app prevents blind automatic resubmission. Cancellation stops new scenes; an in-progress provider generation may still complete or be billed. No character continuity, beat matching, or singing lip sync is guaranteed by these text-to-video routes.

#### RunPod video service: MiniMax H3 Base

The RunPod picker uses **MiniMax H3 Base FL2VA**, whose weights are published under the MiniMax H3 community license. This is distinct from hosted H3 Max variants and from the YuE2 audio worker. No pod is provisioned by the app. Configure a compatible GPU pod following the official [MiniMax deployment guide](https://huggingface.co/MiniMaxAI/MiniMax-H3#local-deployment-of-h3-base) and [SGLang diffusion documentation](https://docs.sglang.io/). Hardware requirements are substantial; the official example uses four GPUs. Verify current SGLang installation instructions and hardware recommendations before renting a pod.

The service must expose the SGLang OpenAI-compatible `/v1/models`, `POST /v1/videos`, `GET /v1/videos/{id}`, and `GET /v1/videos/{id}/content` routes with API-key authentication. The app uses the official `task: t2va`, `conditions: []`, and `target` request format, at a 768-pixel short edge.

An example launch command from the official model guide, with an API key added:

```sh
sglang serve --model-path MiniMaxAI/MiniMax-H3 --num-gpus 4 --ulysses-degree 4 --performance-mode speed --host 0.0.0.0 --port 30010 --model-variant fl2va --api-key "$VIDEO_SERVICE_TOKEN"
```

Use the current release's `sglang serve --help` to confirm authentication and serving flags. Expose HTTP port 30010 on the pod, then save `https://<pod-id>-30010.proxy.runpod.net` and the service token under **Engine settings → Music video engines → RunPod**. **Check service** checks the model list without starting a video generation. Keep the token private. RunPod charges while the pod runs; stop or terminate it when finished. This integration is contract-tested with fixture responses; it has not been GPU-tested against a live H3 pod in this workspace.

### Composition approaches

**Full composition** plans melody and chords before audio rendering. **Melody first** plans the tune and gives the audio stage more freedom over accompaniment. **Direct audio** skips the intermediate score plan and cannot use supplied sheet music. These choices affect the composition approach; they are not model precision or guaranteed quality levels.

### Labeled images for music videos
In Music videos, upload PNG, JPEG, or WebP photos (up to 5 MB each), give each a unique label such as Rusty or Beauty, and select the references to use. Mention those names in the visual direction or storyboard. The library saves locally; selected images are sent to fal.ai only when you generate with an image-capable model. Images are decoded and resized to JPEG at a maximum of 1536 pixels, which also removes embedded metadata.

- MiniMax H3 · multiple image references accepts one to nine selected photos. Every scene receives the same selected references with explicit Image 1 = Rusty, Image 2 = Beauty bindings. Scene descriptions determine who appears and what they do.
- MiniMax H3 Max Turbo · image to video takes one selected image as the opening frame of every scene. Its canvas follows the input image; the export fits the chosen frame shape.
- Existing text-only models, including the current RunPod integration, keep reference selection disabled. Switch to an image-capable fal.ai endpoint to use photos.

Labels can be renamed, and images can be archived from the picker. Archived image files remain available for saved jobs to resume; queued jobs retain the original label mapping. Reference conditioning guides likeness but does not guarantee exact identity or consistency.
