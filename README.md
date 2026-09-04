# TPlayer

TPlayer is a React audiobook player backed by one local TypeScript service. Bun
runs the Hono HTTP application and a shared server-side WebTorrent client, so
metadata discovery, byte-range media streaming, background downloads, history,
and the production UI all share one lifecycle.

## Responsible content use

TPlayer is for public-domain, openly licensed, self-created, or otherwise
explicitly authorized audiobooks. Never download or share a copyrighted work
without authorization. BitTorrent transfers may upload pieces to other peers,
and owning another copy does not by itself authorize obtaining or uploading a
third-party torrent copy. Read the full [content policy](CONTENT_POLICY.md)
before enabling third-party tracker sources or opening direct peer-to-peer
references.

## Requirements

- [Bun 1.4.0](https://bun.sh/docs/installation)
- FFmpeg available as `ffmpeg` (or set `TPLAYER_FFMPEG_PATH`)
- A current-user CouchSpeech installation for automatic transcription

TPlayer currently consumes the in-progress CouchSpeech JavaScript SDK from the
sibling checkout at `../couchspeech/Clients/JavaScript`. Build that package
before installing TPlayer dependencies:

```sh
cd ../couchspeech/Clients/JavaScript
bun install
bun run build
cd ../../../tplayer
```

Start CouchSpeech with its own `couchspeech start` command. TPlayer never starts
the daemon, reads its credential in browser code, or exposes the daemon beyond
its authenticated loopback connection.

Install the exact dependency set from the committed lockfile:

```sh
bun install --frozen-lockfile
```

`bunfig.toml` uses Bun's isolated linker. The WebTorrent native dependencies
are deliberately listed in `trustedDependencies`; do not remove those entries
without repeating the clean production-install test.

## Development

Start the Vite UI and API together:

```sh
make run-dev
```

The UI is available at `http://localhost:3000`. Vite proxies `/api` to the Hono
service at `http://127.0.0.1:8082`. The development API does not require a
prebuilt frontend.

The main quality gates are:

```sh
bun run fix
bun run check
bun run build
bun run test
bun run test:ui
bun run benchmark
```

The integration suite creates a private local WebTorrent swarm and transfers
real media bytes through Hono. It does not depend on public trackers or peers.

## Automatic transcription and live captions

**Settings → Transcription and captions** contains an off-by-default
**Automatically transcribe audiobooks** setting. The setting belongs to the
local TPlayer server. When enabled, it schedules supported audio only after the
corresponding torrent bytes are already complete in the server cache. It never
registers a torrent, joins peers, or fetches missing audiobook bytes merely to
create captions. Torrent transfers initiated elsewhere may still upload pieces
to peers as described in the content policy. Disabling the setting cancels
queued and running automatic jobs; re-enabling it resumes only jobs cancelled
for that reason. Completed captions remain available.

The manual **Transcribe this chapter** action checks the selected server-side
file independently, so a fully cached chapter can be transcribed while other
chapters are still missing. It does not start a peer-to-peer download. When the
selected chapter is incomplete, the player identifies that prerequisite and
opens the existing server-download controls instead of offering a retry that
cannot succeed. Idle server status retains the downloaded-byte count so a
paused partial download remains distinguishable from an empty cache.

Transcription is performed server-side. FFmpeg decodes the local audio to
bounded mono PCM windows, and the CouchSpeech SDK sends encrypted requests only
to the installed same-user loopback daemon. Audiobook content is never uploaded
to an external transcription service. Requests are serialized and temporary
audio is kept in bounded memory and released on completion, error, or
cancellation. The status API reports the active chapter as queue position 1 and
reports how many chapters are ahead of every waiting job.

TPlayer owns the outer transcription deadline rather than relying on the speech
SDK alone. The deadline covers opening local audio, FFmpeg inactivity, and each
CouchSpeech request. If a stage stops settling, TPlayer aborts and reaps FFmpeg,
requests cancellation of the local reader and provider, and records a retryable
terminal error. It retains ownership, reports degraded health and cleanup as
pending, and blocks the next queued chapter until the underlying operation and
cache lease actually settle. Cancellation endpoints use a bounded confirmation
wait without claiming that physical cleanup already finished. The same deadline
and last committed audio position are exposed in job status so a client can
distinguish healthy work from a stalled or unreachable server.

FFmpeg receives the security-validated cache path while TPlayer holds the same
direct-cache lease, which permits seeking in M4B/M4A containers whose index is
stored at the end of the file. Provider-detected language is recorded by
majority across windows but is never fed back as a request hint for later
windows. Structured CouchSpeech request/audio errors are terminal, while busy,
transport, and timeout failures retain their explicit retry and ambiguity
classification.

Only final caption segments are retained. TPlayer does not persist CouchSpeech's
per-word JSON. The framework-independent `@tplayer/captions` package in
`packages/captions/` segments timings, encodes the versioned TCAP binary format,
and provides indexed media-time lookup without allocating a result object on
each player tick. Compact TCAP bytes and job metadata are stored in the server
SQLite database; the browser caches the exact bytes in IndexedDB for reloads
and offline playback.

The player's **Live captions** control is separate from automatic generation
and is also off by default. It can display an already-generated track whether
automatic transcription is currently enabled or not. Playback, pause, seeks,
rate changes, chapter changes, server/offline source switches, and reloads all
use the media clock, so captions stay aligned without changing the audio path.
Turning the display off does not cancel server work. The Live captions card
shows queue position while work is waiting, explains when that queue is paused
for a previous chapter's physical cleanup, then reports processed audio time,
last activity, and, when the chapter duration is known, a percentage. Running
jobs expose an explicit Cancel action, and the client verifies the resulting
terminal state before reporting cancellation. Polling failures are shown as a
server connection problem without discarding saved captions. Delayed work can
be checked, stopped, and retried explicitly; failures are not replayed
automatically because a timeout after an encrypted upload can be ambiguous.

Clearing large offline audio keeps the much smaller generated captions, notes,
and resume position. Removing the book deletes its client caption cache, and
deleting the torrent from the server cancels its jobs and removes the durable
server captions.

## Audiobook search

Text entered on the home screen is searched across public-domain and
rights-labelled audiobook catalogues before the local library is shown. Direct
magnet links and 40-character or base32 info hashes remain supported. The first
peer-to-peer action requires an explicit lawful-use acknowledgement before any
registration request is sent; the current acknowledgement is then remembered
in that browser.

- [LibriVox](https://librivox.org) and audiobook records from the
  [Internet Archive](https://archive.org) are always enabled. Search results are
  resolved through the Archive metadata API to its published torrent hash and
  stable web seed. LibriVox describes its recordings as public domain in the
  United States. Archive results include source-supplied rights information;
  neither label replaces checking the individual item where you live.
- AudioBookBay is an optional tracker source. It is disabled by default and can
  be enabled under **Settings → Audiobook search sources**. The preference is
  stored in the current browser only after a versioned content-policy
  acknowledgement. AudioBookBay is independently operated; its inclusion is an
  integration example, not an endorsement or a claim that its listings are
  authorized. After acknowledgement, each explicit **Open audiobook** action
  applies only to that selected result without another checkbox.
- Provider failures are isolated, so one unavailable catalogue does not hide
  usable results from another source. Public-domain and rights-labelled results
  are de-duplicated and always displayed before unverified tracker results.

Providers implement the small contract in `server/search/types.ts` and are
registered in `server/search/service.ts`. Browser code talks only to
`GET /api/search/providers`, `GET /api/search`, and
`POST /api/search/resolve`, so upstream parsing and torrent resolution remain
server-side.

The normal integration suite uses real HTTP boundaries, the production
provider parsers and routes, and a deterministic private WebTorrent swarm. It
asserts exact streamed bytes and does not contact public peers. Run the
separate, network-dependent provider contracts when checking current upstream
compatibility:

```sh
bun run test:search:live
bun run test:search:live:tracker
```

The first command checks live LibriVox and Internet Archive search, Archive
torrent resolution, and a bounded audio byte range. The second checks
AudioBookBay search and detail-page hash extraction without joining its public
swarm. These checks can fail when a third-party service is unavailable or
changes its response format; that distinction is intentional.

## Production

Build the browser assets and Bun server bundle:

```sh
make prod
```

Run production in the current terminal:

```sh
make prod-run
```

This foreground process stays attached to the terminal. It uses the same
launcher and state paths as the macOS service. Stop an installed service with
`make launchctl-stop` before using foreground mode; the two modes intentionally
cannot run at the same time.

To install and start the per-user macOS LaunchAgent instead:

```sh
make launchctl-install
make launchctl-status
```

Subsequent operations are `make launchctl-start`, `make launchctl-stop`,
`make launchctl-restart`, and `make launchctl-logs`. Installation writes
`~/Library/LaunchAgents/com.angrypie.tplayer.plist`, preserving the previous
plist once as `.legacy-backup`. It does not modify or restart the separate
Cloudflare connector.

Both modes execute `scripts/run-production.sh`. Run `make production-config`
to inspect the exact resolved paths. Database, torrent cache, frontend, and
bundle paths are anchored to the repository even when the caller has a
different working directory.

The `build/server.js` bundle includes the caption core and CouchSpeech SDK, but
intentionally loads WebTorrent's native packages from `node_modules`; Bun 1.4
cannot compile those dynamic native modules into a single executable. A
production snapshot therefore contains `build/`, `dist/`, the internal package,
runtime scripts, manifest, and lockfile. `make restore` installs only production
dependencies, so the restored bundle does not need the sibling CouchSpeech
source checkout.

Persistent state is kept separately:

- `tplayer_history.sqlite` stores compatible history, torrent metadata, cache
  bookkeeping, the automatic-transcription setting, durable job state, and
  compact TCAP caption bytes.
- `tplayer-cache/` stores piece data and is bounded by a 10 GiB LRU policy by
  default.
- The legacy `tplayer.sqlite` Confluence cache is not reused or overwritten.

Useful environment settings include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TPLAYER_LISTEN_ADDR` | `127.0.0.1:8082` | Hono listen address |
| `TPLAYER_DATABASE_PATH` | `tplayer_history.sqlite` | SQLite history/metadata path |
| `TPLAYER_CACHE_DIR` | `tplayer-cache` | Persistent torrent data path |
| `TPLAYER_CACHE_CAPACITY_BYTES` | `10737418240` | Physical cache limit |
| `TPLAYER_TORRENT_GRACE_MS` | `60000` | Idle shared-session grace period |
| `TPLAYER_TORRENT_PORT` | `42069` | Incoming TCP peer port |
| `TPLAYER_FFMPEG_PATH` | `ffmpeg` | Local FFmpeg executable used for bounded audio decoding |
| `TPLAYER_TRANSCRIPTION_TIMEOUT_MS` | `600000` | TPlayer-owned maximum CouchSpeech request time and pipeline inactivity interval; maximum `2147483647` |

TCP, DHT, trackers, local discovery, and peer exchange are enabled. uTP is
disabled because `utp-native` uses a libuv operation unsupported by Bun 1.4;
setting `TPLAYER_UTP=true` fails fast instead of crashing the process.

Health is exposed at `GET /api/health`; it becomes degraded while a
transcription remains past its watchdog deadline or a terminal attempt still
owns local cleanup resources. A job with `cleanupPending: true` identifies that
owner, while `queueBlockedByCleanup: true` explains why a waiting chapter cannot
start. Do not repeatedly retry either chapter: wait for cleanup to settle. If a
broken local dependency never settles, use `make launchctl-restart`; startup
marks interrupted work as `server_interrupted` and does not replay an ambiguous
upload automatically. The versioned Cloudflare desired state, safe onboarding
steps, and rollback procedure are documented in
[`cloudflare/onboarding.md`](cloudflare/onboarding.md).
