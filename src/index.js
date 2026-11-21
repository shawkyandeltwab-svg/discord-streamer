import chalk from "chalk";
import fs from "fs";
import { loadConfig } from "./config.js";
import { Dashboard } from "./dashboard.js";
import { StreamEngine, trace } from "./engine.js";
import { startInput } from "./input.js";
import { prepareSwap, getSpareName } from "./swap.js";

// ---- config ----
const HARD_KILL_MS = 1500; // force-exit this long after the first exit request
const EXIT_FILE = "/tmp/discord-streamer.exit"; // run.sh reads the intended exit code from here
const EXIT_SWAP = 10;      // run.sh restarts immediately on this code
// ----------------

let engine = null;
let dashboard = null;
let tickInterval = null;
let stopInput = () => {};
let isExiting = false;
let swapping = false;

function handleExit(code = 0) {
  if (isExiting) process.kill(process.pid, "SIGKILL");
  isExiting = true;
  try { fs.writeFileSync(EXIT_FILE, String(code)); } catch {}
  trace("exit requested code=" + code);
  setTimeout(() => process.kill(process.pid, "SIGKILL"), HARD_KILL_MS).unref();
  try { clearInterval(tickInterval); } catch {}
  try { stopInput(); } catch {}
  try { engine?.stop(); } catch (e) { trace("stop threw " + e.message); }
  trace("engine stopped");
  console.log(
    chalk.yellow(code === EXIT_SWAP ? "\nTokens swapped. Restarting...\n" : "\nDisconnected from Discord. Exiting.\n")
  );
  process.exit(code);
}

async function doSwap() {
  if (swapping || isExiting) return;
  swapping = true;
  dashboard.addLog("Swap: checking the spare token...", "info");
  const result = await prepareSwap();
  if (result.error) {
    dashboard.addLog("Swap cancelled: " + result.error, "error");
    swapping = false;
    return;
  }
  dashboard.addLog(`Swapping, restarting as ${result.username}...`, "warn");
  try {
    result.write();
  } catch (e) {
    dashboard.addLog("Swap failed writing .env: " + e.message, "error");
    swapping = false;
    return;
  }
  handleExit(EXIT_SWAP);
}

function onCommand(cmd) {
  if (cmd === "end") {
    dashboard.addLog("Ending stream...", "warn");
    handleExit(0);
  } else if (cmd === "swap") {
    doSwap();
  } else {
    dashboard.addLog(`Unknown command "${cmd}" (use end or swap)`, "warn");
  }
}

process.on("SIGINT", () => handleExit(0));
process.on("SIGTERM", () => handleExit(0));
process.on("unhandledRejection", (e) => trace("unhandledRejection " + (e && e.message ? e.message : e)));
process.on("uncaughtException", (e) => trace("uncaughtException " + (e && e.message ? e.message : e)));

async function main() {
  try {
    const config = await loadConfig();
    console.clear();

    dashboard = new Dashboard(config);
    dashboard.render();
    stopInput = startInput({ dashboard, onCommand, onInterrupt: () => handleExit(0) });

    getSpareName()
      .then((name) => {
        dashboard.setSpare(name);
        dashboard.addLog(`Streaming as ${config.streamers[0].user.username}, spare: ${name}`, "info");
      })
      .catch(() => {});

    tickInterval = setInterval(() => {
      if (engine) engine.tick();
      else dashboard.render();
    }, 1000);

    engine = new StreamEngine(config, dashboard);
    await engine.start();
  } catch (error) {
    console.error(chalk.red("\nFatal error:"), error);
    process.exit(1);
  }
}

main();
