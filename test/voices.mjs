// Run: npm run voices
//
// Auditions the British male voices on this Mac so you can pick by EAR
// rather than by guessing from a name in a list.
//
// Why a chooser instead of a hard-coded name: voice quality varies enormously
// between the default "Compact" voices macOS ships and the "Enhanced" /
// "Premium" ones you download. Same voice name, completely different result.
// The setting that matters most here isn't in the code at all — it's which
// data you have installed. So the tool's job is to make that audible.

import { spawn } from "node:child_process";
import { run } from "../src/sh.js";
import { config } from "../src/config.js";

const SAMPLE = "Spotify is open, sir. Shall I lower the volume?";

// Voices with the right register: British, male, measured.
const WANTED = ["Daniel", "Oliver", "Arthur", "Malcolm", "Jamie", "Serena", "Kate", "Stephen"];

const say = (voice, rate) =>
  new Promise((r) => {
    const p = spawn("say", ["-v", voice, "-r", String(rate), SAMPLE], { stdio: "ignore" });
    p.on("close", r);
    p.on("error", r);
  });

const list = await run("say", ["-v", "?"]);
const raw = `${list.out}\n${list.err || ""}`;
if (!raw.trim()) {
  console.log("\nCouldn't list voices — is this macOS?\n");
  process.exit(1);
}

const installed = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => ({ name: l.split(/\s{2,}|\s+[a-z]{2}_/)[0].trim(), line: l }));

const british = installed.filter((v) =>
  /en_GB/.test(v.line) || WANTED.includes(v.name),
);

console.log("\n\x1b[1mVOICE AUDITION\x1b[0m — British / measured voices on this Mac\n");

if (!british.length) {
  console.log("  None installed yet.\n");
} else {
  for (const v of british) {
    const isCurrent = v.name === config.voice;
    console.log(`  ${isCurrent ? "\x1b[32m▶\x1b[0m" : " "} ${v.name}${isCurrent ? "  \x1b[2m(current)\x1b[0m" : ""}`);
    await say(v.name, config.voiceRate);
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log(`
\x1b[1mTo use one:\x1b[0m  put  VOICE=<name>  in .env

\x1b[1mFor a MUCH better version of the same voice:\x1b[0m
  System Settings → Accessibility → Spoken Content → System Voice
  → Manage Voices… → English (UK) → download the \x1b[1mPremium\x1b[0m variant.

  The default voices are "Compact" — small files, robotic. Premium voices are
  several hundred MB of real recorded speech and sound close to a person.
  Same name in .env; the quality difference is the download, not the code.

\x1b[1mAlso try slowing it down:\x1b[0m  VOICE_RATE=150
  Pace does more for "composed" than the voice choice does.
`);
