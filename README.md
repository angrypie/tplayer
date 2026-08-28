
# TPlayer

TPlayer is a React frontend backed by a local Go service and
[`confluence`](https://github.com/anacrolix/confluence).

## Requirements

- [Bun 1.4.0](https://bun.com/docs/installation)
- A current Go toolchain

Install the JavaScript dependencies from the committed Bun lockfile and install
the Go helper:

```sh
bun ci
go install github.com/anacrolix/confluence@latest
```

`bunfig.toml` uses Bun's isolated linker with the global package store. The
project keeps only its dependency links in `node_modules`; package contents are
shared from Bun's cache instead of being copied into every project.

## Development

Start the frontend and backend together:

```sh
make run-dev
```

The Vite UI is served at `http://localhost:3000`; `/api` requests are proxied to
the Go service on `http://127.0.0.1:8082`.

Run the quality checks and production frontend build independently with:

```sh
bun run check
bun run build
```

## Production

Build the frontend and embed it in the Go binary:

```sh
make prod
```

Run the result on the loopback address used by the Cloudflare Tunnel:

```sh
TPLAYER_LISTEN_ADDR=127.0.0.1:8082 ./tplayer
```

The production hostname is `https://tplayer.angrypie.dev` and is protected by
Cloudflare Access. The versioned desired state, safe onboarding steps, and
rollback procedure are documented in
[`cloudflare/onboarding.md`](cloudflare/onboarding.md).
