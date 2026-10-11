# godot-asset-pipeline

Bakes Decentraland content into Godot-optimized assets for the Godot (mobile) explorer.

Every scene, wearable, emote and world deployment becomes a job. The worker runs the godot-explorer headless **asset server** on the deployment's GLB/glTF files and uploads the baked Godot resources to S3. The explorer then reads them from the CDN instead of importing raw glTF on the device.

## Architecture

```
 catalyst deployments ─┐
 world deployments ────┤
                       ▼
            event-driven-sns (shared topic)
                       │  filter: catalyst-deployment {scene, wearable, emote}
                       │          world {deployment}
                       │  raw message delivery
                       ▼
            ┌──────────────────┐        ┌───────────────────────┐
            │ SQS: task queue  │        │ SQS: priority queue   │◀── yarn queue --priority
            └────────┬─────────┘        └──────────┬────────────┘
       yarn queue ──▶│   redrive after maxReceiveCount ──▶ SQS DLQ
                     │                             │
                     ▼     priority polled first   ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ ECS Fargate task (this image, linux/amd64)                    │
   │                                                               │
   │  node worker (:5000)  ── HTTP ──▶  godot-explorer             │
   │   - SQS long poll                  --asset-server (:8080)     │
   │   - heartbeat / backoff            under Xvfb + Mesa llvmpipe │
   │   - task scale-in protection       (CPU only, no GPU)         │
   │   - /health/live, /metrics,                                   │
   │     loopback /content-proxy  ◀── fetches content ─┘           │
   └──────────────────────────────┬────────────────────────────────┘
                                  │ content: <content server>/contents/<hash>
                                  ▼
                     S3 bucket: <S3_PREFIX>/<file>  ──▶  CDN  ──▶  Godot explorer
```

- **One job at a time per task.** Before every claim the worker makes sure Godot is up, restarting it if the previous job used it (to free memory) or if it does not answer. It then bakes one entity, uploads the results, clears Godot's content cache and settles the message right away; the restart happens before the next claim. If Godot cannot be started it does not claim anything, and after 3 failed starts in a row the process exits so ECS replaces the task.
- **Already published scenes are skipped.** Entity ids are content hashes, so a published scene never changes. A scene whose `<S3_PREFIX>/<entityId>-mobile.zip` exists (it is uploaded last) is acknowledged without baking: SNS redeliveries, duplicate events and backfill reruns cost one `HeadObject`. A job with `"force": true` (`yarn queue --force`, and every `--entityId` one-off) bakes anyway. Wearables and emotes are keyed by their glTF hash and are always baked.
- **Scaling.** The ECS service scales on queue depth. It keeps one warm task where the bus feeds the queue, because target tracking cannot reliably scale out from zero tasks.
- **Content source.** Content is downloaded from the content server named in the event (`contentServerUrls[0]`). When the event names none, the worker uses `<CATALYST_URL>/content`.
- **Stall recovery.** Sometimes a batch stalls because an asset-server worker panicked or got stuck downloading. The worker then restarts Godot and runs the scene again. On the re-run, the stuck files and their same-named siblings are hidden behind a loopback content proxy (`/content-proxy/:entityId/contents/:hash`). Hidden files are reported as dropped assets. All re-runs of one entity share a single bake budget (`ASSET_SERVER_TIMEOUT_MS`, 90 min by default).

## Output layout

All objects go to `s3://$BUCKET/$S3_PREFIX/<file>`, a flat namespace. The asset server picks every file name, and the object key is that file's basename.

**Scenes**

| Key | Content | Content-Type |
|---|---|---|
| `<hash>.scn`, `<hash>.res` | Baked Godot scenes and resources, named by content hash | `application/octet-stream` |
| `<hash>.js`, `<hash>.crdt` | The scene's entry script and `main.crdt`, byte-for-byte originals, under their content hashes | `application/javascript` / `application/octet-stream` |
| `<entityId>-static.zip` | Additional bundle emitted by the asset server | `application/zip` |
| `<entityId>-optimized.json` | Manifest: `optimizedContent`, `externalSceneDependencies`, `originalSizes`, `hashSizeMap`, `bootFiles`, `bootBundle` | `application/json` |
| `<entityId>-boot.zip` | Manifest + `main.js` + `main.crdt`, so the client can boot the scene with one request | `application/zip` |
| `<entityId>-mobile.zip` | Legacy metadata zip (manifest only). It is uploaded **last**, so its presence means the bake is fully published | `application/zip` |

The upload order follows the asset server's order, with two exceptions: the manifest and the boot zip go after every other file, and `-mobile.zip` goes after those. A client that fetches while an upload is in progress therefore never sees a manifest whose dependencies are missing.

Some scenes have nothing to bake (no GLB/glTF, or every mesh was rejected). For those, the worker publishes a **boot bundle**: the script and crdt, the manifest, `-boot.zip` and `-mobile.zip`.

**Wearables and emotes**

| Key | Content |
|---|---|
| `<glbHash>-mobile.zip` | The baked first GLB/glTF of the entity, with its dependencies resolved through the entity's content mapping |

An entity that has no GLB/glTF counts as a success with zero assets.

**Every entity**

| Key | Content |
|---|---|
| `<entityId>-report.json` | Per-bake report, uploaded best-effort. It covers timings, asset counts, dropped files, errors, Godot logs and the `partial`, `bootOnly` and `transient` flags |

A bake that the asset server finishes with some assets dropped for content reasons (for example a GLB referencing a texture missing from the deployment) is still published. It counts as a success and is marked `partial` in the report, so a permanent content defect is not re-baked forever.

## Message format

The queues use raw message delivery, so the SQS body is the event itself. The worker also unwraps an SNS envelope (`{"Type":"Notification","Message":"<json>"}`) if it gets one. The job is validated as `DeploymentToSqs` from `@dcl/schemas`:

```json
{
  "type": "catalyst-deployment",
  "subType": "scene",
  "entity": { "entityId": "bafkrei...", "authChain": [ ... ] },
  "contentServerUrls": ["https://peer.decentraland.org/content"]
}
```

- **Entity id:** `entity.entityId`, falling back to `entity.id`. It must be a content hash (`^[a-zA-Z0-9]+$`): it ends up in file paths, S3 keys and URLs, so anything else is dropped as `invalid`.
- **Entity type:** `entity.entityType` if present. Otherwise it is the event `subType` for `catalyst-deployment` events, `scene` for `world` events, and `scene` when nothing else applies. Only `scene`, `wearable` and `emote` are accepted. A `world` event with a `subType` other than `deployment` is rejected.
- **Allowlist:** when `ALLOWED_CONTENT_SERVER_HOSTS` is set, a job whose content server host is not on the list is rejected before anything is fetched. It counts as a content failure.

Jobs sent by hand (`yarn queue`, `--entityId`) are bare `DeploymentToSqs` bodies with `entity.entityType` set, and `force: true` when a re-bake is asked for. They carry a placeholder `authChain`: one `SIGNER` link with the zero address. The schema requires it, and the optimizer never reads it.

## Retries, visibility and the DLQ

| Outcome | What happens to the message | `job_queue_outcome_total{outcome}` |
|---|---|---|
| Baked (also partial, boot-only, nothing to bake, or already published) | `DeleteMessage` | `success` |
| Content failure, positively blamed on the content (the asset server rejected the batch, stalled on the same files every pass, an entity or file the content server does not have (404), a definition that is not JSON, a disallowed host) | `DeleteMessage`; not retried | `content_failure` |
| Any other failure: transient (DNS/connect/timeout, 5xx/429, Godot crash, upload that never landed, bake budget exhausted), infrastructure (S3 `AccessDenied`/`NoSuchBucket`/403/KMS, disk full, too many open files) or unclassified (a code bug) | Kept. Visibility is set to 5 min after the 1st receive, 30 min after the 2nd and 2 h after later ones, so SQS redelivers it later and, if it keeps failing, dead-letters it | `transient` |
| Unparseable or invalid body | `DeleteMessage`; the error log includes the first 1000 chars of the body | `invalid` |

- **Polling:** one message at a time. The priority queue is polled briefly (1 s) first, then the main queue with a 20 s long poll.
- **Heartbeat:** messages are received with `VisibilityTimeout=JOB_VISIBILITY_TIMEOUT_SECONDS`. While a job runs, the worker extends the visibility every half-period, up to SQS's 12 h limit from the moment of receipt.
- **Dead-letter queue:** after `maxReceiveCount` receives, the queue's redrive policy moves the message to the DLQ. The worker never polls the DLQ. Every receive counts, including deliveries handed back on shutdown and deliveries lost when a task crashes, so `maxReceiveCount` should leave room for those: with 6, a job that fails fast is dead-lettered about 6.5 h after its first receive, which outlasts a catalyst, S3 or network outage.
- **Partial bakes on network errors:** if assets were dropped because of a network error, the worker does not publish the bake. The whole entity is retried instead.
- **Shutdown (SIGTERM):** the worker stops polling and sets the in-flight message's visibility to 0, so another task picks it up right away. A 90 min bake cannot finish inside ECS's stop timeout. A shutdown release counts as a receive.
- **Scale-in protection:** when `ECS_AGENT_URI` is set (ECS sets it), the worker sends `PUT $ECS_AGENT_URI/task-protection/v1/state` with `ProtectionEnabled: true` on every claim. The protection expires after the bake budget plus 30 min. It stays on between back-to-back jobs, so a scale-in that became pending during a long bake does not stop the task right after it has claimed the next job. The worker sends `ProtectionEnabled: false` when a poll finds every queue empty, and on shutdown. A failed protection call is logged and never stops the job.

## Configuration

Configuration is read from `.env.default`, then `.env` (git-ignored), then the process environment, which takes precedence over both files. An empty value falls back to the default.

| Variable | Default | Description |
|---|---|---|
| `HTTP_SERVER_PORT` | `5000` | Node HTTP server. It must not be 8080, which the asset server uses |
| `HTTP_SERVER_HOST` | `0.0.0.0` | Bind address |
| `WKC_METRICS_RESET_AT_NIGHT` | `false` | Reset metrics at 00:00 UTC |
| `WKC_METRICS_BEARER_TOKEN` | _(empty)_ | If set, `/metrics` requires this bearer token |
| `AWS_REGION` | `us-east-1` | Region for SQS and S3 |
| `TASK_QUEUE` | _(empty)_ | Main SQS queue URL (SNS-fed). If neither queue is set, the worker uses an in-memory queue |
| `PRIORITY_TASK_QUEUE` | _(empty)_ | Optional SQS queue URL with no SNS subscription, fed by `yarn queue --priority`. Polled first |
| `JOB_VISIBILITY_TIMEOUT_SECONDS` | `900` | Visibility on receive and on each heartbeat (clamped to 30 to 43200) |
| `BUCKET` | _(empty)_ | Output S3 bucket. Required when a queue is set. If empty (one-offs only), files are written to `./storage` |
| `S3_PREFIX` | _(empty)_ | Version prefix for every key (`<S3_PREFIX>/<file>`), e.g. `v6`. Required when a queue is set. Bump it whenever the output format changes |
| `SQS_ENDPOINT` | _(empty)_ | Local only: custom SQS endpoint (ElasticMQ, LocalStack) |
| `S3_ENDPOINT` | _(empty)_ | Local only: custom S3 endpoint. Enables path-style addressing |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | _(empty)_ | Local only: static S3 keys. Otherwise the default AWS credential chain (ECS task role) is used |
| `CATALYST_URL` | `https://peer.decentraland.org` | Used when a job carries no content server (`<CATALYST_URL>/content`) and by the one-off modes |
| `WORLDS_CONTENT_SERVER_URL` | `https://worlds-content-server.decentraland.org` | Only used to resolve `<name>.dcl.eth` in `--entityId` |
| `ALLOWED_CONTENT_SERVER_HOSTS` | _(empty: allow all)_ | Comma-separated host names allowed as a job's content server |
| `FETCH_MAX_RETRIES` | `3` | Retries per HTTP fetch |
| `FETCH_INITIAL_DELAY_MS` | `1000` | First retry delay |
| `FETCH_MAX_DELAY_MS` | `30000` | Maximum retry delay |
| `FETCH_TIMEOUT_MS` | `60000` | Per-request timeout |
| `FETCH_BACKOFF_MULTIPLIER` | `2` | Backoff factor |
| `ASSET_SERVER_URL` | `http://localhost:8080` | Asset server base URL |
| `ASSET_SERVER_PORT` | `8080` | Port Godot is started on. Keep it in sync with `ASSET_SERVER_URL` |
| `ASSET_SERVER_TIMEOUT_MS` | `5400000` (90 min) | Bake budget per entity, shared by all of its stall-retry passes |
| `ASSET_SERVER_MAX_STALL_RETRIES` | `10` | Re-runs of a stalled scene batch |
| `ASSET_SERVER_STALL_PANIC_MS` | `120000` | No progress for this long while every pending job has panicked counts as a stall |
| `ASSET_SERVER_STALL_DOWNLOAD_MS` | `600000` | No progress for this long while every pending job is still downloading counts as a stall |
| `ASSET_SERVER_STALL_DOWNLOAD_JOB_MS` | `180000` | A single job stuck downloading this long while others complete counts as stuck |
| `ASSET_SERVER_MAX_STALLED_JOBS` | `25` | More stuck jobs than this is treated as a network failure (transient) |
| `ASSET_SERVER_CONCURRENT_BUNDLES` | `4` | Parallel bakes in the dev-only `--profile <address>` mode (bakes the wearables and emotes a profile wears, starting Godot itself, then exits) |
| `GODOT_CONTENT_CACHE_PATH` | `~/.local/share/godot/app_userdata/Decentraland/content` | Godot content cache; wearable and emote content is pre-downloaded into it |
| `CONTENT_DOWNLOAD_CONCURRENCY` | `10` | Parallel pre-downloads |
| `CONTENT_DOWNLOAD_TIMEOUT_MS` | `30000` | Per-file pre-download timeout |
| `ECS_AGENT_URI` | _(set by ECS)_ | Enables task scale-in protection. Do not set it yourself |

## HTTP endpoints

| Path | Purpose |
|---|---|
| `GET /health/live` (also `/health/ready`, `/health/startup`) | Liveness, used by the ECS container health check |
| `GET /ping` | Simple ping |
| `GET /metrics` | Prometheus metrics. These include `job_queue_duration_seconds`, `job_queue_enqueue_total`, `job_queue_failures_total`, `job_queue_outcome_total{outcome}` and the default HTTP metrics |
| `GET /content-proxy/:entityId/contents/:hash` | Loopback content proxy for stall-retry passes, used by the in-container asset server |

There is no HTTP endpoint for enqueueing jobs. Jobs only come in through SQS.

## Running locally

The worker needs the godot-explorer binary (`/app/decentraland.godot.client.x86_64`) and an X display, so it runs inside the Docker image. The image is linux/amd64 only. On Apple Silicon it runs under emulation and bakes are much slower.

`docker-compose.yml` starts:
- [ElasticMQ](https://github.com/softwaremill/elasticmq) as SQS, at `localhost:9324` (stats UI at `:9325`)
- [S3Mock](https://github.com/adobe/S3Mock) as S3, at `localhost:9090`
- a one-shot `init` container that creates the bucket `asset-optimizer-local`, the queues `asset-optimizer-tasks` and `asset-optimizer-priority-tasks`, and a DLQ (redrive after 6 receives)
- the worker, with `S3_PREFIX=v6`. It listens on 5000 inside the container, published on host port 5050 (macOS AirPlay Receiver holds 5000): `curl localhost:5050/health/live`

The emulators use dummy credentials (`test`/`test`). Never put real keys in the compose file.

```sh
docker compose up --build

# enqueue jobs (the image ships the CLI)
docker compose exec worker node dist/cli/queue.js <entityId>
docker compose exec worker node dist/cli/queue.js --priority <entityId>
docker compose exec worker node dist/cli/queue.js --entity-type wearable <entityId>

# or from the host, after `yarn install && yarn build`
SQS_ENDPOINT=http://localhost:9324 AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
TASK_QUEUE=http://elasticmq:9324/000000000000/asset-optimizer-tasks \
yarn queue <entityId>

# inspect the output
aws --endpoint-url http://localhost:9090 s3 ls s3://asset-optimizer-local/v6/
```

To pin a different godot-explorer build, set `GODOT_IMAGE` in your shell before `docker compose build`. Use an immutable commit-sha tag of `quay.io/decentraland/godot-explorer`.

### One-off bakes

The entrypoint passes its arguments to `node dist/index.js`:

```sh
# entity id, scene pointer ("x,y"), or world name
docker compose run --rm worker --entityId bafkrei...
docker compose run --rm worker --entityId "-9,-9"
docker compose run --rm worker --entityId myworld.dcl.eth
```

`--entityId` looks up pointers on `<CATALYST_URL>/content` and world names on `WORLDS_CONTENT_SERVER_URL`. It sends the resolved job to `TASK_QUEUE` when that is set, or to the in-memory queue otherwise, and the worker then consumes it as usual.

## Manual (re)queue and backfill

`yarn queue` (`src/cli/queue.ts`, built to `dist/cli/queue.js`) sends `DeploymentToSqs` jobs straight to the queues. It uses the default AWS credential chain plus `AWS_REGION` and `SQS_ENDPOINT`. It does not crawl catalysts: you supply the entity ids.

```
yarn queue [--priority] [--file ids.txt] [--content-server-url <url>]
           [--entity-type scene|wearable|emote] [--force] [--dry-run] [<entityId> ...]
```

| Option | Meaning |
|---|---|
| `--priority` | Send to `PRIORITY_TASK_QUEUE` instead of `TASK_QUEUE` |
| `--file`, `-f` | Read ids from a file, one per line. Blank lines are skipped and `#` starts a comment. Can be repeated |
| `--content-server-url` | Content server of the entities. Without it, the worker uses `<CATALYST_URL>/content` |
| `--entity-type` | `scene` (default), `wearable` or `emote` |
| `--force` | Re-bake scenes that are already published. Without it the worker skips a scene whose `-mobile.zip` exists, so a backfill can be rerun safely |
| `--dry-run` | Print the message bodies without sending them |

Ids must be content hashes (`^[a-zA-Z0-9]+$`); the CLI refuses to send anything otherwise. They are de-duplicated and sent 10 at a time. The CLI prints `<entityId>\t<messageId>` per job and a summary at the end. It exits with `1` if any send failed and `2` on a usage error.

```sh
# backfill against the deployed queues (queue URLs come from the service's stack outputs)
TASK_QUEUE=https://sqs.us-east-1.amazonaws.com/<account>/<queue> yarn queue --file scenes.txt
PRIORITY_TASK_QUEUE=https://sqs.us-east-1.amazonaws.com/<account>/<priority-queue> \
  yarn queue --priority --entity-type emote bafkrei...
```

To re-drive a dead-lettered job, either move it back with SQS's DLQ redrive or re-queue its id with `yarn queue`. Fix the cause first (`Storage rejected file ...` in the logs means the bucket, the task role or the KMS key).

## Development

```sh
nvm use          # Node 24
yarn install
yarn build       # tsc -> dist/
yarn lint:check
yarn test        # jest + coverage
```

The tests mock the asset server, SQS, ECS task protection and S3, so they need neither Godot nor a display. Integration tests start the full program on a free port. The Docker build also runs `yarn test`, and changes to `package.json` must come with an updated `yarn.lock` (the build installs with `--frozen-lockfile`).

## Deployment

The image is `quay.io/decentraland/godot-asset-optimizer`, built from the repo-root `Dockerfile`:
- The build stage uses Node 24.
- The runtime stage is `GODOT_IMAGE`, pinned to an immutable godot-explorer commit-sha tag, with Node 24, tini and the Xvfb probe tools added.
- The baked output depends on the engine version. Bump `GODOT_IMAGE` on purpose, and bump `S3_PREFIX` with it whenever the output format changes.

Workflows (`.github/workflows/`, all using [decentraland/platform-actions](https://github.com/decentraland/platform-actions)):

The image is built and pushed to quay, but nothing deploys yet. `docker-next.yml` will deploy to dev once `deployment-environment: dev` is added back, after the ECS service exists. `docker-release.yml` stays manual-only (`workflow_dispatch`) until stg and prd exist; its real trigger is commented out.

| Workflow | Trigger | Does |
|---|---|---|
| `build.yml` | push, PR | `apps-build.yml`: lint, build, test, coverage |
| `pr.yml` | PR | `apps-pr.yml`: builds the image, tagged with the PR head sha |
| `docker-next.yml` | push to `main` | `apps-docker-next.yml`: pushes `:<sha>` and `:next` (the deploy to **dev** is not enabled yet) |
| `docker-release.yml` | GitHub release created (disabled) | `apps-docker-release.yml`: pushes `:<release-tag>` and `:latest`, deploys to **stg** and **prd** |
| `validate-pr-title.yml` | PR | Conventional-commit PR titles |

The ECS service is defined in Decentraland's internal infrastructure definitions (`src/services/godot-asset-optimizer.ts`). That file owns:
- the queues and the DLQ (with the redrive `maxReceiveCount`), and the SNS subscription with its filter policy
- the S3 bucket permissions on the task role
- the environment variables
- the Fargate size, health check and queue-depth autoscaling

Its stack outputs the queue URLs to use with `yarn queue`.

## License

[Apache-2.0](LICENSE)
