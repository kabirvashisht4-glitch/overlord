// Run: npm run tune
//
// Diagnoses "it isn't listening" — the failure mode where nothing happens and
// there is no error to read.
//
// Between you speaking and the agent acting there are four gates. Any one of
// them failing looks identical from the outside: silence. This walks them in
// order and prints what each one actually saw, so the invisible failure
// becomes a visible one.
//
//   1. sox can open the microphone        -> permission / install
//   2. sound is arriving above the VAD floor -> gain / threshold
//   3. whisper turns that sound into text  -> model / language
//   4. the wake matcher accepts the text   -> threshold / wake word
//
// The general lesson: when a pipeline can fail silently, build the tool that
// makes each stage report what it saw. Guessing which of four things broke is
// the slowest possible way to debug.

import { spawn } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { run } from "../src/sh.js";
import { transcribe } from "../src/transcriber.js";
import { detectWakeWord, similarity } from "../src/wakeword.js";

const ok  = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); if (fix) console.log(`      ${fix}`); };
const dim = (m) => console.log(`      \x1b[2m${m}\x1b[0m`);

console.log("\n\x1b[1mOVERLORD TUNE\x1b[0m — find out which stage is silent\n");

// ---------------------------------------------------------------- GATE 1 ---
console.log("\x1b[1m1. microphone\x1b[0m");
const soxPath = await run("which", ["rec"]);
if (!soxPath.ok) {
  bad("sox is not installed", "brew install sox");
  process.exit(1);
}
ok(`sox found (${soxPath.out})`);

// ---------------------------------------------------------------- GATE 2 ---
console.log("\n\x1b[1m2. is sound actually arriving?\x1b[0m");
console.log("   \x1b[33mTalk normally for 5 seconds — say 'Overlord, open Spotify'.\x1b[0m\n");

const raw = join(tmpdir(), `tune-${Date.now()}.wav`);
await new Promise((r) => {
  const p = spawn("rec", ["-q", "-r", "16000", "-c", "1", "-b", "16", raw, "trim", "0", "5"]);
  let left = 5;
  const tick = setInterval(() => {
    process.stdout.write(`\r   \x1b[31m●\x1b[0m recording… ${left--}s  `);
  }, 1000);
  process.stdout.write(`\r   \x1b[31m●\x1b[0m recording… 5s  `);
  p.on("close", () => { clearInterval(tick); process.stdout.write("\r" + " ".repeat(40) + "\r"); r(); });
  p.on("error", () => { clearInterval(tick); r(); });
});

if (!existsSync(raw) || statSync(raw).size < 1000) {
  bad("no audio file was produced — sox could not read the microphone",
      "macOS: System Settings → Privacy & Security → Microphone → enable your terminal");
  process.exit(1);
}

// `sox --i` / `stat` reports peak amplitude as 0..1. That is the same scale
// the VAD threshold uses, just expressed as a percentage — which is what
// makes this measurement directly actionable rather than merely interesting.
const stat = await run("sox", [raw, "-n", "stat"]);
const text = `${stat.out}\n${stat.error || ""}`;
const grab = (label) => {
  const m = text.match(new RegExp(label + "[^0-9-]*(-?[0-9.]+)"));
  return m ? parseFloat(m[1]) : null;
};
const peak = grab("Maximum amplitude");
const rms  = grab("RMS +amplitude");

if (peak === null) {
  bad("could not measure the recording", "is `sox` fully installed?");
} else {
  const peakPct = (peak * 100).toFixed(1);
  const rmsPct  = ((rms ?? 0) * 100).toFixed(1);
  const bar = "█".repeat(Math.min(40, Math.round(peak * 40)));
  console.log(`   peak level  ${String(peakPct).padStart(5)}%  ${bar}`);
  console.log(`   average     ${String(rmsPct).padStart(5)}%`);
  console.log("");

  if (peak < 0.01) {
    bad(`peak ${peakPct}% — the microphone is recording pure silence`,
        "This is almost always a permission problem, not a code problem.\n" +
        "      macOS: System Settings → Privacy & Security → Microphone → enable your terminal,\n" +
        "      then FULLY QUIT the terminal (Cmd+Q) and reopen it. Toggling is not enough.\n" +
        "      Also check: System Settings → Sound → Input, and that the right mic is selected.");
    process.exit(1);
  }
  ok(`microphone is picking up sound (peak ${peakPct}%)`);

  // Recommend a floor that sits between the room and the voice.
  const suggested = Math.max(1, Math.min(15, Math.round(peak * 100 * 0.12)));
  const current = Number(config.vadThreshold);
  if (peak * 100 < current * 1.5) {
    bad(`VAD_THRESHOLD is ${current}% but your voice only peaks at ${peakPct}%`,
        `Your speech never crosses the floor, so recording never starts.\n` +
        `      Set VAD_THRESHOLD=${suggested} in .env`);
  } else {
    ok(`VAD_THRESHOLD=${current}% is below your voice — recording will trigger`);
    dim(`(${suggested} would also work; lower = more sensitive)`);
  }
}

// ---------------------------------------------------------------- GATE 3 ---
console.log("\n\x1b[1m3. what did whisper hear?\x1b[0m");
let heard = "";
try {
  heard = await transcribe(raw, { mode: config.whisperMode });
  if (!heard) {
    bad("whisper returned an empty string",
        "Sound arrived but produced no words. Try speaking louder/closer,\n" +
        "      or switch to the bigger model (ggml-small.en.bin).");
  } else {
    ok(`transcript: \x1b[1m"${heard}"\x1b[0m`);
    dim(`mode: ${config.whisperMode}`);
  }
} catch (err) {
  bad("transcription failed", err.message.split("\n").join("\n      "));
} finally {
  try { unlinkSync(raw); } catch {}
}

// ---------------------------------------------------------------- GATE 4 ---
if (heard) {
  console.log("\n\x1b[1m4. did the wake matcher accept it?\x1b[0m");
  const hit = detectWakeWord(heard, config.wakeWord, config.wakeThreshold);

  // Show the score for each of the first few words, so a near-miss is
  // visible as a number rather than as nothing happening.
  const words = heard.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  console.log(`   wake word: "${config.wakeWord}"   threshold: ${config.wakeThreshold}\n`);
  for (const w of words.slice(0, 4)) {
    const s = similarity(w, config.wakeWord.toLowerCase());
    const mark = s >= config.wakeThreshold ? "\x1b[32m✓\x1b[0m" : " ";
    console.log(`   ${mark} ${w.padEnd(16)} ${s.toFixed(2)} ${"█".repeat(Math.round(s * 24))}`);
  }
  console.log("");

  if (hit.matched) {
    ok(`MATCHED (score ${hit.score.toFixed(2)})`);
    console.log(`   command sent to the router: \x1b[1m"${hit.command}"\x1b[0m`);
    console.log("\n\x1b[32mEverything works. Run `npm start` and talk.\x1b[0m\n");
  } else {
    const best = Math.max(0, ...words.slice(0, 4).map((w) => similarity(w, config.wakeWord.toLowerCase())));
    bad(`no match — best score was ${best.toFixed(2)}, threshold is ${config.wakeThreshold}`,
        best > 0.5
          ? `Close. Lower it: WAKE_THRESHOLD=${(Math.floor(best * 20) / 20).toFixed(2)} in .env`
          : `Whisper heard something quite different from "${config.wakeWord}".\n` +
            `      Either say it more distinctly, or pick a wake word whisper\n` +
            `      transcribes reliably — try WAKE_WORD=computer or WAKE_WORD=jarvis.`);
    console.log("");
  }
}
