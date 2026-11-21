#!/usr/bin/env bash
[ -f /tmp/discord-streamer.pid ] && kill -TERM "$(cat /tmp/discord-streamer.pid)" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8; do pgrep -f "src/index.js" >/dev/null || break; sleep 1; done
pkill -9 -f "src/index.js" 2>/dev/null
rm -f /tmp/discord-streamer.pid
pgrep -af "src/index.js" || echo stopped
