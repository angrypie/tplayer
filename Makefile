build-frontend:
	npm run build
build-go:
	cd server && go build -o ../tplayer

run: install-go-deps build-go

#if frontend have no changes there is no need to rebuild it, only go build needed (restore)
snapshot: prod
	tar -czvf build.tar.gz build

restore: install-go-deps
	tar -xzvf build.tar.gz
	$(MAKE) build-go

prod:
	npm run build
	rm -rf server/dist
	mv dist server/
	$(MAKE) build-go

install:
	apt update && apt install nodejs golang npm
	npm install
	go install github.com/anacrolix/confluence@latest

install-go-deps:
	go install github.com/anacrolix/confluence@latest
