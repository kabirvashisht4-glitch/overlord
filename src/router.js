// ---------------------------------------------------------------------------
// router.js — THE BRAIN.
//
// This is the single most important file, and the one idea that separates
// a real voice agent from a toy.
//
// THE WRONG WAY (what almost everyone tries first):
//
//     if (text.includes("open"))       openApp(text.split("open")[1]);
//     else if (text.includes("play"))  playYouTube(...);
//     else if (text.includes("volume")) ...
//
// This dies immediately. "Open Spotify" works. "Can you fire up Spotify for
// me" doesn't. "Play something and turn it down a bit" doesn't. You end up
// writing an infinite pile of if-statements chasing the infinite ways
// humans say things. That is a losing war.
//
// THE RIGHT WAY — TOOL CALLING (a.k.a. function calling):
//
// You hand the model (a) the sentence and (b) the list of functions you
// have, complete with their JSON schemas. The model's job is not to answer.
// Its job is to pick a function and fill in its arguments. It replies with
// structured JSON:
//
//     { type: "tool_use", name: "open_app", input: { app_name: "Spotify" } }
//
// You never parse English. You get an object. The model absorbs ALL the
// linguistic variety — every phrasing, every accent, every "umm" from your
// transcript — and hands you clean data on the other side.
//
// Reframe it like this: you are not writing a language parser. You are
// writing a set of functions and letting the model be the parser.
// That reframe is the whole reason this project is buildable by one person.
// ---------------------------------------------------------------------------

import { config } from "./config.js";
import { toToolSchemas } from "./actions/index.js";

// The system prompt shapes HOW it picks. Short, specific, and full of
// tie-breakers. Most "the AI did something dumb" bugs are fixed here, not
// in code. Each line below resolves a real ambiguity worth expecting.
const SYSTEM_PROMPT = `You are the intent router for a voice assistant running on the user's Mac.

You will receive a raw speech-to-text transcript. It may contain filler words,
mis-hearings, or missing punctuation. Infer what the user meant.

Rules:
- Always respond by calling exactly one tool. Never reply with plain prose.
- If the user names a specific AI model (Claude, Gemini, ChatGPT), use ask_llm.
- If the user asks a general question with no model named, use answer.
- If the transcript is garbled, empty, or you are unsure, use answer and say
  briefly that you did not catch it. Do not guess at a destructive action.
- Clean up arguments before passing them: strip filler, fix obvious
  speech-to-text errors in app names (e.g. "v s code" -> "Visual Studio Code",
  "you tube" -> YouTube).`;

/**
 * @param {string} transcript  what the user said
 * @param {Map} registry       the loaded actions
 * @returns {{name: string, input: object}}  one tool call
 */
export async function route(transcript, registry) {
  if (!config.anthropicKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env, or run with --dry to use the offline mock router.",
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.routerModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toToolSchemas(registry),

      // tool_choice "any" = "you MUST call one of these tools".
      // Without this the model sometimes replies with chit-chat and your
      // executor gets nothing to run. This one field removes a whole class
      // of flaky behaviour — it turns a suggestion into a guarantee.
      tool_choice: { type: "any" },

      messages: [{ role: "user", content: transcript }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Router API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  // The reply is a list of content blocks. We want the first tool_use block.
  const call = data.content.find((b) => b.type === "tool_use");
  if (!call) {
    return { name: "answer", input: { text: "Sorry, I didn't catch that." } };
  }

  return { name: call.name, input: call.input };
}

// ---------------------------------------------------------------------------
// THE MOCK ROUTER.
//
// CONCEPT: TEST AT THE SEAM.
//
// This is the same `route()` signature, but it uses dumb keyword matching and
// zero network calls. Why keep the very thing described above as wrong?
//
// Because it lets you test the ENTIRE rest of the pipeline — registry,
// executor, voice output, error handling — with no API key, no internet, no
// cost, and no waiting. When something breaks you immediately know whether
// it's "the model chose wrong" (real router fails, mock works) or "the code
// is broken" (both fail). That's a diagnostic superpower for two dozen lines.
//
// Build the fake version of your slowest, most expensive dependency. Always.
// ---------------------------------------------------------------------------
export async function mockRoute(transcript) {
  const t = transcript.toLowerCase();

  if (t.includes("claude")) return { name: "ask_llm", input: { provider: "claude", prompt: transcript } };
  if (t.includes("gemini")) return { name: "ask_llm", input: { provider: "gemini", prompt: transcript } };
  if (t.includes("spotify")) {
    const wantsPlay = /\b(play|on|start|song|music)\b/.test(t);
    return { name: "spotify", input: { operation: wantsPlay ? "open_and_play" : "play" } };
  }
  if (t.includes("next") || t.includes("skip")) return { name: "spotify", input: { operation: "next" } };
  if (t.includes("what is playing") || t.includes("whats playing")) return { name: "spotify", input: { operation: "now_playing" } };
  if (t.includes("youtube") || t.startsWith("play")) return { name: "play_youtube", input: { query: transcript.replace(/^play /i, "") } };
  if (t.includes("open")) return { name: "open_app", input: { app_name: transcript.split(/open /i)[1]?.trim() || "Finder" } };
  if (t.includes("volume")) return { name: "system_control", input: { operation: "set_volume", value: 30 } };
  if (t.includes("screenshot")) return { name: "system_control", input: { operation: "screenshot" } };
  if (t.includes("pause") || t.includes("resume")) return { name: "system_control", input: { operation: "play_pause" } };

  return { name: "answer", input: { text: `[mock] I heard: "${transcript}"` } };
}
