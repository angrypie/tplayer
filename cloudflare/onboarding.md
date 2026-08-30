# Cloudflare onboarding and recovery

TPlayer runs as a local Bun/Hono service on `127.0.0.1:8082`. Cloudflare publishes it
at `https://tplayer.angrypie.dev` through the existing remotely managed tunnel
`couchview-angrypie-dev`, with Cloudflare Access in front of the application.

This directory makes the intended TPlayer-specific state reviewable in Git:

- `desired-state.json` identifies the account, zone, shared tunnel, ingress,
  proxied DNS record, Access application, Access policy, and health checks.
- `desired-state.schema.json` documents the manifest format.
- `../scripts/cloudflare.ts` plans, applies, verifies, snapshots, and rolls back
  that state through the Cloudflare API.

Secrets and generated rollback snapshots are deliberately not committed.

## Why this uses an onboarding tool

The tunnel is shared with `couchview.angrypie.dev`. Replacing its complete
configuration from a TPlayer-only Terraform resource could remove Couchview's
ingress rule. The onboarding tool merges only the TPlayer hostname, preserves
all unrelated ingress rules, and keeps the catch-all rule last.

It also refuses to replace conflicting DNS records unless `--replace-dns` is
explicitly supplied. An existing Access application without the
`tplayer-onboarding` tag is preserved, and onboarding remains blocked until an
operator explicitly reviews and tags it.

## One-time credentials

Create a Cloudflare API token scoped to only the `angrypie.dev` zone and its
account, with these permissions:

- Account / Cloudflare Tunnel / Edit
- Account / Access: Apps and Policies / Edit
- Zone / DNS / Edit
- Zone / Cache Purge / Purge

Copy the ignored environment template and fill it locally:

```sh
cp cloudflare/onboarding.env.example .env.cloudflare
chmod 600 .env.cloudflare
```

Set at least one Access principal as a comma-separated list. Individual emails
go in `TPLAYER_ACCESS_EMAILS`; email domains go in
`TPLAYER_ACCESS_EMAIL_DOMAINS`. The package commands automatically load this
ignored file. Never commit or paste its token into logs.

## Safe onboarding

First validate the checked-in state and exercise the merge logic without
contacting Cloudflare:

```sh
bun run cloudflare -- validate
bun run cloudflare:test
```

Build and start the production origin before testing the route. For a persistent
per-user macOS service:

```sh
make launchctl-install
make launchctl-status
```

For a foreground run instead, first use `make launchctl-stop`, then
`make prod-run`. Both modes use the same absolute database and torrent-cache
paths and listen on `127.0.0.1:8082`, which is the origin already configured in
the shared Cloudflare Tunnel.

In a second terminal, check the origin and public Access boundary, then inspect
the read-only Cloudflare plan:

```sh
bun run cloudflare -- runtime
bun run cloudflare:plan
```

Apply only after reviewing every plan item:

```sh
bun run cloudflare:onboard
```

The interactive command asks for confirmation. For an unattended, already
reviewed run, use `bun run cloudflare:onboard --yes`. A plan with a conflict or
missing Access principals remains blocked.

Finally, verify both the Cloudflare resources and the running application:

```sh
bun run cloudflare:verify
```

The verification succeeds only when the managed resources have no drift, the
local UI and API respond, and the public hostname redirects through Cloudflare
Access.

After deploying a new frontend, purge only the non-fingerprinted entry points
so browsers cannot receive an older app shell, service worker, or bootstrap
library response:

```sh
bun run cloudflare:purge --yes
```

This command requires `--yes` and sends a single-file purge containing exactly
`https://tplayer.angrypie.dev/`, `https://tplayer.angrypie.dev/sw.js`,
`https://tplayer.angrypie.dev/sw-upgrade-v2.js`, and
`https://tplayer.angrypie.dev/api/torrents`. It does not purge the whole zone,
fingerprinted assets, media URLs, or any other API response.

## Snapshots and rollback

Every apply writes a permission-restricted snapshot to `.cloudflare-state/`
before changing Cloudflare. The directory is ignored by Git because snapshots
can contain account configuration. Keep the printed path if a rollback might be
needed.

To restore a snapshot:

```sh
bun run cloudflare:rollback -- .cloudflare-state/cloudflare-TIMESTAMP.json --yes
```

Rollback refuses to run if the checked-in manifest changed or Cloudflare was
modified after the apply. Review the newer changes first; `--force` overrides
those guards and should be reserved for deliberate recovery.

## Access ownership

The currently deployed Access application may predate this repository. The tool
will not silently take ownership of an untagged application or rewrite its
policies. Plan, apply, and desired-state verification remain blocked for that
application. To fully manage it here, first review its application and policy in
the Cloudflare dashboard, make them match `desired-state.json`, and add the tag
`tplayer-onboarding`. The next plan will show the managed configuration and can
reconcile it. Until then, runtime checks still verify that Access protects the
public hostname, but the external policy remains outside repository rollback.

## Operational recovery

- If the public URL fails but the origin works, run `cloudflare:plan` and inspect
  the tunnel connector in Cloudflare.
- If both fail, restart the local production service before changing Cloudflare.
- If Access stops redirecting, do not expose the origin publicly; restore the
  Access application or roll back the last managed change.
- Never remove or replace the Couchview ingress rule while repairing TPlayer.
