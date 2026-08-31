// ---------------------------------------------------------------------------
// config.js — reads .env with ZERO npm packages.
//
// WHY NO `dotenv`?
// Every dependency is a thing that can break, go stale, or need installing.
// A .env file is just `KEY=value` lines. Parsing it is 10 lines. For a v1,
// owning those 10 lines is cheaper than owning a dependency.
// This is a real engineering trade-off, not laziness — you will make this
// call constantly. Rule of thumb: if the library is smaller than the code
// you'd write to understand it, write it yourself.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;      // skip blanks + comments
    const eq = line.indexOf("=");
    if (eq === -1) continue;                           // malformed, skip
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_PATH);

// Real environment variables WIN over the .env file. That ordering matters:
// it lets you do `ANTHROPIC_API_KEY=xxx npm start` to override for one run
// without editing files. Every serious config system works this way.
const get = (key, fallback = "") =>
  process.env[key] ?? fileEnv[key] ?? fallback;

export const config = {
  root: ROOT,
  anthropicKey: get("ANTHROPIC_API_KEY"),
  openaiKey: get("OPENAI_API_KEY"),
  geminiKey: get("GEMINI_API_KEY"),
  routerModel: get("ROUTER_MODEL", "claude-haiku-4-5-20251001"),
  speak: get("SPEAK", "true") === "true",
  platform: process.platform, // 'darwin' = macOS, 'win32', 'linux'

  // --- wake word mode ------------------------------------------------------
  wakeWord: get("WAKE_WORD", "overlord"),

  // Extra spellings to accept, comma-separated. Speech-to-text models
  // sometimes render an unusual name as a completely different word rather
  // than a near-miss, and no threshold fixes that — you have to name the
  // variants. `npm run tune` prints the exact line to add when it sees one.
  wakeAliases: get("WAKE_ALIASES", "over lord,overload,oberlord,overlard")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // How close a mishearing has to be, 0..1. See wakeword.js for why 0.72.
  wakeThreshold: Number(get("WAKE_THRESHOLD", "0.72")),

  // 'local' = whisper.cpp on your machine. 'cloud' = OpenAI's API.
  // Deliberately defaults to local: always-on listening means this decides
  // whether your room is continuously uploaded to someone else's server.
  whisperMode: get("WHISPER_MODE", "local"),
  whisperModel: get("WHISPER_MODEL", `${process.env.HOME}/.overlord-whisper.bin`),

  // Voice activity detection. Raise the threshold in a noisy room.
  vadThreshold: get("VAD_THRESHOLD", "2"),   // % volume that counts as speech
  vadSilence: get("VAD_SILENCE", "1.2"),     // seconds of quiet = you finished

  // After answering, keep listening this long WITHOUT needing the wake word
  // again, so you can say "...and turn it up" naturally. 0 disables it.
  followUpSeconds: Number(get("FOLLOW_UP_SECONDS", "8")),
};

// The full set the matcher tests against: the primary word first (it is the
// one shown in messages), then every accepted alias.
config.wakeWordList = [config.wakeWord, ...config.wakeAliases];

export const isMac = config.platform === "darwin";
