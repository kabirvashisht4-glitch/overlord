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
import { route, mockRoute } from "./router.js";
import { startRecording, transcribe, speak } from "./listen.js";
import { config } from "./config.js";

const args = new Set(process.argv.slice(2));
const TEXT_MODE = args.has("--text");
const DRY = args.has("--dry");
const VERBOSE = args.has("-v") || args.has("--verbose");

// --- the core: one full turn ------------------------------------------------

async function runOnce(transcript, registry) {
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
  speak(result);
}

// --- input modes ------------------------------------------------------------

async function textLoop(registry) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Type a command (or 'exit').\n");

  const ask = () =>
    rl.question("\u{1F5E3}  ", async (line) => {
      if (["exit", "quit", "q"].includes(line.trim().toLowerCase())) {
        rl.close();
        return;
      }
      await runOnce(line, registry);
      ask(); // recurse for the next prompt
    });

  ask();
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

// --- boot -------------------------------------------------------------------

async function main() {
  console.log("\n  ▚ OVERLORD  — local voice agent\n");

  const registry = await loadActions({ verbose: VERBOSE });
  console.log(`  ${registry.size} actions: ${[...registry.keys()].join(", ")}`);

  if (DRY) console.log("  mode: DRY (mock brain, no API calls)");
  else if (!config.anthropicKey) {
    console.log("\n  ⚠  No ANTHROPIC_API_KEY found.");
    console.log("     Add it to .env, or try:  npm run dry\n");
    process.exit(1);
  }
  console.log("");

  if (TEXT_MODE || DRY) await textLoop(registry);
  else await voiceLoop(registry);
}

main().catch((err) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
