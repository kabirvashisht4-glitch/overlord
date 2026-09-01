// ---------------------------------------------------------------------------
// brains.js — one conversation interface over every model provider.
//
// This file exists twice over. First as the ADAPTER PATTERN (third use in the
// project, after askLLM.js and transcriber.js): several vendors, one job, one
// function each, one shared signature.
//
// Second, and more importantly, as the thing that makes MULTI-STEP possible.
//
// The first router asked for one tool call and stopped. That is enough for
// "open Spotify" and useless for "open Spotify and play the second song",
// which is three moves: launch, find, play. To do that the model has to SEE
// what happened after each step — so instead of sending one message and
// reading one reply, we keep a transcript and hand it back each turn.
//
// Every provider represents that transcript differently, and that is the only
// hard part. `converse()` below takes ONE neutral message shape:
//
//   { role: "user"|"assistant"|"tool", content, toolCalls?, toolCallId? }
//
// and each adapter translates it into whatever its vendor wants. The agent
// loop in router.js never learns any of those dialects.
// ---------------------------------------------------------------------------

import { config } from "./config.js";

// --- schema shaping ---------------------------------------------------------

const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

/**
 * Gemini accepts a SUBSET of JSON Schema and rejects the entire request on an
 * unknown key, with a vague 400. Send only what it documents rather than
 * hoping. When an API is strict, meet it exactly.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const k of ["type", "description", "enum", "required"]) if (schema[k]) out[k] = schema[k];
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toGeminiSchema(v);
  }
  return out;
}

// --- message translation ----------------------------------------------------

/** Neutral transcript -> Anthropic's content-block format. */
function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: String(m.content) }],
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
      };
    }
    return { role: m.role, content: String(m.content ?? "") };
  });
}

/** Neutral transcript -> OpenAI's format (also Groq, Ollama, OpenRouter). */
function toOpenAIMessages(messages, system) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: String(m.content) });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
    } else {
      out.push({ role: m.role, content: String(m.content ?? "") });
    }
  }
  return out;
}

// --- adapters ---------------------------------------------------------------
// Each returns { toolCalls: [{id,name,input}], text }

async function anthropic({ messages, tools, system }) {
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
      messages: toAnthropicMessages(messages),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    toolCalls: data.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    text: data.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
  };
}

/** Covers OpenAI, Groq, Ollama, OpenRouter — they share this request shape. */
async function openaiCompatible({ messages, tools, system }, { baseUrl, key, model }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      tools: toOpenAITools(tools),
      messages: toOpenAIMessages(messages, system),
    }),
  });
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};

  return {
    toolCalls: (msg.tool_calls || []).map((c, i) => ({
      // Ollama sometimes omits the call id that OpenAI always sends. The next
      // turn's tool_result has to reference SOMETHING, so synthesise one
      // rather than sending undefined and getting an opaque 400.
      id: c.id || `call_${i}_${Date.now()}`,
      name: c.function?.name,
      // Arguments arrive as a JSON STRING here, unlike Anthropic. Unparsed,
      // it fails deep inside the action instead of at this boundary.
      input: safeParse(c.function?.arguments),
    })),
    text: msg.content || "",
  };
}

const safeParse = (s) => {
  if (!s) return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return {}; }
};

async function gemini({ messages, tools, system }) {
  const model = config.routerModel?.startsWith("gemini") ? config.routerModel : "gemini-2.5-flash";
  const contents = messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: m.toolName, response: { result: String(m.content) } } }],
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "model",
        parts: m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.input } })),
      };
    }
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content ?? "") }] };
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        tools: [{
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.input_schema),
          })),
        }],
        contents,
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return {
    toolCalls: parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({ id: `g_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} })),
    text: parts.filter((p) => p.text).map((p) => p.text).join(""),
  };
}

// --- registry ---------------------------------------------------------------

export const BRAINS = {
  anthropic: {
    label: "Anthropic (Claude)",
    has: () => !!config.anthropicKey,
    converse: anthropic,
  },
  openai: {
    label: "OpenAI",
    has: () => !!config.openaiKey,
    converse: (a) => openaiCompatible(a, {
      baseUrl: "https://api.openai.com/v1",
      key: config.openaiKey,
      model: config.routerModel?.startsWith("gpt") ? config.routerModel : "gpt-4o-mini",
    }),
  },
  gemini: {
    label: "Google Gemini (free tier)",
    has: () => !!config.geminiKey,
    converse: gemini,
  },
  groq: {
    label: "Groq (free tier, very fast)",
    has: () => !!config.groqKey,
    converse: (a) => openaiCompatible(a, {
      baseUrl: "https://api.groq.com/openai/v1",
      key: config.groqKey,
      model: config.routerModel || "llama-3.3-70b-versatile",
    }),
  },
  ollama: {
    label: "Ollama (local, free, no key, offline)",
    has: () => true,
    converse: (a) => openaiCompatible(a, {
      baseUrl: config.ollamaUrl,
      key: null,
      model: config.routerModel || "llama3.1",
    }),
  },
};

export function pickBrain() {
  const explicit = config.routerProvider?.toLowerCase();
  if (explicit && BRAINS[explicit]) return explicit;
  for (const n of ["anthropic", "openai", "groq", "gemini"]) if (BRAINS[n].has()) return n;
  return "ollama";
}
