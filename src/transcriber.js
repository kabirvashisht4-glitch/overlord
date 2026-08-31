// ---------------------------------------------------------------------------
// transcriber.js — audio file -> text. Two backends, one interface.
//
// THIS IS AN ETHICS DECISION DISGUISED AS A TECHNICAL ONE.
//
// Push-to-talk mode sends audio only when you press a key. You consented,
// once per command. Fine.
//
// Wake-word mode listens FOREVER. If you keep the cloud transcriber, you are
// now uploading every sound in your bedroom to a company's servers, 24/7,
// forever, so that a computer can notice you said one word. Your flatmates
// never agreed to that. Your family never agreed to that. That is genuinely
// how the real smart-speaker privacy scandals happened.
//
// So: when you turn on always-listening, the DEFAULT flips to local.
// The audio is transcribed on your own laptop and never leaves it.
//
// The lesson worth keeping: a change in HOW something is triggered can
// completely change what it means to run it. "Always on" is not "the same
// feature but more convenient" — it's a different product with different
// obligations. Notice when a convenience change is secretly a consent change.
// ---------------------------------------------------------------------------

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { run } from "./sh.js";
import { config } from "./config.js";

/** Local: whisper.cpp. Free, offline, private. `brew install whisper-cpp` */
async function transcribeLocal(wavPath) {
  const res = await run("whisper-cli", [
    "-m", config.whisperModel,
    "-f", wavPath,
    "--no-timestamps",
    "--no-prints",
    "-l", "en",
  ]);

  if (!res.ok) {
    // A precise, actionable error beats a stack trace every time. The user
    // (you, in three weeks, having forgotten all this) should be able to fix
    // it from the message alone without opening the source.
    throw new Error(
      `whisper-cli failed. Install it with:  brew install whisper-cpp\n` +
      `      Then download a model:\n` +
      `        curl -L -o ~/.overlord-whisper.bin \\\n` +
      `          https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin\n` +
      `      Currently looking for the model at: ${config.whisperModel}\n` +
      `      (${res.error})`,
    );
  }
  return res.out.trim();
}

/** Cloud: OpenAI Whisper API. More accurate, costs money, sends your audio away. */
async function transcribeCloud(wavPath) {
  if (!config.openaiKey) throw new Error("OPENAI_API_KEY is not set.");

  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "a.wav");
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text()}`);
  return ((await res.json()).text || "").trim();
}

/**
 * The public interface. Everything else in the codebase calls only this and
 * has no idea which backend ran — same trick as the LLM providers in
 * askLLM.js. Once you've seen this pattern twice in one project, it should
 * start feeling automatic: several implementations, one shared signature.
 */
export async function transcribe(wavPath, { mode = config.whisperMode } = {}) {
  if (!existsSync(wavPath)) throw new Error("Recording file missing.");
  try {
    return mode === "cloud"
      ? await transcribeCloud(wavPath)
      : await transcribeLocal(wavPath);
  } finally {
    try { unlinkSync(wavPath); } catch {} // always clean up temp audio
  }
}
