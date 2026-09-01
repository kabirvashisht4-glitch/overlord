// ---------------------------------------------------------------------------
// router.js — THE BRAIN, now an AGENT LOOP.
//
// THE ORIGINAL IDEA (still the foundation):
//
//   Don't parse English. Hand the model your functions and their schemas, and
//   it replies with a structured call. The infinite ways a human can phrase
//   something become the model's problem instead of an if-else pile.
//
// WHAT CHANGED, AND WHY:
//
//   One call per sentence handles "open Spotify". It cannot handle "open
//   Spotify and play the second song", which is three moves — launch, find,
//   play — and the second move depends on what the first one returned.
//
//   So: loop. Ask the model. Run whatever it asked for. Tell it what
//   happened. Ask again. Stop when it stops asking for tools.
//
//     you ──▶ model ──▶ tool call ──▶ run it ──▶ result ──┐
//                ▲                                        │
//                └────────────────────────────────────────┘
//                        (until no more tool calls)
//
// THAT LOOP IS WHAT THE WORD "AGENT" MEANS. Not the tool calling — a single
// call is just a function call with a fuzzy front end. The agent part is
// acting, observing the outcome, and deciding again with that knowledge.
//
// THREE THINGS THE LOOP MUST HAVE, or it will hurt you:
//
//   1. A STEP CEILING. A model that never stops asking for tools would run
//      forever, spending money or pinning a CPU. Every loop driven by a
//      model needs a hard bound it cannot argue with.
//   2. RESULTS FED BACK. If the model can't see what happened, step two is
//      a guess. The feedback IS the intelligence.
//   3. ERRORS AS RESULTS, NOT CRASHES. A failed tool is information — "that
//      app isn't installed" lets the model try something else. Throwing
//      away the loop on the first failure throws away its best quality.
// ---------------------------------------------------------------------------

import { config } from "./config.js";
import { toToolSchemas } from "./actions/index.js";
import { BRAINS, pickBrain } from "./brains.js";

const MAX_STEPS = 6;

const SYSTEM_PROMPT = `You are the intent router for a voice assistant on the user's Mac.

You receive a speech-to-text transcript. It may contain filler words, mis-hearings
or missing punctuation. Infer what was meant.

How to work:
- Call tools to carry out the request. You may call several in sequence.
- After each tool runs you are shown its result. Use it to decide the next step.
- When the request is complete, reply with a short sentence and NO tool call.
- If a tool fails, read the error and try a sensible alternative before giving up.
- Do not narrate your plan. Act, then report briefly at the end.

Judgement:
- "open Spotify and play" is one intention: use the spotify tool with
  open_and_play, not open_app followed by something else.
- If the user names a specific song, artist or album, use spotify play_track.
- If the user names an AI model (Claude, Gemini, ChatGPT), use ask_llm.
- If nothing matches and no action is needed, just answer in words.
- Clean up arguments: strip filler, fix obvious speech-to-text errors in names
  ("v s code" -> "Visual Studio Code", "you tube" -> YouTube).`;

// PERSONA SHAPES WORDING, NEVER BEHAVIOUR.
//
// It only ever affects the final sentence. Which tools run is decided by the
// schemas above it. If a personality could also change what the agent DOES,
// then anyone who can influence the personality can influence your actions.
// Character and capability belong in separate boxes.
const PERSONAS = {
  jarvis:
    "\nWhen you reply in words, write like a composed British butler-engineer: " +
    "brief, dry, unflappable. Address the user as 'sir'. One short sentence. " +
    "Understate rather than enthuse — 'Done, sir.' not 'All set!'. " +
    "No exclamation marks, no emoji.",
  plain: "",
};

/**
 * Run the loop until the model stops calling tools.
 *
 * @param onStep  called with each {name, input, result} so the caller can show
 *                progress. A multi-second silent pause reads as a hang; the
 *                cure is to narrate as you go, not to make it faster.
 * @returns final spoken text
 */
export async function route(transcript, registry, { onStep } = {}) {
  const brainName = pickBrain();
  const brain = BRAINS[brainName];
  const tools = toToolSchemas(registry);
  const system = SYSTEM_PROMPT + (PERSONAS[config.persona] ?? "");

  const messages = [{ role: "user", content: transcript }];
  let lastText = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    let reply;
    try {
      reply = await brain.converse({ messages, tools, system });
    } catch (err) {
      if (brainName === "ollama" && /ECONNREFUSED|fetch failed/i.test(err.message)) {
        throw new Error(
          "Ollama isn't running.\n" +
          "      Start it:      ollama serve\n" +
          "      Get a model:   ollama pull llama3.1\n" +
          "      (llama3.1 supports tool calling; llama2 does not.)",
        );
      }
      throw err;
    }

    lastText = reply.text || lastText;

    // No tools requested = the model considers the job done.
    if (!reply.toolCalls?.length) {
      return lastText || "Done.";
    }

    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });

    for (const call of reply.toolCalls) {
      const action = registry.get(call.name);
      let result;

      if (!action) {
        // A hallucinated tool name is a fact worth telling the model, not a
        // crash. Given the real list it will usually correct itself.
        result = `No such tool "${call.name}". Available: ${[...registry.keys()].join(", ")}`;
      } else {
        try {
          result = await action.run(call.input || {});
        } catch (err) {
          result = `Error: ${err.message}`;
        }
      }

      onStep?.({ name: call.name, input: call.input, result });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: result,
      });
    }
  }

  // Ceiling hit. Say so plainly rather than pretending it finished — a wrong
  // "done" is worse than an honest "I got stuck".
  return lastText || "I got partway through that but ran out of steps.";
}

/** Which brain is in use — printed at startup so it is never a mystery. */
export function brainInfo() {
  const name = pickBrain();
  return { name, label: BRAINS[name].label };
}

// ---------------------------------------------------------------------------
// THE MOCK ROUTER.
//
// Deliberately the keyword matching that the real router exists to replace.
// It is kept because it lets the whole pipeline be exercised with no key, no
// network and no cost — and because when something breaks it separates "the
// model chose wrong" from "the code is broken" in one run.
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

  if (t.includes("tab") || t.includes("browser")) return { name: "browser", input: { operation: "list_tabs" } };
  if (t.includes("youtube") || t.startsWith("play")) return { name: "play_youtube", input: { query: transcript.replace(/^play /i, "") } };
  if (t.includes("open")) return { name: "open_app", input: { app_name: transcript.split(/open /i)[1]?.trim() || "Finder" } };
  if (t.includes("volume")) return { name: "system_control", input: { operation: "set_volume", value: 30 } };
  if (t.includes("screenshot")) return { name: "system_control", input: { operation: "screenshot" } };
  if (t.includes("pause") || t.includes("resume")) return { name: "system_control", input: { operation: "play_pause" } };

  return { name: "answer", input: { text: `[mock] I heard: "${transcript}"` } };
}
