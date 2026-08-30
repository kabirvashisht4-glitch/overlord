// ---------------------------------------------------------------------------
// listen.js — THE EARS. Microphone -> text.
//
// TWO CONCEPTS HERE.
//
// 1) PUSH-TO-TALK, NOT WAKE WORD.
//    "Hey Overlord" sounds cooler but needs an always-on model listening to
//    every sound in your room (Porcupine, openWakeWord), plus tuning to stop
//    it triggering on the TV. That's a whole project by itself. Push-to-talk
//    — press Enter, talk, press Enter — gives you 95% of the usefulness for
//    2% of the work. Add the wake word in v3 once the rest actually works.
//
//    Generalise: when a feature has a hard version and an easy version that
//    tests the same hypothesis, build the easy one first. You are trying to
//    find out if the IDEA works, not to prove you can build the hard part.
//
// 2) STREAMING vs BATCH.
//    Real-time streaming transcription (words appearing as you speak) needs
//    WebSockets and chunked audio. Batch — record the whole clip, send one
//    file, get one string — is a single HTTP request. For commands lasting
//    3 seconds, nobody can tell the difference. Batch wins.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Record from the default microphone until stop() is called.
 * Returns { stop } — call stop() to finish and get the wav file path.
 *
 * Uses `sox` (install: brew install sox). We shell out instead of using a
 * node audio library on purpose: native audio bindings are the #1 source of
 * "npm install exploded" pain on Macs. A CLI tool either exists or it
 * doesn't, and the error message is readable.
 */
export function startRecording() {
  const file = join(tmpdir(), `overlord-${Date.now()}.wav`);

  // -q quiet, -r 16000 = 16kHz (what Whisper wants; higher is wasted bytes)
  // -c 1 = mono, -b 16 = 16-bit
  const proc = spawn("rec", ["-q", "-r", "16000", "-c", "1", "-b", "16", file]);

  let failed = null;
  proc.on("error", (err) => { failed = err; });

  return {
    async stop() {
      proc.kill("SIGINT");
      // Give sox a beat to flush the file header. Without this you get a
      // 0-byte or truncated wav roughly one time in five — a genuinely
      // annoying intermittent bug, so we just wait 250ms.
      await new Promise((r) => setTimeout(r, 250));
      if (failed) {
        throw new Error(
          "Couldn't start recording. Is sox installed?  ->  brew install sox",
        );
      }
      return file;
    },
  };
}

/**
 * Send a wav file to Whisper and get the text back.
 *
 * Note: Node 18+ has fetch, FormData and Blob built in, so multipart upload
 * needs no library at all. Two years ago this was 40 lines and a dependency.
 */
export async function transcribe(wavPath) {
  if (!config.openaiKey) {
    throw new Error("OPENAI_API_KEY is not set — needed for speech-to-text.");
  }
  if (!existsSync(wavPath)) throw new Error("Recording file missing.");

  const bytes = readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${config.openaiKey}` },
      body: form, // don't set content-type — fetch adds the multipart boundary
    });
    if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.text || "").trim();
  } finally {
    // Always clean up the temp file, even if the request threw.
    // `finally` is the right tool for this and beginners rarely reach for it.
    try { unlinkSync(wavPath); } catch {}
  }
}

/**
 * Speak text out loud. macOS ships `say` — free TTS, no API, no latency.
 * Fire-and-forget so it doesn't block the next command.
 */
export function speak(text) {
  if (!config.speak || config.platform !== "darwin") return;
  const proc = spawn("say", [text.slice(0, 300)], { stdio: "ignore" });
  proc.on("error", () => {}); // never let TTS crash the agent
  proc.unref();
}


// ---------------------------------------------------------------------------
// GOING FULLY LOCAL (the private version — a good weekend upgrade):
//
//   brew install whisper-cpp
//   Then replace transcribe() with:
//
//     const r = await run("whisper-cli", ["-m", "ggml-base.en.bin",
//                                         "-f", wavPath, "--no-timestamps"]);
//     return r.out.trim();
//
//   Costs nothing per use, works on a plane, and your voice never leaves the
//   laptop. Slightly less accurate than the API. Same signature, so again:
//   nothing else in the codebase changes.
// ---------------------------------------------------------------------------
