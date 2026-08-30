// ---------------------------------------------------------------------------
// ACTION: play_youtube
//
// CONCEPT: "the last mile is always uglier than the diagram."
//
// The dream: "play that lo-fi video I watched yesterday" -> it plays.
// Reality: YouTube has no public URL that means "play the top result".
// You have three honest options, in increasing effort:
//
//   1. Open the search results page and let the human click.  (v1 — here)
//   2. Use the YouTube Data API v3 to search, get a videoId, open
//      youtube.com/watch?v=<id> directly.  (v2 — needs a free API key)
//   3. Drive the page with Playwright and click the first result.
//      (v3 — works with no API key, but breaks whenever YouTube redesigns)
//
// Option (1) is what ships here, so it WORKS TODAY with zero setup. The path
// is written into the code below so you can walk it yourself.
//
// This is a habit worth stealing: ship the version that works, and leave
// a signed note explaining what the better version is.
// ---------------------------------------------------------------------------

import { run } from "../sh.js";
import { config } from "../config.js";

export default {
  name: "play_youtube",

  description:
    "Search YouTube and open a video in the browser. Use for 'play X on youtube', " +
    "'put on some lofi', 'open that video about Y'. Pass what the user described " +
    "as the query — do not invent a URL.",

  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for on YouTube, e.g. 'lofi hip hop radio', 'Berserk 1997 opening'.",
      },
    },
    required: ["query"],
  },

  async run({ query }) {
    // encodeURIComponent turns spaces/&/? into safe %XX escapes.
    // Forget this and a query like "rock & roll" silently breaks your URL.
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    const opener =
      config.platform === "darwin"
        ? ["open", [url]]
        : config.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];

    const res = await run(opener[0], opener[1]);
    if (!res.ok) return `Couldn't open the browser: ${res.error}`;
    return `Searching YouTube for "${query}".`;
  },
};

// ---------------------------------------------------------------------------
// UPGRADE TO v2 (do this yourself — it's a good 30-minute exercise):
//
//   1. Get a free key at console.cloud.google.com -> enable "YouTube Data API v3"
//   2. Replace the body of run() with:
//
//      const api = `https://www.googleapis.com/youtube/v3/search`
//        + `?part=snippet&type=video&maxResults=1`
//        + `&q=${encodeURIComponent(query)}&key=${config.youtubeKey}`;
//      const r  = await fetch(api);
//      const j  = await r.json();
//      const id = j.items?.[0]?.id?.videoId;
//      if (!id) return `No results for "${query}".`;
//      await run("open", [`https://www.youtube.com/watch?v=${id}`]);
//      return `Playing: ${j.items[0].snippet.title}`;
//
//   Notice: the action's NAME, DESCRIPTION and SCHEMA don't change at all.
//   Only the body does. The router, the voice layer, and everything else
//   are untouched. That's what a good interface buys you.
// ---------------------------------------------------------------------------
