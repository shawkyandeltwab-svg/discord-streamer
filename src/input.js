import fs from "fs";
import tty from "tty";
import readline from "readline";

// ---- config ----
const MAX_INPUT_LEN = 24;    // longest command that can be typed
const TTY_PATH = "/dev/tty"; // fallback when stdin was redirected (run.sh, nohup)
// ----------------

function openInputStream() {
  if (process.stdin.isTTY) return { stream: process.stdin, owned: false };
  try {
    const fd = fs.openSync(TTY_PATH, "r");
    return { stream: new tty.ReadStream(fd), owned: true };
  } catch {
    return null;
  }
}

export function startInput({ dashboard, onCommand, onInterrupt }) {
  const input = openInputStream();
  if (!input) {
    dashboard.addLog("Input disabled (no terminal). Use ctrl+c or ./stop.sh", "warn");
    return () => {};
  }
  const { stream, owned } = input;
  readline.emitKeypressEvents(stream);
  stream.setRawMode(true);
  stream.resume();

  let buf = "";
  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === "c") return onInterrupt();
    if (key.name === "return" || key.name === "enter") {
      const cmd = buf.trim().toLowerCase();
      buf = "";
      dashboard.setInput(buf);
      if (cmd) onCommand(cmd);
      return;
    }
    if (key.name === "backspace") {
      buf = buf.slice(0, -1);
    } else if (str && str.length === 1 && str >= " " && buf.length < MAX_INPUT_LEN) {
      buf += str;
    } else {
      return;
    }
    dashboard.setInput(buf);
  };

  stream.on("keypress", onKey);
  return () => {
    stream.off("keypress", onKey);
    try { stream.setRawMode(false); } catch {}
    if (owned) {
      try { stream.destroy(); } catch {}
    } else {
      stream.pause();
    }
  };
}
