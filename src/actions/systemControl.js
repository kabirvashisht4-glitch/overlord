// ---------------------------------------------------------------------------
// ACTION: system_control
//
// CONCEPT: ENUMS ARE YOUR SEATBELT.
//
// This action could have taken `{ command: string }` and run whatever the
// model produced. That would be a remote-code-execution hole with a friendly
// voice. Instead `operation` is an ENUM — a fixed list of five allowed
// values. The model can only pick from the menu; it cannot write
// new commands.
//
// General rule for agents: give the model a MENU, never a BLANK CHEQUE.
// Every action you add, ask: "if the model went insane, what's the worst
// this lets it do?" If the answer scares you, narrow the schema.
// ---------------------------------------------------------------------------

import { run, osascript } from "../sh.js";
import { isMac } from "../config.js";

export default {
  name: "system_control",

  description:
    "Control basic Mac system state: volume, media playback, screenshot, or lock the screen. " +
    "Use for 'turn the volume down', 'pause the music', 'take a screenshot', 'lock my screen'.",

  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "set_volume",
          "mute",
          "play_pause",
          "screenshot",
          "lock_screen",
        ],
        description: "Which system operation to perform.",
      },
      value: {
        type: "number",
        description:
          "Only for set_volume: target volume 0-100. Ignored otherwise.",
      },
    },
    required: ["operation"],
  },

  async run({ operation, value }) {
    if (!isMac) return `(not macOS) would run: ${operation}`;

    switch (operation) {
      case "set_volume": {
        // Clamp before use. NEVER trust a number just because a schema said
        // "number" — the model can still hand you 5000 or -3.
        const v = Math.max(0, Math.min(100, Math.round(value ?? 50)));
        await osascript(`set volume output volume ${v}`);
        return `Volume set to ${v}.`;
      }

      case "mute":
        await osascript("set volume output muted true");
        return "Muted.";

      case "play_pause":
        // key code 16 with no modifiers = the F8 / play-pause media key.
        // This works across Spotify, Music, YouTube — anything listening
        // to the system media key. One line, universal.
        await osascript('tell application "System Events" to key code 16');
        return "Toggled playback.";

      case "screenshot": {
        const file = `${process.env.HOME}/Desktop/overlord-${Date.now()}.png`;
        await run("screencapture", ["-x", file]); // -x = silent, no shutter sound
        return `Screenshot saved to your Desktop.`;
      }

      case "lock_screen":
        await osascript(
          'tell application "System Events" to keystroke "q" using {control down, command down}',
        );
        return "Locking screen.";

      default:
        return `Unknown operation: ${operation}`;
    }
  },
};
