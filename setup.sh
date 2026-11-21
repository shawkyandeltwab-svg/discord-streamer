#!/usr/bin/env bash
# Setup for Debian/Ubuntu, including proot-distro on Termux. Run once: bash setup.sh
cd "$(dirname "$0")" || exit 1

if [ "$(uname -o 2>/dev/null)" = "Android" ]; then
  echo "This is native Termux. Use proot-distro Debian first."; exit 1
fi

# system packages (root only, e.g. proot-distro): git curl ca-certificates xz-utils procps tmux
if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null; then
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates xz-utils procps tmux || { echo "apt install failed"; exit 1; }
fi

export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  command -v curl >/dev/null || { echo "install curl first: apt install -y curl"; exit 1; }
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install --lts || { echo "node install failed"; exit 1; }

npm install --ignore-scripts || { echo "npm install failed"; exit 1; }
npm install-scripts approve ffmpeg-static node-av zeromq 2>/dev/null || true
npm rebuild ffmpeg-static node-av zeromq || { echo "native rebuild failed"; exit 1; }
node --input-type=module -e "import('node-av').then(()=>console.log('node-av ok'))" || { echo "node-av failed to load"; exit 1; }
chmod +x run.sh stop.sh

if [ ! -f .env ]; then
  read -rsp "streamer token: " ST; echo
  read -rsp "spare token (optional, press enter to skip): " VT; echo
  read -rp "server (guild) id: " GI
  read -rp "voice channel id: " CI
  printf 'STREAMER_TOKENS=%s\nSPARE_TOKEN=%s\nGUILD_ID=%s\nCHANNEL_ID=%s\nFPS=10\nBITRATE_KBPS=150\n' "$ST" "$VT" "$GI" "$CI" > .env
  chmod 600 .env
  unset ST VT GI CI
fi
echo "done. start with ./run.sh"
