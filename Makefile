build-frontend:
	bun run build

build-go:
	cd server && go build -o ../tplayer

run: build-go
	./tplayer

run-dev: install-go-deps
	$(MAKE) -j2 dev-backend dev-frontend

dev-frontend:
	bun run dev

dev-backend:
	go run ./server

#if frontend have no changes there is no need to rebuild it, only go build needed (restore)
snapshot: prod
	tar -czvf build.tar.gz build

restore: install-go-deps
	tar -xzvf build.tar.gz
	$(MAKE) build-go

prod:
	bun run build
	rm -rf server/dist
	mv dist server/
	$(MAKE) build-go

install:
	apt update && apt install golang
	bun install
	go install github.com/anacrolix/confluence@latest

install-go-deps:
	go install github.com/anacrolix/confluence@latest
