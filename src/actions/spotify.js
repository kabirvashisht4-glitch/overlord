// ---------------------------------------------------------------------------
// ACTION: spotify
//
// WHY THIS EXISTS — a limit found by a real sentence:
//
//   "open spotify and on the song"
//
// That is TWO instructions in one breath: launch the app, then start playback.
// The router returns exactly one tool call per sentence, so it opened Spotify
// and stopped. The user reasonably read that as broken.
//
// Two ways to fix it:
//
//   a) Let the router return several calls and loop until it is done.
//      More general, and the right long-term answer — but it changes the core
//      loop, adds latency and a new class of failure (a model that never
//      decides it is finished).
//
//   b) Notice that "open Spotify and play" is not really two ideas to a
//      human. It is one intention. So make it one action.
//
// (b) ships today and is what people actually mean. The lesson worth keeping:
// when a request needs two steps, ask whether it is genuinely two ideas or
// one idea you happened to model as two. Match the code to the intention,
// not to the mechanism.
//
// NOTE ON SCOPE: this drives Spotify's built-in AppleScript interface, which
// controls PLAYBACK — start, stop, skip, shuffle, volume. It cannot search
// for a named song or read your Liked Songs; that lives in your account, and
// reaching it needs the Spotify Web API and a login. See the note at the
// bottom for that upgrade.
// ---------------------------------------------------------------------------

import { run, osascript } from "../sh.js";
import { isMac } from "../config.js";

const tell = (cmd) => osascript(`tell application "Spotify" to ${cmd}`);

export default {
  name: "spotify",

  description:
    "Control Spotify playback on the Mac: start playing, pause, skip to the next " +
    "or previous track, toggle shuffle, or say what is currently playing. " +
    "Use 'open_and_play' when the user wants Spotify opened AND music started in " +
    "one go — e.g. 'open spotify and play', 'put spotify on', 'open spotify and " +
    "start the song'. Use this instead of open_app whenever the user mentions " +
    "music or playing something on Spotify. This cannot search for a specific " +
    "song by name — for that, tell the user it needs the Spotify Web API.",

  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "open_and_play",
          "play",
          "pause",
          "next",
          "previous",
          "shuffle_on",
          "shuffle_off",
          "now_playing",
        ],
        description:
          "What to do. 'open_and_play' launches Spotify then starts playback.",
      },
    },
    required: ["operation"],
  },

  async run({ operation }) {
    if (!isMac) return `(not macOS) would run spotify: ${operation}`;

    // Launch first when asked, then wait for the app to be ready.
    //
    // AppleScript sent to an app that is still starting up fails with
    // "Application isn't running" — a race, so it works when Spotify is
    // already open and fails exactly when it matters. Poll for readiness
    // instead of sleeping a fixed guess: fast when the app is warm, patient
    // when it is cold. Fixed sleeps are always either too slow or too short.
    if (operation === "open_and_play") {
      await run("open", ["-a", "Spotify"]);

      for (let i = 0; i < 20; i++) {
        const probe = await osascript(
          'tell application "System Events" to (name of processes) contains "Spotify"',
        );
        if (probe.ok && probe.out === "true") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 600)); // let the player attach

      const res = await tell("play");
      if (!res.ok) {
        return "Opened Spotify, but couldn't start playback. Is a song queued? Try pressing play once, then ask again.";
      }
      const t = await tell("name of current track");
      return t.ok && t.out ? `Playing ${t.out}.` : "Playing.";
    }

    switch (operation) {
      case "play": {
        const r = await tell("play");
        if (!r.ok) return "Couldn't start playback — is Spotify open?";
        const t = await tell("name of current track");
        return t.ok && t.out ? `Playing ${t.out}.` : "Playing.";
      }

      case "pause":
        await tell("pause");
        return "Paused.";

      case "next": {
        await tell("next track");
        // Spotify needs a beat to load the new track before its name is
        // readable; asking immediately returns the OLD track and the reply
        // is confidently wrong. A wrong answer is worse than a slow one.
        await new Promise((r) => setTimeout(r, 500));
        const t = await tell("name of current track");
        return t.ok && t.out ? `Skipped to ${t.out}.` : "Skipped.";
      }

      case "previous": {
        await tell("previous track");
        await new Promise((r) => setTimeout(r, 500));
        const t = await tell("name of current track");
        return t.ok && t.out ? `Back to ${t.out}.` : "Went back.";
      }

      case "shuffle_on":
        await tell("set shuffling to true");
        return "Shuffle on.";

      case "shuffle_off":
        await tell("set shuffling to false");
        return "Shuffle off.";

      case "now_playing": {
        const t = await tell("name of current track");
        const a = await tell("artist of current track");
        if (!t.ok || !t.out) return "Nothing is playing.";
        return a.ok && a.out ? `${t.out} by ${a.out}.` : t.out;
      }

      default:
        return `Unknown spotify operation: ${operation}`;
    }
  },
};

// ---------------------------------------------------------------------------
// UPGRADE: play a NAMED song, or your Liked Songs.
//
// AppleScript can only drive the player. "play Blinding Lights" and "play my
// liked songs" are questions about your ACCOUNT, and only Spotify's servers
// can answer them. That means the Web API and an OAuth login.
//
// Roughly:
//   1. developer.spotify.com → create an app → get a Client ID + Secret
//   2. Authorization Code flow with scopes:
//        user-modify-playback-state user-read-playback-state user-library-read
//   3. GET  /v1/search?q=<song>&type=track&limit=1   -> track.uri
//      PUT  /v1/me/player/play  { uris: [uri] }
//      GET  /v1/me/tracks                            -> your Liked Songs
//
// The action's name, description and schema barely change — only new enum
// values and a new branch. Same lesson as everywhere else in this project:
// a good interface means an upgrade touches one file.
// ---------------------------------------------------------------------------
