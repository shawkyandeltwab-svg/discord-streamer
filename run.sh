#!/usr/bin/env bash
# ---- config ----
RESTART_DELAY=20     # seconds between restarts after a crash
FAST_FAIL_SECS=90    # a run shorter than this counts as a fast fail
MAX_FAST_FAILS=4     # stop after this many fast fails in a row
STOP_GRACE=3         # seconds to let node exit before kill -9
# ----------------
cd "$(dirname "$0")" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export NO_WIZARD=1

# stop an older copy first, so ./run.sh can always be started directly
if [ -f /tmp/discord-streamer.pid ] || pgrep -f "src/index.js" >/dev/null 2>&1; then
  echo "stopping previous instance..."
  ./stop.sh >/dev/null 2>&1
fi

exec 9>/tmp/discord-streamer.lock
if command -v flock >/dev/null && ! flock -n 9; then
  echo "another copy is still running, try ./stop.sh"; exit 1
fi
echo $$ > /tmp/discord-streamer.pid
trap 'rm -f /tmp/discord-streamer.pid' EXIT

exec 3<&0
child=""
stop_all() {
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  for _ in $(seq "$STOP_GRACE"); do
    [ -n "$child" ] && kill -0 "$child" 2>/dev/null || break
    sleep 1
  done
  [ -n "$child" ] && kill -9 "$child" 2>/dev/null
  exit 0
}
trap stop_all TERM INT

fails=0
while true; do
  started=$(date +%s)
  rm -f /tmp/discord-streamer.exit
  node src/index.js <&3 &
  child=$!
  wait "$child"
  code=$?
  [ -f /tmp/discord-streamer.exit ] && code=$(cat /tmp/discord-streamer.exit)
  stty sane 2>/dev/null
  [ "$code" -eq 0 ] && exit 0
  [ "$code" -eq 2 ] && { echo "config incomplete, run: bash setup.sh"; exit 2; }
  [ "$code" -eq 3 ] && { echo "circuit breaker tripped, not restarting"; exit 3; }
  [ "$code" -eq 10 ] && { echo "tokens swapped, restarting"; fails=0; continue; }
  if [ $(( $(date +%s) - started )) -lt "$FAST_FAIL_SECS" ]; then fails=$((fails+1)); else fails=0; fi
  if [ "$fails" -ge "$MAX_FAST_FAILS" ]; then echo "too many fast failures, stopping"; exit 1; fi
  echo "exited with $code, restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY" & wait $!
done
