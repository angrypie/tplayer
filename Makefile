run: install-go-deps
	./tplayer
snapshot: prod
	tar -czvf build.tar.gz build
restore: install-go-deps
	tar -xzvf build.tar.gz
	go build -o tplayer
prod:
	NODE_OPTIONS=--openssl-legacy-provider npm run build
	go build -o tplayer
install:
	apt update && apt install nodejs golang npm
	npm install
	go install github.com/anacrolix/confluence@latest

install-go-deps:
	go install github.com/anacrolix/confluence@latest
