# YuE2 Studio RunPod worker

The app can connect to this authenticated asynchronous worker over RunPod's HTTPS proxy. The worker builds the audio.cpp v0.9.0 CUDA CLI from pinned commit 795c45fbde0a7d29c93b22199728ff5caaec02e5, pinned YuE2 BF16 weights (7.26 GB), and the F32 VAE (0.53 GB). The source is the same 3B model as local Q4; higher precision is not a separate larger architecture and does not guarantee lyric accuracy.

## Guided setup in the app

Open **RunPod cloud**. Save and verify your account API key, refresh your resources, choose a GPU and storage, then review the paid launch. Existing network volumes are mounted at `/workspace` and require a GPU in the same data center. A new volume is a separate billable resource. Pod-local 50 GB storage is kept on stop/start and lost on termination. The container also has 30 GB of ephemeral disk.

The manager uses REST API v2 (`https://api.runpod.io/v2`), the official CUDA 12.8 image pinned by digest, the local worker bundle, and a generated worker token. It starts the authenticated HTTP health service, compiles audio.cpp, and downloads and verifies pinned YuE2 weights. The desktop page checks a user-approved launch every ten seconds and connects it after readiness. Keep the app open while waiting; **Check readiness** and **Use for songs** also work manually. The account key is stored in ignored `data/runpod-account.json`; worker tokens and private deployment metadata are kept in ignored `data/runpod-management.json`. These files are not encrypted at rest. Responses and exported song settings omit credentials.

**Stop GPU** ends compute but does not delete network or Pod storage. **Start GPU** reviews the current GPU list rate first. There is no automatic shutdown: stop the Pod when finished. The app cannot perform management while closed or after its account key is removed. Failed launches can leave a volume billed separately. If creation acknowledgement is lost, refresh to reconcile the unique deployment marker; do not create another plan until you have checked resources. The manager never deletes your network volumes or unrelated model files.

The automated launch installs YuE2 only. Serverless resources are inventory-only and MiniMax H3 remains a separately prepared SGLang service.

## Prepare a deployment manually

Run `node cloud/make-launch-plan.mjs` from the project folder. This writes `data/runpod-pod-plan.json`, a **private** launch configuration containing a random worker access token and the encoded source bundle. It does not provision or charge for anything. The configuration follows RunPod's REST v2 CreatePodRequest schema. Use the RunPod MCP or runpodctl for actual provisioning. Check the current GPU price and capacity before launching, and monitor an initial test with a one-hour deadline. This launch configuration does not schedule automatic termination. The recommended RTX 4090 has 24 GB VRAM; use CUDA 12.8 or later, 32 GB host RAM, and 30 GB disk. No SSH, Jupyter, public file browser, or unauthenticated job route is needed.

For manual setup, deploy the official PyTorch CUDA 12.8 image, expose **8000/http**, copy `worker.py` and `setup_worker.py` together to the pod, set a random `YUE2_WORKER_TOKEN` with at least 32 characters, then run `python3 -u worker.py`. The worker starts its authenticated health endpoint immediately and builds the CUDA CLI and downloads/verifies the model in the background. The official Colab CUDA archive contains the server only, so the CLI is compiled from source with pinned submodules, CMake 3.31.6 and Ninja 1.11.1.4. Setup can take several minutes. Keep the token private. GitHub and Hugging Face receive download requests; they never receive your worker access token.

## Connect the desktop app

1. In **Engine settings → RunPod**, enter `https://<pod-id>-8000.proxy.runpod.net` and your `YUE2_WORKER_TOKEN`. This is a worker token, **not** a RunPod account API key.
2. Save the connection and click **Check worker**. Wait for **BF16 worker ready**.
3. In **Create a song**, select **RunPod GPU · BF16 model · paid**. Use your lyrics, style and optional saved ABC sheet music as usual. Click **Generate song**.
4. The app submits an asynchronous job, polls progress and downloads the finished WAV into the existing local library. A client UUID makes submission idempotent. Cancellation sends a remote cancellation request and kills the native generation process. Jobs time out after 30 minutes. Cancelling a job does **not** stop the billable pod.
5. Stop or terminate the pod in RunPod when finished. Stopped pods may still incur storage charges; termination removes the ephemeral disk. Downloaded songs stay in the desktop library. Use **Disconnect worker** in the app to clear its saved URL and token; disconnecting does not stop pod billing.

RunPod's proxy is publicly reachable; every worker route requires a bearer token and the app accepts only HTTPS RunPod proxy URLs on port 8000. The app stores the worker token in ignored `data/runpod-connection.json`, without encryption at rest, and never includes it in browser state or song exports. Protect access to this project folder. Inputs (lyrics, style, ABC) travel to your worker; SheetSage2 and public-domain searching remain on the local app. If the desktop app is forcibly killed or loses connectivity, cancellation cannot be guaranteed; check the pod and terminate it to end billing. Worker state is ephemeral; a pod restart loses remote job state. The app creates or starts compute only after an explicit paid review, and stops it only through a confirmed Pod action.

## Verification

`npm test` runs the actual Python worker HTTP layer with a fixture native CLI. Tests cover authentication, forwarding lyrics and sheet music, BF16/F32 flags, idempotency, audio download, failure, cancellation and browser secret isolation. It needs Python 3.12; set `TEST_PYTHON` if using another Python location. This validates the client/worker protocol, not GPU performance. Live RunPod GPU validation requires provisioning a paid worker.

Live verification on October 6, 2026 used a Secure RTX 4090 (24 GB) and the pinned CUDA source build. The desktop app forwarded the original example lyrics and ABC score, generated a 109.88-second stereo 48 kHz WAV in about 20 seconds, and saved the 21.1 MB recording locally. The generation log reported no semantic token truncation. The temporary pod was terminated and its connection cleared afterward. This establishes cloud generation and download; it does not establish improved sung-lyric accuracy.

Management tests use fixture RunPod v2 responses for account discovery, price review, network-volume placement, deployment recovery, credential isolation, worker readiness, and active-generation safeguards. They do not establish live GPU provisioning for the new guided flow.


## Shared model storage and on-demand video generation

Use **RunPod cloud → YuE2 + MiniMax H3 · songs & videos** to install the song engine and cache MiniMax H3 on one network volume. Minimum combined volume size is 200 GB; 300 GB is recommended. The setup verifies pinned H3 FL2VA downloads (~144 GB), requires review of its model license, and does not start SGLang for videos. Existing volume files remain in place.

Alternatively, use **MiniMax H3 → download onto a volume** to add video weights to an existing setup. That path starts a temporary download Pod; stop it after readiness to end GPU billing.

Then select **MiniMax H3 → serverless videos** using the same volume. The reviewed endpoint uses minimum 0, maximum 10 workers by default, queue-delay scaling, and a 10-second idle timeout. No generation job is sent during setup. Each worker loads the prepared model from /runpod-volume/models/minimax-h3 and uses four H200 GPUs with the pinned CUDA 13 SGLang image. Cold starts and initialization are billed. Ten workers can use forty GPUs; this is a scaling cap rather than reserved capacity. Model storage remains billed at zero workers.

The app supports two concurrent serverless video jobs, with up to five scene requests per job. Scene IDs and completed downloads are persisted; ambiguous submissions are not automatically repeated. A resume requires the original endpoint. RunPod queue results expire, so completed scenes should be downloaded promptly. Dedicated four-H200 video Pods remain optional. YuE2 defaults to its separate serverless song endpoint on the shared volume; dedicated song Pods remain optional.

The account key is kept locally and sent only to fixed RunPod account/queue hosts; it is not put in worker containers. H3 outputs use bounded MP4 queue results and are assembled locally with the original soundtrack. RunPod image generation and multi-image reference generation are not included. These H3 paths have fixture-based contract tests, not live GPU validation.


### YuE2 serverless songs

RunPod cloud now defaults to **YuE2 · serverless songs**. Save your account key,
choose an existing network volume or create one (50 GB is a practical song-only
starting size), select a GPU, and review the costs. Setup creates an endpoint
with zero idle workers and a default maximum of ten; it starts no GPU or Pod.
The app selects that song engine automatically. Dedicated song Pods remain an
optional choice, and existing Pod connections continue to work.

The first song prepares any missing pinned CUDA CLI and BF16/F32 model files on
the shared volume. Initialization is billed and may take several minutes.
The same cache is reused by later workers; different GPU architectures have
separate builds. MiniMax endpoints may use this same volume, but keep separate
workers because their GPU/runtime requirements differ. MiniMax preparation
remains a separate step; do not use a song endpoint as a video endpoint.

Completed recordings are stored on the network volume and automatically fetched
in 4 MiB chunks, verified with SHA-256, and saved as WAV files in the local song
library. Transfer requests also consume brief worker time. This avoids requiring
separate S3 credentials and keeps each asynchronous result below RunPod payload
limits. Remote cached recordings remain on the volume; deleting a local song
does not remove its remote cached file. Network storage continues to be billed.
Cancelling a song requests cancellation of its active RunPod job. Ambiguous paid
submissions are never automatically repeated. The local composition queue still
processes one song at a time; ten workers is an endpoint cap, not a promise of
parallel song generation from this app or reserved GPU capacity.

### Automatic GPU selection and Studio resources

The GPU dropdown defaults to **Automatic · scan compatible GPUs**. Review scans
live catalog capacity in your volume's data center, checks model memory and GPU
requirements, and excludes known GPU types over your quoted hourly selection
limit. Serverless uses the compatible GPU pools; a Pod chooses one suitable GPU.
Deployment checks the reviewed candidates again and requires a new review if none
remain available. Capacity is not reserved and failed rentals are not retried
automatically. This selection limit is not a permanent billing cap: RunPod may
change pricing or add GPU types to a pool. Idle serverless workers default to zero.

Resources created by this Studio, and their attached volumes, appear by default.
Use **Show all account resources** to link another resource to this Studio and
save a local label and notes. Labels do not rename resources in RunPod. These
associations are kept in ignored local data, not shared through GitHub.
