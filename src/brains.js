// ---------------------------------------------------------------------------
// brains.js — the router works with ANY model provider.
//
// The first version hard-coded Anthropic. That was a limitation, not a
// decision: every one of these providers can do tool calling, and which one
// you can afford should not dictate the architecture.
//
// THIS IS THE ADAPTER PATTERN AGAIN — the third time in this project
// (askLLM.js for providers, transcriber.js for local vs cloud). When a
// pattern shows up three times, it has stopped being a trick and become a
// habit worth having:
//
//   Several vendors, one job  ->  one function each, one shared signature.
//
// Every adapter below takes (transcript, tools, systemPrompt) and returns
// { name, input }. router.js calls one of them and has no idea which.
//
// WHAT ACTUALLY DIFFERS between them is only two things:
//   1. how the tool list is SHAPED in the request
//   2. where the chosen call HIDES in the response
// Everything else — the idea of handing a model functions and getting back a
// structured call — is the same everywhere. Learn the idea once; the vendor
// differences are lookup.
// ---------------------------------------------------------------------------

import { config } from "./config.js";

// --- schema shaping ---------------------------------------------------------

/** OpenAI-family (also Groq, Ollama, OpenRouter, most local servers). */
const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

/**
 * Gemini accepts a SUBSET of JSON Schema and rejects the whole request if it
 * sees a key it doesn't know — a 400 with a vague message, which is a
 * miserable thing to debug. So strip down to the fields it documents rather
 * than hoping. When an API is strict, send it only what it asked for.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  return out;
}

// --- adapters ---------------------------------------------------------------

async function anthropic(transcript, tools, system) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.routerModel || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system,
      tools,
      tool_choice: { type: "any" }, // must pick a tool, not chat
      messages: [{ role: "user", content: transcript }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const call = data.content.find((b) => b.type === "tool_use");
  return call ? { name: call.name, input: call.input } : null;
}

/**
 * One function covers OpenAI, Groq, Ollama, OpenRouter and most local
 * servers, because they all copied OpenAI's request shape. That convergence
 * is worth knowing: pick the format the ecosystem standardised on and a
 * single adapter reaches a dozen providers.
 */
async function openaiCompatible(transcript, tools, system, { baseUrl, key, model }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      tools: toOpenAITools(tools),
      tool_choice: "required",
      messages: [
        { role: "system", content: system },
        { role: "user", content: transcript },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;

  // Arguments arrive as a JSON STRING here, not an object — a real
  // difference from Anthropic, and a silent one: forget to parse and you
  // pass a string where the action expects fields, and it fails deep inside
  // the action rather than here. Parse at the boundary, always.
  let input = {};
  try {
    input = JSON.parse(call.function.arguments || "{}");
  } catch {
    input = {};
  }
  return { name: call.function.name, input };
}

async function gemini(transcript, tools, system) {
  const model = config.routerModel?.startsWith("gemini")
    ? config.routerModel
    : "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.input_schema),
          })),
        },
      ],
      // "ANY" is Gemini's spelling of "you must call a function".
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      contents: [{ role: "user", parts: [{ text: transcript }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
  return part ? { name: part.functionCall.name, input: part.functionCall.args || {} } : null;
}

// --- the registry -----------------------------------------------------------

export const BRAINS = {
  anthropic: {
    label: "Anthropic (Claude)",
    needs: "ANTHROPIC_API_KEY",
    has: () => !!config.anthropicKey,
    call: anthropic,
  },
  openai: {
    label: "OpenAI",
    needs: "OPENAI_API_KEY",
    has: () => !!config.openaiKey,
    call: (t, tools, s) =>
      openaiCompatible(t, tools, s, {
        baseUrl: "https://api.openai.com/v1",
        key: config.openaiKey,
        model: config.routerModel?.startsWith("gpt") ? config.routerModel : "gpt-4o-mini",
      }),
  },
  gemini: {
    label: "Google Gemini (free tier available)",
    needs: "GEMINI_API_KEY",
    has: () => !!config.geminiKey,
    call: gemini,
  },
  groq: {
    label: "Groq (free tier, very fast)",
    needs: "GROQ_API_KEY",
    has: () => !!config.groqKey,
    call: (t, tools, s) =>
      openaiCompatible(t, tools, s, {
        baseUrl: "https://api.groq.com/openai/v1",
        key: config.groqKey,
        model: config.routerModel?.includes("/") || config.routerModel?.includes("llama")
          ? config.routerModel
          : "llama-3.3-70b-versatile",
      }),
  },
  ollama: {
    label: "Ollama (local, free, no key, works offline)",
    needs: "nothing — but Ollama must be running",
    has: () => true, // no key to check; reachability is checked at call time
    call: (t, tools, s) =>
      openaiCompatible(t, tools, s, {
        baseUrl: config.ollamaUrl,
        key: null,
        model: config.routerModel?.includes(":") ? config.routerModel : "llama3.1",
      }),
  },
};

/**
 * Pick a provider: an explicit setting wins, otherwise the first one whose
 * key is actually present, otherwise local Ollama.
 *
 * Falling back to the free local option rather than erroring is deliberate:
 * the cheapest path to "it works" should never be blocked on a credit card.
 */
export function pickBrain() {
  const explicit = config.routerProvider?.toLowerCase();
  if (explicit && BRAINS[explicit]) return explicit;

  for (const name of ["anthropic", "openai", "groq", "gemini"]) {
    if (BRAINS[name].has()) return name;
  }
  return "ollama";
}
