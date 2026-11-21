import fs from "fs";
import path from "path";
import { verifyDiscordToken } from "./wizard.js";

// ---- config ----
const ENV_PATH = path.resolve(process.cwd(), ".env");
const STREAMER_KEY = "STREAMER_TOKENS"; // slot of the token that streams
const SPARE_KEY = "SPARE_TOKEN";       // slot of the unused token
const VERIFY_TRIES = 3;
// ----------------

function getVal(lines, key) {
  const line = lines.find((l) => l.startsWith(key + "="));
  return line ? line.slice(key.length + 1).trim() : "";
}

export async function prepareSwap() {
  let lines;
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {
    return { error: ".env could not be read" };
  }
  const streamer = getVal(lines, STREAMER_KEY);
  const spare = getVal(lines, SPARE_KEY);
  if (!streamer) return { error: STREAMER_KEY + " is empty in .env" };
  if (!spare) return { error: "No spare token set. Add " + SPARE_KEY + "=<token> to .env, then swap again." };
  if (/[,;]/.test(streamer)) return { error: "swap needs exactly one streamer token" };
  if (streamer === spare) return { error: "both slots hold the same token" };

  let user = null;
  for (let i = 0; i < VERIFY_TRIES && !user; i++) user = await verifyDiscordToken(spare);
  if (!user) return { error: "the spare token failed verification, nothing changed" };

  return {
    username: user.username,
    write() {
      const out = lines.map((l) => {
        if (l.startsWith(STREAMER_KEY + "=")) return STREAMER_KEY + "=" + spare;
        if (l.startsWith(SPARE_KEY + "=")) return SPARE_KEY + "=" + streamer;
        return l;
      });
      const tmp = ENV_PATH + ".tmp";
      fs.writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
      fs.renameSync(tmp, ENV_PATH);
    },
  };
}

export async function getSpareName() {
  let lines;
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {
    return "none";
  }
  const spare = getVal(lines, SPARE_KEY);
  if (!spare) return "none set";
  let user = null;
  for (let i = 0; i < VERIFY_TRIES && !user; i++) user = await verifyDiscordToken(spare);
  return user ? user.username : "unverified";
}
