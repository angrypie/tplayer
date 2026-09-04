.PHONY: all run-with-deps build prod build-frontend build-backend run prod-run production-config run-dev dev-frontend dev-backend launchctl-install launchctl-start launchctl-stop launchctl-restart launchctl-status launchctl-logs test test-macos test-ui benchmark snapshot restore install-deps clean help

BUILD_DIR := build
FRONTEND_DIST := dist
TARBALL := build.tar.gz
BUN ?= $(HOME)/.bun/bin/bun
BUN_DIRECTORY := $(dir $(BUN))
export PATH := $(BUN_DIRECTORY):$(PATH)

# Default target
all: help
run-with-deps: install-deps run

# Build targets
build: build-backend

prod: build-backend

build-frontend:
	@echo "Building frontend..."
	$(BUN) run build:frontend

build-backend: build-frontend
	@echo "Building Bun/Hono backend..."
	$(BUN) run build:server

# Production run targets
run: prod-run

prod-run: build-backend
	@echo "Running TPlayer..."
	$(BUN) run start

production-config:
	TPLAYER_BUN_BIN=$(BUN) sh scripts/run-production.sh --print-config

launchctl-install: build-backend
	$(BUN) run service:install

launchctl-start: build-backend
	$(BUN) run service:start

launchctl-stop:
	$(BUN) run service:stop

launchctl-restart: build-backend
	$(BUN) run service:restart

launchctl-status:
	$(BUN) run service:status

launchctl-logs:
	$(BUN) run service:logs

run-dev:
	@echo "Starting development environment..."
	$(MAKE) -j2 dev-backend dev-frontend

dev-backend:
	@echo "Starting backend development server..."
	$(BUN) run dev:server

dev-frontend:
	@echo "Starting frontend dev server..."
	$(BUN) run dev

test:
	$(BUN) run test

test-macos:
	$(BUN) run test:macos

test-ui:
	$(BUN) run test:ui

benchmark:
	$(BUN) run benchmark

snapshot: build-backend
	@echo "Creating production snapshot..."
	tar -czvf $(TARBALL) $(BUILD_DIR) $(FRONTEND_DIST) packages scripts package.json bun.lock bunfig.toml

restore:
	@echo "Restoring from snapshot..."
	@if [ ! -f $(TARBALL) ]; then \
		echo "Error: $(TARBALL) not found"; \
		exit 1; \
	fi
	tar -xzvf $(TARBALL)
	$(BUN) install --production --frozen-lockfile

install-deps:
	@echo "Installing Bun dependencies..."
	$(BUN) install --frozen-lockfile
	$(BUN) run hooks:install

# Utility targets
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(FRONTEND_DIST) $(BUILD_DIR)
	rm -f $(TARBALL)

help:
	@echo "Available targets:"
	@echo "  build            - Build frontend and backend"
	@echo "  prod             - Build the production frontend and backend bundle"
	@echo "  run-with-deps    - Build and run the application (with dependencies installed)"
	@echo "  build-frontend   - Build frontend only"
	@echo "  build-backend    - Build the Hono backend bundle"
	@echo "  run              - Alias for prod-run"
	@echo "  prod-run         - Build and run production in this terminal"
	@echo "  production-config - Print the shared production paths"
	@echo "  run-dev          - Start development environment (frontend + backend)"
	@echo "  dev-frontend     - Start the frontend development server"
	@echo "  dev-backend      - Start the backend development server"
	@echo "  launchctl-install - Build, install, and start the macOS LaunchAgent"
	@echo "  launchctl-start  - Build and start the installed LaunchAgent"
	@echo "  launchctl-stop   - Stop and unload the LaunchAgent"
	@echo "  launchctl-restart - Rebuild and restart the LaunchAgent"
	@echo "  launchctl-status - Show LaunchAgent, origin, and path status"
	@echo "  launchctl-logs   - Show the last 100 service log lines"
	@echo "  test             - Run Bun integration tests"
	@echo "  test-macos       - Verify terminal/LaunchAgent path parity"
	@echo "  test-ui          - Run Playwright UI tests"
	@echo "  benchmark        - Run measured performance benchmarks"
	@echo "  snapshot         - Create production snapshot tarball"
	@echo "  restore          - Restore a production Bun snapshot"
	@echo "  install-deps     - Install dependencies on fresh system"
	@echo "  clean            - Remove build artifacts"
	@echo "  help             - Show this help message"
