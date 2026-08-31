// Run: npm run wake:test
// Tests the wake word matcher against REAL speech-to-text error patterns.
// No microphone, no API key, no network. Runs in ~20ms.
//
// Why bother testing this? Because wake detection is the one piece you
// CANNOT debug by using the app. If it doesn't trigger you get silence —
// no error, no log, nothing to read. Silence is the worst possible bug
// report. So you test it where you can actually see what happened.

import { detectWakeWord, similarity } from "../src/wakeword.js";

const WAKE = "overlord";
let pass = 0, fail = 0;

function check(label, transcript, shouldMatch, expectedCommand = null) {
  const r = detectWakeWord(transcript, WAKE);
  const ok =
    r.matched === shouldMatch &&
    (expectedCommand === null || r.command === expectedCommand);

  if (ok) { pass++; console.log(`  ✓ ${label.padEnd(34)} "${transcript}"`); }
  else {
    fail++;
    console.log(`  ✗ ${label.padEnd(34)} "${transcript}"`);
    console.log(`      expected match=${shouldMatch} cmd="${expectedCommand}"`);
    console.log(`      got      match=${r.matched} cmd="${r.command}" score=${r.score.toFixed(2)}`);
  }
}

console.log("\nSHOULD TRIGGER — real Whisper mishearings of 'Overlord'\n");
check("exact",              "overlord open spotify",       true,  "open spotify");
check("capitalised + comma","Overlord, open Spotify",      true,  "open spotify");
check("split into 2 words", "Over lord, open Spotify",     true,  "open spotify");
check("heard a real word",  "Overload open spotify",       true,  "open spotify");
check("b/v confusion",      "Oberlord open spotify",       true,  "open spotify");
check("trailing period",    "over Lord. Open Spotify.",    true,  "open spotify");
check("dropped letter",     "overlord open spotify",       true,  "open spotify");
check("filler word first",  "um overlord play some lofi",  true,  "play some lofi");
check("hey prefix",         "hey overlord what time is it",true,  "what time is it");
check("wake word alone",    "Overlord?",                   true,  "");

console.log("\nSHOULD NOT TRIGGER — false positives that would be infuriating\n");
check("mid-sentence use",   "i was reading about the overlord manga", false);
check("unrelated speech",   "can you pass me the water",             false);
check("random noise words", "yeah so anyway i think",                false);
check("different name",     "alexa turn off the lights",             false);
check("empty",              "",                                       false);
check("similar-ish word",   "overall open spotify",                  false);

console.log("\nSIMILARITY SCORES (why the 0.72 threshold sits where it does)\n");
for (const w of ["overlord","overload","over lord","oberlord","overall","spotify","alexa"]) {
  const s = similarity(w.replace(/\s/g, " "), "overlord");
  const bar = "█".repeat(Math.round(s * 30));
  console.log(`  ${w.padEnd(11)} ${s.toFixed(2)} ${bar}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
