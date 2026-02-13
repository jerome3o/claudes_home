FROM lscr.io/linuxserver/webtop:latest

RUN apk add --no-cache nodejs npm ffmpeg

RUN npm install -g computer-use-mcp
