.PHONY: all run-with-deps build build-frontend build-backend run run-dev dev-frontend snapshot restore install-deps install-go-deps clean help

# Variables
GO_BINARY := tplayer
BUILD_DIR := build
FRONTEND_DIST := dist
SERVER_DIST := server/dist
TARBALL := build.tar.gz
GO_TOOLS := github.com/anacrolix/confluence@latest

# Default target
all: help
run-with-deps: install-deps run

# Build targets
build: build-backend

build-frontend:
	@echo "Building frontend..."
	bun run build

build-backend: build-frontend
	@echo "Building Go backend..."
	rm -rf $(SERVER_DIST)
	mv $(FRONTEND_DIST) $(SERVER_DIST)
	cd server && go build -o ../$(GO_BINARY)

# Run targets
run: build-backend install-go-deps
	@echo "Running $(GO_BINARY)..."
	./$(GO_BINARY)

run-dev:
	@echo "Starting development environment..."
	$(MAKE) -j2 run dev-frontend

dev-frontend:
	@echo "Starting frontend dev server..."
	bun run dev

snapshot: build-backend
	@echo "Creating production snapshot..."
	tar -czvf $(TARBALL) $(SERVER_DIST) $(GO_BINARY)

restore:
	@echo "Restoring from snapshot..."
	@if [ ! -f $(TARBALL) ]; then \
		echo "Error: $(TARBALL) not found"; \
		exit 1; \
	fi
	tar -xzvf $(TARBALL)
	$(MAKE) build-backend

install-deps:
	@echo "Installing all dependencies..."
	@if command -v apt >/dev/null 2>&1; then \
		sudo apt update && sudo apt install -y golang; \
	elif command -v brew >/dev/null 2>&1; then \
		brew install go; \
	else \
		echo "Warning: Please install Go manually"; \
	fi
	bun install
	$(MAKE) install-go-deps

install-go-deps:
	@echo "Installing Go tools..."
	go install $(GO_TOOLS)

# Utility targets
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(FRONTEND_DIST) $(SERVER_DIST) $(GO_BINARY) $(TARBALL)
	go clean ./...

help:
	@echo "Available targets:"
	@echo "  build            - Build frontend and backend"
	@echo "  run-with-deps    - Build and run the application (with dependencies installed)"
	@echo "  build-frontend   - Build frontend only"
	@echo "  build-backend         - Build Go backend only"
	@echo "  run              - Build and run the application"
	@echo "  run-dev          - Start development environment (frontend + backend)"
	@echo "  dev-frontend     - Start frontend dev server"
	@echo "  snapshot         - Create production snapshot tarball"
	@echo "  restore          - Restore from snapshot and rebuild Go"
	@echo "  install-deps     - Install dependencies on fresh system"
	@echo "  install-go-deps  - Install Go tools only"
	@echo "  clean            - Remove build artifacts"
	@echo "  help             - Show this help message"
