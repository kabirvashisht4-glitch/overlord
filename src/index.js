#!/usr/bin/env node
// ---------------------------------------------------------------------------
// index.js — the loop that ties the four layers together.
//
//   EARS   listen.js    microphone -> text
//   BRAIN  router.js    text -> { name, input }
//   HANDS  actions/     { name, input } -> something happens
//   MOUTH  speak()      result -> spoken out loud
//
// Read the runOnce() function below and you have read the entire program.
// Everything else is detail. If you can't describe your app in one short
// function like that, the architecture is probably wrong.
//
// MODES:
//   node src/index.js            voice mode  (needs sox + OPENAI_API_KEY)
//   node src/index.js --text     type instead of speaking (needs ANTHROPIC key)
//   node src/index.js --text --dry   no API keys, no internet — mock brain
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline";
import { loadActions } from "./actions/index.js";
import { route, mockRoute, brainInfo } from "./router.js";
import { startRecording, speak, speakAndWait } from "./listen.js";
import { transcribe } from "./transcriber.js";
import { captureUtterance } from "./wake.js";
import { detectWakeWord } from "./wakeword.js";
import { config } from "./config.js";

const args = new Set(process.argv.slice(2));
const TEXT_MODE = args.has("--text");
const DRY = args.has("--dry");
const WAKE_MODE = args.has("--wake");
const VERBOSE = args.has("-v") || args.has("--verbose");

// --- the core: one full turn ------------------------------------------------

async function runOnce(transcript, registry, { silent = false } = {}) {
  if (!transcript.trim()) return "";

  // 1. BRAIN — decide what to do.
  const decision = DRY ? await mockRoute(transcript) : await route(transcript, registry);
  if (VERBOSE) console.log(`   ↳ ${decision.name}(${JSON.stringify(decision.input)})`);

  // 2. HANDS — look it up and run it.
  const action = registry.get(decision.name);
  if (!action) {
    // Defensive: the model can hallucinate a tool name that doesn't exist.
    // Rare, but "rare" over thousands of runs means "happens".
    console.log(`⚠  Unknown action "${decision.name}"`);
    return "";
  }

  let result;
  try {
    result = await action.run(decision.input);
  } catch (err) {
    // ONE try/catch around ALL actions, instead of one inside each action.
    // Individual actions get to be simple and optimistic; the loop is the
    // single place that guarantees a crash never kills the process.
    result = `That failed: ${err.message}`;
  }

  // 3. MOUTH — report back.
  console.log(`🤖 ${result}`);
  if (!silent) speak(result);   // wake mode speaks itself, so it can wait
  return result;
}

// --- input modes ------------------------------------------------------------

async function textLoop(registry) {
  // THREE THINGS THIS GUARDS AGAINST, all found on a real machine:
  //
  // 1. The prompt used the 🗣 emoji (U+1F5E3). That codepoint is text-default
  //    without a variation selector, and some terminal fonts render it as
  //    NOTHING — so the prompt was invisible and the app looked dead. Never
  //    put a decorative glyph where a functional cue belongs; ASCII here.
  //
  // 2. Some launchers hand the child process a stdin that is not a terminal
  //    and is already at EOF. The async iterator then finishes instantly and
  //    the program exits without a word, which looks identical to a crash.
  //    Detected and explained below rather than exiting silently.
  //
  // 3. rl.prompt() instead of a manual stdout.write, so readline owns the
  //    cursor and redraws correctly after output.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });
  console.log("Type a command (or 'exit').\n");
  if (!process.stdin.isTTY) {
    console.log("note: stdin is not a terminal — reading piped input.\n");
  }

  // NOTE (a real bug this code hit during development):
  // The obvious version is a recursive `rl.question(prompt, cb)`. It works
  // when you type by hand, but silently DROPS lines when input is piped in
  // (`echo "..." | node src/index.js`) — readline buffers all the lines at
  // once and the recursion only re-registers a listener after the first
  // callback, so everything after line 1 vanishes.
  //
  // `for await (const line of rl)` treats stdin as an async iterator, which
  // processes lines one at a time and respects back-pressure in both cases.
  // Lesson: async callbacks + recursion is where subtle input bugs live.
  // If you can express something as a loop over an async iterator, do that.
  let handled = 0;
  rl.prompt();
  for await (const line of rl) {
    if (["exit", "quit", "q"].includes(line.trim().toLowerCase())) break;
    if (line.trim()) {
      handled++;
      await runOnce(line, registry);
    }
    rl.prompt();
  }
  rl.close();

  // If the loop ended without ever seeing a line, stdin was closed before we
  // got it. Say so. An unexplained instant exit is the least debuggable
  // outcome a program can produce — always spend three lines explaining it.
  if (handled === 0) {
    console.log("\n\x1b[33mNo input was received — stdin closed immediately.\x1b[0m");
    console.log("If you expected to type commands, run it directly instead of via npm:");
    console.log("  node src/index.js --text --dry\n");
  }
}

async function voiceLoop(registry) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Press ENTER to start talking. Press ENTER again to send. Ctrl+C to quit.\n");

  const cycle = () =>
    rl.question("[enter to record] ", async () => {
      let rec;
      try {
        rec = startRecording();
      } catch (err) {
        console.log(`⚠  ${err.message}`);
        return cycle();
      }

      rl.question("🔴 recording… [enter to stop] ", async () => {
        try {
          const wav = await rec.stop();
          process.stdout.write("… transcribing\n");
          const text = await transcribe(wav);
          console.log(`🗣  ${text}`);
          await runOnce(text, registry);
        } catch (err) {
          console.log(`⚠  ${err.message}`);
        }
        cycle();
      });
    });

  cycle();
}

// --- wake word mode ---------------------------------------------------------
//
// CONCEPT: MODEL IT AS A STATE MACHINE.
//
// The moment a program is always-on and reacts to the outside world, "just
// write the steps in order" stops working. You need to name the states it
// can be in and the events that move between them. Write the diagram down
// FIRST — most bugs in this kind of program are states you forgot existed.
//
//   ┌──────────────────────────────────────────────────────────┐
//   │                                                          │
//   ▼                heard wake word                           │
// SLEEPING ──────────────────────────────▶ AWAKE ──▶ THINKING ─┤
//   ▲  │  heard something else                          │      │
//   │  └──(discard, don't even log it)                  ▼      │
//   │                                                SPEAKING  │
//   │                    follow-up window expires        │     │
//   └────────────────────────────────────────────────────┘◀────┘
//                                    (stay AWAKE if within follow-up window)
//
// Two subtle states that are easy to forget, and both bite here:
//   1. SPEAKING — while the mouth is on, the ear MUST be off, or it hears
//      itself and loops forever.
//   2. The follow-up window — being briefly awake after a reply is what
//      makes it feel like a conversation instead of a vending machine.

async function wakeLoop(registry) {
  const wake = config.wakeWord;

  // KEEP THE MACHINE AWAKE (opt-in).
  //
  // `caffeinate` is macOS's own tool for this; -d -i -s hold off display,
  // idle and system sleep. Spawning it as a CHILD is the important part:
  // when Overlord exits for any reason — crash included — the child dies
  // with it and the Mac sleeps normally again.
  //
  // A program that changes a system-wide setting must tie the undo to its
  // own lifetime, not to remembering to clean up. Otherwise a crash leaves
  // the laptop unable to sleep and nobody knows why.
  let caffeine = null;
  if (config.keepAwake && config.platform === "darwin") {
    const { spawn } = await import("node:child_process");
    caffeine = spawn("caffeinate", ["-d", "-i", "-s"], { stdio: "ignore" });
    caffeine.on("error", () => {});
    process.on("exit", () => { try { caffeine.kill(); } catch {} });
    console.log("  keep-awake: on (needs mains power for a closed lid)");
  }

  console.log(`Listening for "${wake}". Ctrl+C to stop.`);
  console.log(`  transcription: ${config.whisperMode === "local" ? "local (private)" : "OpenAI API (audio leaves your machine)"}`);
  if (config.followUpSeconds > 0) {
    console.log(`  follow-up: ${config.followUpSeconds}s after each reply, no wake word needed`);
  }
  console.log("");

  let awakeUntil = 0; // timestamp; while now < this, skip the wake word check

  while (true) {
    let wav;
    try {
      // BLOCKS here — costs nothing — until an actual human noise happens.
      wav = await captureUtterance();
    } catch (err) {
      console.log(`⚠  ${err.message}`);
      return;
    }
    if (!wav) continue; // too short: a cough, a door, a keyboard clack

    let text;
    try {
      text = await transcribe(wav);
    } catch (err) {
      console.log(`⚠  ${err.message}`);
      // Back off before retrying. Without this, a misconfigured whisper
      // spins this loop at full speed and floods your terminal with the
      // same error thousands of times a second. Any error inside a
      // `while(true)` needs a brake.
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!text) continue;

    const inFollowUp = Date.now() < awakeUntil;
    let command = null;

    if (inFollowUp) {
      // Already awake — take the whole sentence as the command. But strip a
      // repeated wake word, because people naturally say it again anyway.
      const hit = detectWakeWord(text, config.wakeWordList, config.wakeThreshold);
      command = hit.matched ? hit.command : text;
    } else {
      const hit = detectWakeWord(text, config.wakeWordList, config.wakeThreshold);
      if (!hit.matched) {
        // FEEDBACK WITHOUT SURVEILLANCE.
        //
        // First version printed nothing here unless debugging. That was a
        // mistake: "heard you, wasn't the wake word" then looks exactly like
        // "crashed" or "mic is dead" — the user has no way to tell a working
        // agent from a broken one, and silence is the worst bug report there
        // is.
        //
        // But printing the transcript would turn the terminal into a running
        // record of every private conversation in the room, and a permanent
        // one if logs are ever redirected to a file.
        //
        // So: a dot. It proves the pipeline is alive and heard speech, and
        // reveals nothing about what was said. The score goes with it because
        // a run of 0.6x dots says "lower your threshold" at a glance.
        // When a design pulls between usefulness and privacy, look for the
        // signal that carries only what's needed.
        process.stdout.write(
          VERBOSE ? `   (ignored: "${text}")\n` : `\x1b[2m·${hit.score ? hit.score.toFixed(2) : ""}\x1b[0m `,
        );
        continue;
      }
      process.stdout.write("\n");
      command = hit.command;
      if (VERBOSE) console.log(`   [wake ${hit.score.toFixed(2)}]`);
    }

    // "Overlord" with nothing after it — acknowledge and open the window,
    // exactly like a real assistant chiming and waiting.
    if (!command.trim()) {
      console.log(`🗣  (${wake})`);
      await speakAndWait("Yes?");
      awakeUntil = Date.now() + config.followUpSeconds * 1000;
      continue;
    }

    console.log(`🗣  ${command}`);

    // silent:true — runOnce must NOT speak, because we need to await the
    // speech ourselves before re-opening the mic.
    const reply = await runOnce(command, registry, { silent: true });

    // SPEAKING state: ear off, mouth on. Then reopen the follow-up window
    // from the moment speech ENDS, not from when it started — otherwise a
    // long answer eats the user's entire chance to reply.
    if (reply) await speakAndWait(reply);
    awakeUntil = Date.now() + config.followUpSeconds * 1000;
  }
}

// --- boot -------------------------------------------------------------------

async function main() {
  console.log("\n  ▚ OVERLORD  — local voice agent\n");

  const registry = await loadActions({ verbose: VERBOSE });
  console.log(`  ${registry.size} actions: ${[...registry.keys()].join(", ")}`);

  // VALIDATE THE VOICE AT STARTUP, NOT AT SPEAK TIME.
  //
  // `say -v NotAVoice "hi"` fails with no sound and no useful error. In an
  // app whose whole output is audio, that is indistinguishable from every
  // other silent failure. Check once, up front, and say exactly how to fix
  // it. Any setting that fails silently deserves a startup check.
  if (config.platform === "darwin" && config.voice) {
    const { run } = await import("./sh.js");
    const list = await run("say", ["-v", "?"]);
    const have = `${list.out}\n${list.err || ""}`;
    if (have && !have.includes(config.voice)) {
      console.log(`\n  ⚠  Voice "${config.voice}" is not installed — replies would be silent.`);
      console.log(`     See installed voices:  npm run voices`);
      console.log(`     Install Daniel: System Settings → Accessibility → Spoken Content`);
      console.log(`     → System Voice → Manage Voices → English (UK) → Daniel`);
      console.log(`     Or set VOICE=Alex in .env to use a default one.\n`);
    } else if (have) {
      console.log(`  voice: ${config.voice} @ ${config.voiceRate} wpm   persona: ${config.persona}`);
    }
  }

  if (DRY) console.log("  mode: DRY (mock brain, no API calls)");
  else {
    const b = brainInfo();
    console.log(`  brain: ${b.label}`);
  }

  console.log("");

  // Order matters: --wake wins over --dry, so `--wake --dry` exercises the
  // real microphone and real transcription against the mock brain. That
  // combination is the single most useful diagnostic in the project — it
  // proves the entire voice path works before an API key is involved.
  // Let every expensive dependency be independently switchable off.
  if (WAKE_MODE) await wakeLoop(registry);
  else if (TEXT_MODE || DRY) await textLoop(registry);
  else await voiceLoop(registry);
}

main().catch((err) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
