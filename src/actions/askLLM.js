// ---------------------------------------------------------------------------
// ACTION: ask_llm
//
// This is YOUR headline feature — the thing Wispr Flow and Alexa can't do.
// "Ask Claude what a monad is." / "Ask Gemini to summarise this."
//
// CONCEPT: THE ADAPTER PATTERN.
// Claude, Gemini and OpenAI all have different URLs, different auth headers,
// and different JSON shapes. If you scatter those differences through your
// code, adding a fourth provider means touching ten files.
//
// Instead: one small function per provider, all with the SAME signature
// (prompt in -> text out). The rest of the program only knows
// `askLLM(provider, prompt)`. Adding Mistral = adding one function to the
// PROVIDERS object. Nothing else moves.
//
// You will use this exact pattern for payment gateways, storage backends,
// auth providers — anywhere "several vendors, one job" shows up.
// ---------------------------------------------------------------------------

import { config } from "../config.js";

// --- provider adapters ------------------------------------------------------

async function askClaude(prompt) {
  if (!config.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Anthropic returns content as an ARRAY of blocks, not a string.
  // Joining the text blocks is the safe way to read it.
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function askGemini(prompt) {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set");
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty reply)";
}

async function askOpenAI(prompt) {
  if (!config.openaiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "(empty reply)";
}

// The whole point: one lookup table, one shared signature.
const PROVIDERS = {
  claude: askClaude,
  gemini: askGemini,
  openai: askOpenAI,
};

// --- the action -------------------------------------------------------------

export default {
  name: "ask_llm",

  description:
    "Send a question or instruction to a specific AI model and read the answer back. " +
    "Use this when the user explicitly names a model — 'ask Claude...', 'prompt Gemini...', " +
    "'what does ChatGPT think about...'. If the user did NOT name a model, prefer the " +
    "`answer` action instead of this one.",

  input_schema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["claude", "gemini", "openai"],
        description: "Which model the user asked for.",
      },
      prompt: {
        type: "string",
        description:
          "The full question to send. Clean it up into a proper sentence — " +
          "strip filler like 'hey', 'um', 'can you'.",
      },
    },
    required: ["provider", "prompt"],
  },

  async run({ provider, prompt }) {
    const fn = PROVIDERS[provider];
    if (!fn) return `I don't know a model called "${provider}".`;
    try {
      const answer = await fn(prompt);
      // Printing the full answer, speaking only a trimmed version, is
      // deliberate: nobody wants 800 words read aloud.
      console.log(`\n--- ${provider} ---\n${answer}\n-------------------\n`);
      return answer.length > 400 ? answer.slice(0, 400) + "..." : answer;
    } catch (err) {
      return `${provider} failed: ${err.message}`;
    }
  },
};
