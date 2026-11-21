import fs from "fs";
import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, prepareStream, playStream } from "@dank074/discord-video-stream";
import { ensureDummyMedia, injectFFmpegPath } from "./media.js";
import { loadStats, saveStats, detectProfileStreamingBadge } from "./storage.js";
import { TelemetryService } from "./telemetry.js";

// ---- config ----
const DEAD_SOCKET_POLLS = 3; // seconds a closed voice socket is tolerated during a join
const JOIN_TIMEOUT_MS = 120000;    // max wait for the voice join (slow links need this)
const GOLIVE_TIMEOUT_MS = 120000;  // max wait for the go-live connection after the join
const LEAVE_ECHO_GUARD_MS = 5000;  // ignore null-channel events this long after our own leave
const RETRY_BASE_MS = 5000;        // first retry delay, doubles per consecutive failure
const RETRY_MAX_MS = 60000;        // retry delay cap
const HEALTHY_RUN_MS = 60000;      // a broadcast live this long resets the failure counter
const WATCHDOG_MS = 15000;         // stream health check interval
const STATS_SAVE_MS = 15000;
const PROFILE_CHECK_MS = 5 * 60 * 1000;
const TRACE_FILE = "/tmp/engine_trace.txt";
// ----------------

const T0 = Date.now();
export function trace(msg) {
  try {
    fs.appendFileSync(TRACE_FILE, ((Date.now() - T0) / 1000).toFixed(1) + "s " + msg + "\n");
  } catch {}
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout(promise, ms, label, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(label + " timed out after " + Math.round(ms / 1000) + "s"));
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

export class StreamEngine {
  constructor(config, dashboard) {
    this.config = config;
    this.dashboard = dashboard;
    this.statsData = loadStats();

    this.streamers = config.streamers.map((s) => {
      const streamerStats = this.statsData.streamers[s.user.id] || {
        totalSeconds: 0,
        lastBadgeTier: 0,
      };
      this.statsData.streamers[s.user.id] = streamerStats;

      const client = new Client({ checkUpdate: false });
      return {
        id: s.user.id,
        user: s.user,
        token: s.token,
        client: client,
        streamer: new Streamer(client),
        telemetry: new TelemetryService(s.token, s.user),
        isStreaming: false,
        controller: null,
        leaveGuardUntil: 0,
        liveSince: 0,
        consecutiveFails: 0,
        status: "Connecting...",
        sessionFarmedSeconds: 0,
        stats: streamerStats,
      };
    });

    this.isRunning = false;
    this.statsSaveTimer = null;
    this.profileCheckTimer = null;
    this.watchdogTimer = null;
    this.dummyVideoPath = null;

    this.syncDashboardStreamers();
  }

  syncDashboardStreamers() {
    this.dashboard.updateStreamers(
      this.streamers.map((s) => ({
        id: s.id,
        username: s.user.username,
        tag: s.user.tag || s.user.username,
        status: s.status,
        isStreaming: s.isStreaming,
        totalSeconds: s.stats.totalSeconds,
        sessionSeconds: s.sessionFarmedSeconds,
      }))
    );
  }

  tick() {
    for (const s of this.streamers) {
      if (s.isStreaming) {
        s.stats.totalSeconds += 1;
        s.sessionFarmedSeconds += 1;
      }
    }
    this.syncDashboardStreamers();
  }

  async start() {
    this.isRunning = true;
    injectFFmpegPath();
    this.dummyVideoPath = await ensureDummyMedia();

    this.checkAllProfileBadges().catch(() => {});
    for (const s of this.streamers) s.telemetry.init().catch(() => {});

    for (const s of this.streamers) {
      s.client.once("ready", () => {
        this.dashboard.addLog(`Streamer ready: ${s.user.username}`, "success");
        trace("ready " + s.user.username);
        this.superviseStreamer(s);
      });

      s.client.on("voiceStateUpdate", (oldState, newState) => {
        if (!this.isRunning || newState.id !== s.user.id) return;
        if (newState.channelId === this.config.CHANNEL_ID) return;
        trace("vsu channel=" + newState.channelId);
        if (!newState.channelId && Date.now() < s.leaveGuardUntil) {
          trace("ignored echo of own leave");
          return;
        }
        this.dashboard.addLog(`${s.user.username} ${newState.channelId ? "was moved" : "disconnected"}, restarting...`, "warn");
        s.controller?.abort();
      });
    }

    this.statsSaveTimer = setInterval(() => {
      if (this.isRunning && this.statsData) saveStats(this.statsData);
    }, STATS_SAVE_MS);

    this.profileCheckTimer = setInterval(() => {
      if (this.isRunning) this.checkAllProfileBadges().catch(() => {});
    }, PROFILE_CHECK_MS);

    this.watchdogTimer = setInterval(() => {
      if (!this.isRunning) return;
      for (const s of this.streamers) {
        if (!s.isStreaming || Date.now() - s.liveSince < 20000) continue;
        const conn = s.streamer?.voiceConnection;
        const streamConn = conn?.streamConnection;
        const dead =
          !conn ||
          !streamConn ||
          (streamConn.ws && streamConn.ws.readyState > 1) ||
          conn.status?.started === false;
        if (dead) {
          this.dashboard.addLog(`Stream watchdog: ${s.user.username} stalled, restarting...`, "warn");
          trace("watchdog abort");
          s.controller?.abort();
        }
      }
    }, WATCHDOG_MS);

    await Promise.all(this.streamers.map((s) => s.client.login(s.token)));
  }

  async superviseStreamer(s) {
    while (this.isRunning) {
      let liveMs = 0;
      try {
        liveMs = await this.broadcastOnce(s);
      } catch (err) {
        if (this.isRunning && err.message !== "aborted") {
          this.dashboard.addLog(`Stream error (${s.user.username}): ${err.message}`, "warn");
          trace("error " + err.message);
        }
      }
      if (!this.isRunning) return;

      s.consecutiveFails = liveMs >= HEALTHY_RUN_MS ? 0 : s.consecutiveFails + 1;
      const exp = Math.max(0, Math.min(s.consecutiveFails - 1, 4));
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exp);
      s.status = `Retrying in ${Math.round(delay / 1000)}s...`;
      this.syncDashboardStreamers();
      trace("retry in " + delay + "ms fails=" + s.consecutiveFails);
      await sleep(delay).catch(() => {});
    }
  }

  async broadcastOnce(s) {
    const { GUILD_ID, CHANNEL_ID, FPS, BITRATE_KBPS } = this.config;
    const ac = new AbortController();
    s.controller = ac;
    s.isStreaming = false;
    s.status = "Joining channel...";
    this.syncDashboardStreamers();
    trace("broadcastOnce begin");

    let media = null;
    let playErr = null;
    let playDone = false;
    let wentLive = false;
    let liveMs = 0;

    try {
      s.leaveGuardUntil = Date.now() + LEAVE_ECHO_GUARD_MS;
      if (s.streamer.voiceConnection) {
        try { s.streamer.stopStream(); } catch {}
        try { s.streamer.leaveVoice(); } catch {}
      }

      let watchTimer = null;
      let closedPolls = 0;
      const deadSocket = new Promise((_, reject) => {
        watchTimer = setInterval(() => {
          const vc = s.streamer.voiceConnection;
          const dead = vc && vc.ws && vc.ws.readyState === 3 && vc.status && vc.status.hasToken && !vc.status.started;
          closedPolls = dead ? closedPolls + 1 : 0;
          if (closedPolls >= DEAD_SOCKET_POLLS) reject(new Error("voice socket closed during join"));
        }, 1000);
      });
      try {
        await withTimeout(Promise.race([s.streamer.joinVoice(GUILD_ID, CHANNEL_ID), deadSocket]), JOIN_TIMEOUT_MS, "voice join", ac.signal);
      } finally {
        clearInterval(watchTimer);
      }
      trace("joinVoice resolved");

      const fps = Math.max(FPS || 10, 5);
      const bitrate = Math.max(BITRATE_KBPS || 150, 100);

      media = prepareStream(this.dummyVideoPath, {
        videoCodec: "H264",
        bitrateVideo: bitrate,
        bitrateVideoMax: bitrate + 50,
        frameRate: fps,
        width: 480,
        height: 270,
        includeAudio: true,
        customInputOptions: ["-stream_loop", "-1"],
      });

      s.status = "Starting stream...";
      this.syncDashboardStreamers();

      const playing = playStream(
        media.output,
        s.streamer,
        { type: "go-live", width: 480, height: 270, frameRate: fps },
        ac.signal
      ).then(
        () => { playDone = true; },
        (e) => { playDone = true; playErr = e; }
      );

      const waitStart = Date.now();
      while (!s.streamer.voiceConnection?.streamConnection) {
        if (ac.signal.aborted) throw new Error("aborted");
        if (playErr) throw playErr instanceof Error ? playErr : new Error(String(playErr));
        if (playDone) throw new Error("stream ended before go-live started");
        if (Date.now() - waitStart > GOLIVE_TIMEOUT_MS) {
          throw new Error("go-live did not start within " + Math.round(GOLIVE_TIMEOUT_MS / 1000) + "s");
        }
        await sleep(500, ac.signal);
      }

      wentLive = true;
      s.isStreaming = true;
      s.liveSince = Date.now();
      s.status = "Broadcasting";
      this.syncDashboardStreamers();
      trace("go-live up");
      this.dashboard.addLog(`Stream live: ${s.user.username}`, "success");
      s.telemetry.onStreamStarted(GUILD_ID, CHANNEL_ID).catch(() => {});

      await Promise.race([
        playing,
        new Promise((resolve) => ac.signal.addEventListener("abort", resolve, { once: true })),
      ]);
      liveMs = Date.now() - s.liveSince;
      if (playErr && !ac.signal.aborted) trace("playStream ended with " + (playErr.message || playErr));
    } finally {
      s.isStreaming = false;
      try { ac.abort(); } catch {}
      try { media?.controller?.abort(); } catch {}
      try { s.streamer.stopStream(); } catch {}
      if (wentLive) s.telemetry.onStreamEnded(GUILD_ID, CHANNEL_ID).catch(() => {});
      this.syncDashboardStreamers();
      trace("broadcastOnce end liveMs=" + liveMs);
    }
    return liveMs;
  }

  async checkAllProfileBadges() {
    try {
      for (const s of this.streamers) {
        const detected = await detectProfileStreamingBadge(s.id, s.token);
        if (detected) {
          const minSeconds = detected.hours * 3600;
          if (s.stats.totalSeconds < minSeconds) {
            s.stats.totalSeconds = minSeconds;
            s.stats.lastBadgeTier = detected.tier;
            saveStats(this.statsData);
            this.dashboard.addLog(`Profile sync: ${s.user.username} -> ${detected.name} (${detected.hours}h)`, "success");
          }
        }
      }
      this.syncDashboardStreamers();
    } catch {}
  }

  stop() {
    this.isRunning = false;
    for (const t of [this.statsSaveTimer, this.profileCheckTimer, this.watchdogTimer]) {
      try { clearInterval(t); } catch {}
    }
    try { if (this.statsData) saveStats(this.statsData); } catch {}

    for (const s of this.streamers) {
      const wasLive = s.isStreaming;
      s.isStreaming = false;
      try { s.controller?.abort(); } catch {}
      try { if (wasLive) s.telemetry.onStreamEnded(this.config.GUILD_ID, this.config.CHANNEL_ID).catch(() => {}); } catch {}
      try { s.streamer?.stopStream(); } catch {}
      try { s.streamer?.leaveVoice(); } catch {}
      try { s.client.destroy(); } catch {}
    }
  }
}
