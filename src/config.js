import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import { runSetupWizard, verifyDiscordToken } from "./wizard.js";

dotenv.config();

// ---- config ----
const VERIFY_TRIES = 3; // token checks are retried, a slow link makes single checks fail
// ----------------

async function verifyWithRetry(token) {
  for (let i = 0; i < VERIFY_TRIES; i++) {
    const user = await verifyDiscordToken(token);
    if (user) return user;
  }
  return null;
}

export async function loadConfig() {
  const envPath = path.resolve(process.cwd(), ".env");
  const hasEnvFile = fs.existsSync(envPath);
  const { STREAMER_TOKENS, GUILD_ID, CHANNEL_ID, FPS, BITRATE_KBPS } = process.env;

  const streamerTokens = [
    ...new Set(
      (STREAMER_TOKENS || "")
        .split(/[,;\n]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    ),
  ];
  const guildId = (GUILD_ID || "").trim();
  const channelId = (CHANNEL_ID || "").trim();

  const missing = [
    !hasEnvFile && ".env file",
    streamerTokens.length === 0 && "STREAMER_TOKENS",
    !guildId && "GUILD_ID",
    !channelId && "CHANNEL_ID",
  ].filter(Boolean);

  if (missing.length > 0) {
    if (process.env.NO_WIZARD === "1" || process.argv.includes("--no-wizard")) {
      console.error(chalk.red("Config incomplete, wizard disabled. Missing: " + missing.join(", ")));
      process.exit(2);
    }
    console.error(chalk.red("Config incomplete. Missing: " + missing.join(", ") + ". Run: bash setup.sh"));
    process.exit(2);
  }

  const spinner = ora("Validating accounts...").start();
  const streamerUsers = await Promise.all(streamerTokens.map((t) => verifyWithRetry(t)));

  const invalid = streamerUsers.map((u, i) => (u ? null : i + 1)).filter((i) => i !== null);
  if (invalid.length > 0) {
    spinner.fail(chalk.red(`Streamer token #${invalid.join(", #")} could not be verified (invalid, or the request failed).`));
    process.exit(1);
  }

  spinner.succeed(
    chalk.green(
      "Accounts:\n" +
        streamerUsers.map((u, i) => `  - Streamer [${i + 1}]: ${chalk.bold(u.username)} (${u.id})`).join("\n")
    )
  );

  return {
    STREAMER_TOKENS: streamerTokens.join(","),
    streamers: streamerTokens.map((token, i) => ({ token, user: streamerUsers[i] })),
    VIEWER_TOKEN: "",
    viewerUser: null,
    GUILD_ID: guildId,
    CHANNEL_ID: channelId,
    FPS: parseInt(FPS || "10", 10),
    BITRATE_KBPS: parseInt(BITRATE_KBPS || "150", 10),
  };
}
