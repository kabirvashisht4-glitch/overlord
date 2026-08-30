// ---------------------------------------------------------------------------
// The REGISTRY.
//
// CONCEPT: AUTO-DISCOVERY / "OPEN FOR EXTENSION, CLOSED FOR MODIFICATION".
//
// This file reads its own folder at startup and loads every .js file it
// finds. So to add a capability you write ONE new file and restart. You
// never edit this file, never edit the router, never edit index.js.
//
// The alternative — a hand-written list of imports — means every new action
// touches three files, and one day you'll add a file and spend 20 minutes
// wondering why it "doesn't work" (you forgot to register it). Design the
// boring failure out of existence instead of remembering not to make it.
//
// The trade-off: auto-magic is harder to trace when something breaks. That's
// why loadActions() logs exactly what it loaded and loudly skips what it
// couldn't. Magic is fine as long as it narrates itself.
// ---------------------------------------------------------------------------

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function loadActions({ verbose = false } = {}) {
  const registry = new Map();

  const files = readdirSync(HERE).filter(
    (f) => f.endsWith(".js") && f !== "index.js",
  );

  for (const file of files) {
    try {
      // Dynamic import needs a file:// URL to work on every OS (Windows
      // paths like C:\ are not valid URLs otherwise). Small detail, saves
      // you a confusing bug later.
      const mod = await import(pathToFileURL(join(HERE, file)).href);
      const action = mod.default;

      // Validate the contract at LOAD time, not at call time. A typo in a
      // schema should blow up when you start the app, not three weeks later
      // at 2am when someone finally says the magic sentence.
      if (!action?.name || !action?.input_schema || typeof action.run !== "function") {
        console.warn(`[registry] skipping ${file}: doesn't match the action contract`);
        continue;
      }
      if (registry.has(action.name)) {
        console.warn(`[registry] duplicate action name "${action.name}" in ${file}`);
        continue;
      }

      registry.set(action.name, action);
      if (verbose) console.log(`[registry] loaded ${action.name}  (${file})`);
    } catch (err) {
      console.warn(`[registry] failed to load ${file}: ${err.message}`);
    }
  }

  return registry;
}

/**
 * Convert the registry into the `tools` array the Claude API expects.
 * Notice how little translation is needed — that's not luck. The action
 * contract was designed to already BE the API's tool shape, so this function
 * is three lines instead of a mapping layer. Choosing an internal format that
 * matches the format you'll mostly export to is a cheap, permanent win.
 */
export function toToolSchemas(registry) {
  return [...registry.values()].map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}
