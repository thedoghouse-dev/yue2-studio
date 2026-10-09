# YuE2 Studio RunPod worker

The app can connect to this authenticated asynchronous worker over RunPod's HTTPS proxy. The worker builds the audio.cpp v0.9.0 CUDA CLI from pinned commit 795c45fbde0a7d29c93b22199728ff5caaec02e5, pinned YuE2 BF16 weights (7.26 GB), and the F32 VAE (0.53 GB). The source is the same 3B model as local Q4; higher precision is not a separate larger architecture and does not guarantee lyric accuracy.

## Prepare a deployment

Run `node cloud/make-launch-plan.mjs` from the project folder. This writes `data/runpod-pod-plan.json`, a **private** launch configuration containing a random worker access token and the encoded source bundle. It does not provision or charge for anything. The configuration follows RunPod's REST v2 CreatePodRequest schema. Use the RunPod MCP or runpodctl for actual provisioning. Check the current GPU price and capacity before launching, and monitor an initial test with a one-hour deadline. This launch configuration does not schedule automatic termination. The recommended RTX 4090 has 24 GB VRAM; use CUDA 12.8 or later, 32 GB host RAM, and 30 GB disk. No SSH, Jupyter, public file browser, or unauthenticated job route is needed.

For manual setup, deploy the official PyTorch CUDA 12.8 image, expose **8000/http**, copy `worker.py` and `setup_worker.py` together to the pod, set a random `YUE2_WORKER_TOKEN` with at least 32 characters, then run `python3 -u worker.py`. The worker starts its authenticated health endpoint immediately and builds the CUDA CLI and downloads/verifies the model in the background. The official Colab CUDA archive contains the server only, so the CLI is compiled from source with pinned submodules, CMake 3.31.6 and Ninja 1.11.1.4. Setup can take several minutes. Keep the token private. GitHub and Hugging Face receive download requests; they never receive your worker access token.

## Connect the desktop app

1. In **Engine settings → RunPod**, enter `https://<pod-id>-8000.proxy.runpod.net` and your `YUE2_WORKER_TOKEN`. This is a worker token, **not** a RunPod account API key.
2. Save the connection and click **Check worker**. Wait for **BF16 worker ready**.
3. In **Create a song**, select **RunPod GPU · BF16 model · paid**. Use your lyrics, style and optional saved ABC sheet music as usual. Click **Generate song**.
4. The app submits an asynchronous job, polls progress and downloads the finished WAV into the existing local library. A client UUID makes submission idempotent. Cancellation sends a remote cancellation request and kills the native generation process. Jobs time out after 30 minutes. Cancelling a job does **not** stop the billable pod.
5. Stop or terminate the pod in RunPod when finished. Stopped pods may still incur storage charges; termination removes the ephemeral disk. Downloaded songs stay in the desktop library. Use **Disconnect worker** in the app to clear its saved URL and token; disconnecting does not stop pod billing.

RunPod's proxy is publicly reachable; every worker route requires a bearer token and the app accepts only HTTPS RunPod proxy URLs on port 8000. The app stores the worker token in ignored `data/runpod-connection.json`, without encryption at rest, and never includes it in browser state or song exports. Protect access to this project folder. Inputs (lyrics, style, ABC) travel to your worker; SheetSage2 and public-domain searching remain on the local app. If the desktop app is forcibly killed or loses connectivity, cancellation cannot be guaranteed; check the pod and terminate it to end billing. Worker state is ephemeral; a pod restart loses remote job state. The app never creates, starts, stops or bills a pod automatically.

## Verification

`npm test` runs the actual Python worker HTTP layer with a fixture native CLI. Tests cover authentication, forwarding lyrics and sheet music, BF16/F32 flags, idempotency, audio download, failure, cancellation and browser secret isolation. It needs Python 3.12; set `TEST_PYTHON` if using another Python location. This validates the client/worker protocol, not GPU performance. Live RunPod GPU validation requires provisioning a paid worker.

Live verification on October 6, 2026 used a Secure RTX 4090 (24 GB) and the pinned CUDA source build. The desktop app forwarded the original example lyrics and ABC score, generated a 109.88-second stereo 48 kHz WAV in about 20 seconds, and saved the 21.1 MB recording locally. The generation log reported no semantic token truncation. The temporary pod was terminated and its connection cleared afterward. This establishes cloud generation and download; it does not establish improved sung-lyric accuracy.
