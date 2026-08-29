#!/bin/sh

set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname -- "$SCRIPT_DIRECTORY")
EXPECTED_BUN_VERSION=1.4.0
LAUNCHD_LABEL=com.angrypie.tplayer

resolve_project_path() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$PROJECT_ROOT" "$1" ;;
	esac
}

resolve_bun_binary() {
	if [ -n "${TPLAYER_BUN_BIN:-}" ]; then
		printf '%s\n' "$TPLAYER_BUN_BIN"
		return
	fi

	if [ -x "${HOME:-}/.bun/bin/bun" ]; then
		printf '%s\n' "${HOME}/.bun/bin/bun"
		return
	fi

	if command -v bun >/dev/null 2>&1; then
		command -v bun
		return
	fi

	printf '%s\n' 'Bun was not found. Set TPLAYER_BUN_BIN to the Bun 1.4.0 executable.' >&2
	exit 1
}

TPLAYER_BUN_BIN=$(resolve_bun_binary)
TPLAYER_DATABASE_PATH=$(resolve_project_path "${TPLAYER_DATABASE_PATH:-tplayer_history.sqlite}")
TPLAYER_CACHE_DIR=$(resolve_project_path "${TPLAYER_CACHE_DIR:-tplayer-cache}")
TPLAYER_FRONTEND_DIR=$(resolve_project_path "${TPLAYER_FRONTEND_DIR:-dist}")
TPLAYER_LISTEN_ADDR=${TPLAYER_LISTEN_ADDR:-127.0.0.1:8082}
TPLAYER_SERVE_FRONTEND=${TPLAYER_SERVE_FRONTEND:-true}
SERVER_BUNDLE="$PROJECT_ROOT/build/server.js"
FRONTEND_ENTRY="$TPLAYER_FRONTEND_DIR/index.html"

export NODE_ENV=production
export TPLAYER_BUN_BIN
export TPLAYER_CACHE_DIR
export TPLAYER_DATABASE_PATH
export TPLAYER_FRONTEND_DIR
export TPLAYER_LISTEN_ADDR
export TPLAYER_SERVE_FRONTEND

if [ "${1:-}" = '--print-config' ]; then
	printf 'PROJECT_ROOT=%s\n' "$PROJECT_ROOT"
	printf 'TPLAYER_BUN_BIN=%s\n' "$TPLAYER_BUN_BIN"
	printf 'SERVER_BUNDLE=%s\n' "$SERVER_BUNDLE"
	printf 'TPLAYER_DATABASE_PATH=%s\n' "$TPLAYER_DATABASE_PATH"
	printf 'TPLAYER_CACHE_DIR=%s\n' "$TPLAYER_CACHE_DIR"
	printf 'TPLAYER_FRONTEND_DIR=%s\n' "$TPLAYER_FRONTEND_DIR"
	printf 'TPLAYER_LISTEN_ADDR=%s\n' "$TPLAYER_LISTEN_ADDR"
	exit 0
fi

if [ ! -x "$TPLAYER_BUN_BIN" ]; then
	printf 'Bun executable is unavailable: %s\n' "$TPLAYER_BUN_BIN" >&2
	exit 1
fi

BUN_VERSION=$("$TPLAYER_BUN_BIN" --version)
if [ "$BUN_VERSION" != "$EXPECTED_BUN_VERSION" ]; then
	printf 'TPlayer requires Bun %s, but %s reports %s.\n' \
		"$EXPECTED_BUN_VERSION" "$TPLAYER_BUN_BIN" "$BUN_VERSION" >&2
	exit 1
fi

if [ ! -f "$SERVER_BUNDLE" ]; then
	printf 'Production server bundle is missing: %s\nRun "make prod" first.\n' \
		"$SERVER_BUNDLE" >&2
	exit 1
fi

if [ ! -f "$FRONTEND_ENTRY" ]; then
	printf 'Production frontend is missing: %s\nRun "make prod" first.\n' \
		"$FRONTEND_ENTRY" >&2
	exit 1
fi

if [ "${TPLAYER_LAUNCHD:-0}" != '1' ] && command -v launchctl >/dev/null 2>&1; then
	LAUNCHD_DOMAIN="gui/$(id -u)"
	if launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1; then
		printf '%s\n' \
			'TPlayer is already managed by launchd. Run "make launchctl-stop" before foreground production.' >&2
		exit 1
	fi
fi

cd "$PROJECT_ROOT"
exec "$TPLAYER_BUN_BIN" "$SERVER_BUNDLE"
