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

Build the browser assets and the externalized Bun server bundle:

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

The `build/server.js` bundle intentionally loads WebTorrent's native packages
from `node_modules`; Bun 1.4 cannot compile those dynamic native modules into a
single executable. A production snapshot therefore contains `build/`, `dist/`,
the runtime scripts, the manifest, and the lockfile. `make restore` installs
production dependencies before starting it.

Persistent state is kept separately:

- `tplayer_history.sqlite` stores compatible history plus torrent metadata and
  cache bookkeeping.
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

TCP, DHT, trackers, local discovery, and peer exchange are enabled. uTP is
disabled because `utp-native` uses a libuv operation unsupported by Bun 1.4;
setting `TPLAYER_UTP=true` fails fast instead of crashing the process.

Health is exposed at `GET /api/health`. The versioned Cloudflare desired state,
safe onboarding steps, and rollback procedure are documented in
[`cloudflare/onboarding.md`](cloudflare/onboarding.md).
