// Run: npm run doctor
//
// Checks every external thing Overlord depends on and tells you EXACTLY how
// to fix whatever is missing.
//
// WHY WRITE THIS AT ALL?
// Because "it doesn't work" is the failure mode you'll actually hit, and in
// wake mode the symptom is *silence* — no error, no crash, nothing to read.
// A program that can explain its own broken environment saves you more time
// than almost any feature. Ship a doctor with anything that has more than
// two external dependencies; you will thank yourself at 2am.

import { run } from "../src/sh.js";
import { config } from "../src/config.js";
import { existsSync, statSync } from "node:fs";

const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, fix) => { console.log(`  ✗ ${m}`); console.log(`      fix: ${fix}`); bad++; };
const meh = (m, note) => console.log(`  · ${m}  (${note})`);
let bad = 0;

console.log("\nOVERLORD DOCTOR\n");
console.log(`platform: ${process.platform}   node: ${process.version}\n`);

if (process.platform !== "darwin") {
  console.log("  ! Not macOS — the device-control actions will no-op.");
  console.log("    Everything else (router, registry, wake matching) still runs.\n");
}

// --- microphone -------------------------------------------------------------
console.log("microphone");
const sox = await run("which", ["rec"]);
sox.ok ? ok(`sox found at ${sox.out}`)
       : no("sox not installed — cannot record audio", "brew install sox");

// --- speech to text ---------------------------------------------------------
console.log("\nspeech-to-text");
if (config.whisperMode === "local") {
  const w = await run("which", ["whisper-cli"]);
  w.ok ? ok(`whisper-cli found at ${w.out}`)
       : no("whisper-cli not installed", "brew install whisper-cpp");

  if (existsSync(config.whisperModel)) {
    const mb = (statSync(config.whisperModel).size / 1e6).toFixed(0);
    ok(`model present (${mb} MB) at ${config.whisperModel}`);
  } else {
    no(`model missing at ${config.whisperModel}`,
       `curl -L -o ${config.whisperModel} \\\n           https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`);
  }
  ok("mode: local — your audio never leaves this machine");
} else {
  config.openaiKey ? ok("OPENAI_API_KEY set")
                   : no("OPENAI_API_KEY missing", "add it to .env");
  console.log("  ! mode: cloud — in wake mode this uploads room audio continuously.");
  console.log("    Consider WHISPER_MODE=local in .env.");
}

// --- the brain --------------------------------------------------------------
console.log("\nrouter (brain)");
config.anthropicKey ? ok("ANTHROPIC_API_KEY set")
                    : no("ANTHROPIC_API_KEY missing", "add it to .env, or use `npm run dry`");
ok(`model: ${config.routerModel}`);

// --- optional ---------------------------------------------------------------
console.log("\noptional");
config.geminiKey ? ok("GEMINI_API_KEY set") : meh("GEMINI_API_KEY not set", "'ask gemini' will fail");
config.openaiKey ? ok("OPENAI_API_KEY set") : meh("OPENAI_API_KEY not set", "'ask chatgpt' will fail");

// --- wake config ------------------------------------------------------------
console.log("\nwake word");
ok(`word: "${config.wakeWord}"   threshold: ${config.wakeThreshold}`);
if (config.wakeWord.replace(/\s/g, "").length < 6) {
  console.log("  ! short wake word — expect false triggers. 3+ syllables is safer.");
}
ok(`VAD: starts above ${config.vadThreshold}% volume, stops after ${config.vadSilence}s quiet`);
ok(`follow-up window: ${config.followUpSeconds}s`);

// --- permissions ------------------------------------------------------------
if (process.platform === "darwin") {
  console.log("\nmacOS permissions (cannot be auto-checked — verify by hand)");
  console.log("  · Microphone:    System Settings → Privacy & Security → Microphone → your terminal");
  console.log("  · Accessibility: System Settings → Privacy & Security → Accessibility → your terminal");
  console.log("    (Accessibility is what lets volume / play-pause / lock work.)");
}

console.log(bad === 0
  ? "\nAll required checks passed. Run `npm start`.\n"
  : `\n${bad} problem(s) above. Fix those, then re-run \`npm run doctor\`.\n`);
