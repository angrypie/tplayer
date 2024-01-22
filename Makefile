run:
	./tplayer
prod:
	NODE_OPTIONS=--openssl-legacy-provider npm run build
	go build -o tplayer
install:
	apt update && apt install nodejs golang npm
	npm install
	go install github.com/anacrolix/confluence@latest

