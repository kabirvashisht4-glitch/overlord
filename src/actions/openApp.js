// ---------------------------------------------------------------------------
// ACTION: open_app
//
// THE ACTION CONTRACT — every file in this folder exports this same shape:
//
//   name         -> the function name the LLM will "call"
//   description  -> the LLM reads this to decide WHEN to use it.
//                   This string is not a comment. It is code that runs
//                   inside the model's head. Vague description = wrong
//                   action picked. Treat it like a function signature.
//   input_schema -> JSON Schema. This is a CONTRACT, not documentation.
//                   The model is forced to produce arguments matching it,
//                   so you never have to parse English.
//   run(input)   -> your actual logic. Returns a string to say back.
//
// Because every action is this same shape, adding a new capability =
// dropping a new file in this folder. The router never changes. That's
// the "registry pattern" and it's why this scales past 5 actions.
// ---------------------------------------------------------------------------

import { run } from "../sh.js";
import { isMac } from "../config.js";

export default {
  name: "open_app",

  description:
    "Open or focus an application on the user's computer. Use for requests " +
    "like 'open Spotify', 'launch VS Code', 'switch to Chrome'. The app_name " +
    "must be the real application name as installed (e.g. 'Visual Studio Code', " +
    "not 'vscode'; 'Google Chrome', not 'chrome').",

  input_schema: {
    type: "object",
    properties: {
      app_name: {
        type: "string",
        description:
          "Exact application name as installed, e.g. 'Spotify', 'Google Chrome', 'Visual Studio Code', 'Terminal'.",
      },
    },
    required: ["app_name"],
  },

  async run({ app_name }) {
    if (!isMac) return `(not macOS) would open: ${app_name}`;

    // `open -a AppName` is macOS's launch-or-focus command.
    const res = await run("open", ["-a", app_name]);

    if (!res.ok) {
      return `I couldn't find an app called "${app_name}". Check the exact name in your Applications folder.`;
    }
    return `Opened ${app_name}.`;
  },
};
