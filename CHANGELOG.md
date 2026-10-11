# Changelog

## Unreleased

### Added
- Advice shows live local engine file readiness, installation progress and failures, with first-time setup/repair instructions and repository links.
- Advice page explains local GPU music, fal.ai video models, libraries and projects, with RunPod documentation and billing guidance.
- RunPod appears last in navigation under Advanced / Experimental, with an explicit notice that end-to-end generation is not yet verified. Local engines precede RunPod in settings.
- Sports arena sound preset for instrumental entrance music with brass fanfares, powerful percussion, stadium claps and a dramatic build.
- Clear for new song resets content, sheet-music/lyric source links, project and composition options, saves the empty draft, and keeps the selected engine.
- RunPod worker selection and cost review explain shared account capacity, the impact on other projects, and choosing one worker for a single song.
- Network volumes show estimated monthly/daily/yearly storage costs, attached account resources, and persisted Studio setup/generation activity to help decide what to keep. Unknown history is explicitly marked.
- Automatic GPU scan checks model requirements, volume region, live capacity, and a quoted hourly selection limit before deployment.
- RunPod inventory defaults to Studio-linked resources, with local labels, notes, and an option to link existing account resources.
- YuE2 serverless song generation is the default cloud setup, with zero idle and up to ten workers; dedicated Pods remain optional.
- Song workers reuse the shared model/runtime cache and return full WAV recordings through bounded, SHA-256 verified transfers.
- Failed Pod recovery actions restore the previous setup for a new cost review, with full instructions.
- Stopped Pods can be permanently terminated after confirmation; network volumes remain saved.
- Guided RunPod account setup, GPU and storage selection, paid plan review, readiness checks, and Pod controls.
- Shared YuE2/MiniMax network volume setup with a “YuE2 + MiniMax H3” preparation option.
- MiniMax H3 model preparation without starting a video service.
- On-demand H3 serverless video configuration: zero idle workers, maximum ten by default; dedicated Pods remain optional.
- Concurrent serverless scene requests and persisted request IDs.
- Separate Lyrics AI (OpenRouter), fal.ai, RunPod, and local engine settings.
- Lyrics and sheet music libraries, with creation actions and related-asset navigation.

### Fixed
- Preparing a new or edited song clears unrelated playback from the listening panel; generation selects the new result, and previous songs remain available in Recent sessions.
- Blank-lyrics guidance now explains that instrumental prompting does not guarantee vocal-free output, and Direct audio bypasses score control.
- Queuing a song scrolls to and focuses its progress panel, respecting reduced-motion preferences, so generation status is immediately visible.
- RunPod setup shows persistent pending, confirmed, or unconfirmed results beside the apply button, with next steps; launch errors no longer appear off-screen. A failed inventory refresh does not imply a confirmed launch failed.
- Shared-volume checkout allows ten minutes on slow storage and skips optional Git LFS hydration; interrupted source caches are archived before a clean checkout.
- Shared-volume setup serializes installers and recovers stale Git checkout locks left by interrupted Pods, preserving lock backups and refusing fresh locks.
- Pod action dialogs display failures inline and show pending status, prevent duplicate submissions, and pause background readiness polling.
- RunPod worker setup failures appear in red with an in-app explanation and recovery instructions; raw worker diagnostics remain private.
- RunPod video settings offer a named engine dropdown and guided setup; manual endpoint IDs are under Advanced.
- Corrected corrupted punctuation in RunPod validation messages and generated resource names.
- RunPod cost-review errors appear beside the review button and clear when setup choices change.
- Video settings retain unsaved model connection edits during progress updates.
- Serverless video resume checks the original endpoint before submitting further scenes.

### Validation
- YuE2 serverless protocol, chunked WAV transfer, resource associations, and automatic GPU selection have automated tests. The first live serverless song test remained queued/throttled and was cancelled; completed GPU inference is not yet verified.
- RunPod management and H3 deployment configuration are covered by local fixtures.
- Live H3 GPU setup and serverless inference have not yet been validated.

## Existing application baseline

- Local YuE2 generation, optional lyrics, sheet-music guidance, duration controls, and automatic WAV mastering.
- OpenRouter lyric conversations and saved drafts.
- SheetSage2 audio and microphone transcription.
- fal.ai video generation, labeled image references, balance and cost tracking.
- Projects, song/video libraries, recoverable Trash, and linked-asset deletion safeguards.
- Light and dark themes.
