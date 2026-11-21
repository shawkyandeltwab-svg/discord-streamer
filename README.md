# discord-streamer

Headless Discord go-live streamer for user accounts, run from a terminal. It joins a voice channel and loops a small test video as a go-live stream.

Automating a user account breaks Discord's Terms of Service. Use accounts you can afford to lose.
This version has no viewer, and nothing here proves it earns badge hours.

## What you need

- A Linux machine, a VPS, or a phone running Termux with proot-distro Debian (native Termux does not work).
- A Discord account to stream from, and its token. Never share a token with anyone.
- A server and a voice channel that account can join and stream in, and their IDs
  (Discord settings > Advanced > Developer Mode, then right-click the server or channel > Copy ID).

## 1. Termux only: one-time Debian setup

Skip this on a PC or VPS. Run each line on its own:

    pkg update
    pkg install proot-distro
    termux-setup-storage
    proot-distro install debian
    proot-distro login debian

Everything below runs inside Debian.

## 2. Dependencies

Copy this whole line to install everything the program needs from the system:

    apt update && apt install -y git curl ca-certificates xz-utils procps tmux

Node.js (through nvm), ffmpeg and the native libraries come with setup.sh, so no apt ffmpeg is needed.
Only if the install later fails on node-av, also add the build tools:

    apt install -y build-essential python3 pkg-config

## 3. Install

    git clone https://github.com/shawkyandeltwab-svg/discord-streamer.git
    cd discord-streamer
    bash setup.sh

setup.sh installs Node.js, the npm packages and the native pieces, then asks for your streamer token, an optional spare token, the server ID and the voice channel ID. It saves them to .env, which is never committed. On a phone this takes around 10 minutes.

## 4. Run

    ./run.sh

You do not need ./stop.sh first, run.sh stops an older copy by itself. The first start can take a few minutes on a slow connection, and it retries on its own.

The dashboard status goes Joining channel..., then Starting stream..., then Broadcasting. Total Farmed only counts after Broadcasting.

## 5. Commands

Type in the Command row at the bottom, then press Enter:

- end: stop the stream and exit.
- swap: swap the streamer token with SPARE_TOKEN in .env, then restart on the other account. With no spare token set, swap changes nothing and tells you.
- ctrl+c: also exits. Press it once and wait a couple of seconds.

## 6. Keep it running (24/7)

    tmux new -s stream ./run.sh

Detach with ctrl+b then d. Come back with:

    tmux attach -t stream

Stop it from anywhere with ./stop.sh. On Termux, run termux-wake-lock from a normal Termux session (outside Debian) and set Termux battery usage to unrestricted, so Android does not suspend it.

## 7. Settings (.env)

    STREAMER_TOKENS=   token of the account that streams
    SPARE_TOKEN=       optional second account for swap
    GUILD_ID=          server ID
    CHANNEL_ID=        voice channel ID
    FPS=10             optional
    BITRATE_KBPS=150   optional

To change one value, for example the frame rate, then restart (end, then ./run.sh):

    sed -i 's/^FPS=.*/FPS=12/' .env

## 8. Update

    git pull
    npm install

## 9. Troubleshooting

- Joining channel... for minutes: your connection is dropping new connections. The program retries with growing delays. Try wifi against mobile data. Test with: curl -s -o /dev/null -w "%{time_connect}\n" https://discord.com
- go-live did not start, or voice socket closed: same cause, it retries by itself.
- Config incomplete: run bash setup.sh.
- node-av failed to load: you are in native Termux. Use proot-distro Debian (step 1).
- npm blocks install scripts: run npm install-scripts approve ffmpeg-static node-av zeromq, then npm rebuild ffmpeg-static node-av zeromq
- Terminal looks broken after a crash: run stty sane
- A log of what the program did is in /tmp/engine_trace.txt. Include it when asking for help.
