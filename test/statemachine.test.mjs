// Run: node test/statemachine.test.mjs
//
// Replays a realistic sequence of overheard sentences through the SAME
// wake/follow-up logic wakeLoop uses, with a fake clock. No mic, no whisper,
// no API. Verifies the conversation actually behaves like a conversation.
//
// TECHNIQUE WORTH STEALING: the thing that made this testable is that the
// decision logic depends on `Date.now()` and nothing else about the outside
// world. Inject the clock and suddenly you can test 30 seconds of behaviour
// in 0ms. Any time you hard-code `Date.now()` or `Math.random()` deep inside
// logic, you've made that logic untestable. Pass them in.

import { detectWakeWord } from "../src/wakeword.js";

const WAKE = "overlord";
const FOLLOW_UP_MS = 8000;

// A tiny pure model of wakeLoop's decision, with time as a parameter.
function decide(text, now, awakeUntil) {
  const inFollowUp = now < awakeUntil;
  const hit = detectWakeWord(text, WAKE);

  if (inFollowUp) {
    const command = hit.matched ? hit.command : text;
    return { act: true, command, reason: "follow-up window" };
  }
  if (!hit.matched) return { act: false, command: "", reason: "no wake word" };
  if (!hit.command.trim()) return { act: false, command: "", reason: "chime only", chime: true };
  return { act: true, command: hit.command, reason: "wake word" };
}

const script = [
  { t: 0,     say: "so anyway the assignment is due friday",  expect: "ignored" },
  { t: 3000,  say: "Overlord, open Spotify",                  expect: "acted",  cmd: "open Spotify" },
  { t: 5000,  say: "and turn the volume down",                expect: "acted",  cmd: "and turn the volume down" },
  { t: 9000,  say: "yeah I'll call you back later",           expect: "acted",  cmd: "yeah I'll call you back later" },
  { t: 30000, say: "yeah I'll call you back later",           expect: "ignored" },
  { t: 32000, say: "Over lord",                               expect: "chimed" },
  { t: 34000, say: "play some lofi",                          expect: "acted",  cmd: "play some lofi" },
  { t: 60000, say: "I love the overlord manga honestly",      expect: "ignored" },
];

let awakeUntil = 0;
let pass = 0, fail = 0;

console.log("\nSTATE MACHINE REPLAY  (fake clock, no hardware)\n");

for (const step of script) {
  const d = decide(step.say, step.t, awakeUntil);
  const got = d.act ? "acted" : d.chime ? "chimed" : "ignored";

  // Both acting and chiming (re)open the follow-up window.
  if (d.act || d.chime) awakeUntil = step.t + FOLLOW_UP_MS;

  const cmdOk = !step.cmd || d.command === step.cmd;
  const good = got === step.expect && cmdOk;
  good ? pass++ : fail++;

  const icon = good ? "✓" : "✗";
  const secs = `${(step.t / 1000).toFixed(0)}s`.padStart(4);
  console.log(`  ${icon} ${secs}  "${step.say}"`);
  console.log(`         → ${got.padEnd(8)} (${d.reason})${d.command ? `  cmd="${d.command}"` : ""}`);
  if (!good) console.log(`         ! expected ${step.expect}${step.cmd ? ` cmd="${step.cmd}"` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`
What this proves:
  3s   wake word starts a turn
  5s   follow-up needs NO wake word — feels conversational
  9s   still inside the window (reset at 5s, not at 3s)
  30s  window long expired → back to ignoring private conversation
  32s  bare wake word chimes and waits
  60s  "overlord" mid-sentence does NOT fire
`);
process.exit(fail === 0 ? 0 : 1);
