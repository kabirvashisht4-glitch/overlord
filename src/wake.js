// ---------------------------------------------------------------------------
// wake.js — the always-on ear.
//
// THE NAIVE VERSION (which you must not build):
//   every 2 seconds: record 2s of audio -> transcribe it -> check for the word
//
// That transcribes 30 clips a minute, 43,000 a day, and ~99.9% of them are
// silence or the hum of your fan. On the cloud API that's a real bill. Even
// locally it pins a CPU core permanently and your laptop gets hot and loud.
//
// THE FIX — VOICE ACTIVITY DETECTION (VAD):
// Put a CHEAP GATE in front of the EXPENSIVE STAGE. Measuring "is this audio
// louder than silence" costs approximately nothing. Transcription costs a
// lot. So never transcribe until the cheap check says a human made a noise.
//
// This is one of the most transferable ideas in all of engineering. It's the
// same shape as a database index before a full scan, a cache before an API
// call, a `.filter()` before a `.map()` that does heavy work. Whenever you
// have an expensive operation in a loop, the first question is always:
// "what cheap test goes in front of it?"
//
// And the best part — none of this implements VAD. `sox` has it built in:
//
//   silence 1 0.1 2%  1 1.2 2%
//           │ │   │   │ │   └── stop threshold
//           │ │   │   │ └────── stop after 1.2s below it
//           │ │   │   └──────── (start of the "stop" rule)
//           │ │   └──────────── start when audio exceeds 2% volume
//           │ └──────────────── ...sustained for 0.1s (ignores clicks/pops)
//           └────────────────── (start of the "record" rule)
//
// Translation: "wait silently until someone speaks, record until they stop
// speaking, then exit." One flag replaces an audio-processing library.
// Read your tools' man pages — the feature is often already in there.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Block until the user says SOMETHING, then return the path to a wav of just
 * that utterance. Resolves to null if the clip was too short to be speech.
 */
export function captureUtterance({ maxSeconds = 15 } = {}) {
  const file = join(tmpdir(), `ov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

  return new Promise((resolve, reject) => {
    const proc = spawn("rec", [
      "-q",
      "-r", "16000", "-c", "1", "-b", "16",
      file,
      // Hard ceiling. Without this, a TV left on in the room can hold the
      // recorder open indefinitely and the agent never gets a turn.
      // Every unbounded wait in a long-running program is a hang waiting
      // to happen — always give loops an exit.
      "trim", "0", String(maxSeconds),
      "silence",
      "1", "0.1", `${config.vadThreshold}%`,   // start on speech
      "1", `${config.vadSilence}`, `${config.vadThreshold}%`, // stop on silence
    ]);

    let spawnError = null;
    proc.on("error", (e) => { spawnError = e; });

    proc.on("close", () => {
      if (spawnError) {
        return reject(new Error("Couldn't start the microphone. Install sox:  brew install sox"));
      }
      if (!existsSync(file)) return resolve(null);

      // A wav header alone is ~44 bytes. Anything under ~8KB (~0.25s of
      // 16kHz mono 16-bit audio) is a door slam or a cough, not a sentence.
      // Discarding it here saves a pointless transcription call.
      const size = statSync(file).size;
      if (size < 8000) return resolve(null);

      resolve(file);
    });

    // Let the caller abort mid-recording — needed so we can stop listening
    // the instant the agent starts speaking (see the feedback-loop note in
    // index.js).
    captureUtterance.current = () => { try { proc.kill("SIGINT"); } catch {} };
  });
}
