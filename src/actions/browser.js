// ---------------------------------------------------------------------------
// ACTION: browser
//
// Chrome and Safari both publish AppleScript dictionaries, so the browser is
// scriptable the same way Spotify is — no extension, no driver, no Selenium.
// `sdef /Applications/Google\ Chrome.app` lists everything it accepts.
//
// WHY THIS MATTERS FOR AN AGENT:
//
// list_tabs is the first action here that RETURNS INFORMATION rather than
// performing a change. That is what makes multi-step work. "Switch to the
// YouTube tab" is impossible in one move — you have to look first, then act
// on what you saw:
//
//   list_tabs        -> "1: GitHub  2: YouTube  3: Gmail"
//   switch_tab(2)    -> done
//
// An agent needs eyes, not just hands. Tools that only DO things leave the
// model guessing; one tool that reports state turns guessing into reasoning.
// When adding capabilities, ask what the model can currently SEE — that is
// usually the binding constraint, not what it can do.
// ---------------------------------------------------------------------------

import { run, osascript } from "../sh.js";
import { isMac } from "../config.js";

const BROWSERS = { chrome: "Google Chrome", safari: "Safari", brave: "Brave Browser" };

/** Which supported browser is actually running, preferring Chrome. */
async function activeBrowser() {
  for (const key of ["chrome", "brave", "safari"]) {
    const app = BROWSERS[key];
    const r = await osascript(
      `tell application "System Events" to (name of processes) contains "${app}"`,
    );
    if (r.ok && r.out === "true") return { key, app };
  }
  return { key: "chrome", app: "Google Chrome" }; // launch target
}

export default {
  name: "browser",

  description:
    "See and control the web browser (Chrome, Brave or Safari). " +
    "'list_tabs' reports every open tab with a number and title — use it FIRST " +
    "when the user refers to a tab by name ('switch to the YouTube tab'), then " +
    "'switch_tab' with that number. " +
    "'open_url' opens an address. 'search_youtube' opens a YouTube search for a " +
    "query. 'play_youtube_result' opens a YouTube search AND plays the first " +
    "result — use this for 'play X on youtube'. " +
    "'current_url' reports the page in front. 'close_tab' closes by number.",

  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "list_tabs",
          "switch_tab",
          "close_tab",
          "open_url",
          "current_url",
          "search_youtube",
          "play_youtube_result",
        ],
      },
      index: { type: "number", description: "Tab number, as reported by list_tabs." },
      url: { type: "string", description: "Full URL for open_url, including https://" },
      query: { type: "string", description: "Search terms for the YouTube operations." },
    },
    required: ["operation"],
  },

  async run({ operation, index, url, query }) {
    if (!isMac) return `(not macOS) would run browser: ${operation}`;
    const { key, app } = await activeBrowser();
    const isSafari = key === "safari";

    switch (operation) {
      case "list_tabs": {
        // Chrome and Safari name the same concepts differently — windows and
        // tabs in Chrome, windows and tabs in Safari but addressed another
        // way. Two small scripts beat one clever abstraction here.
        const script = isSafari
          ? `tell application "Safari"
               set out to ""
               set n to 0
               repeat with w in windows
                 repeat with t in tabs of w
                   set n to n + 1
                   set out to out & n & ": " & (name of t) & linefeed
                 end repeat
               end repeat
               return out
             end tell`
          : `tell application "${app}"
               set out to ""
               set n to 0
               repeat with w in windows
                 repeat with t in tabs of w
                   set n to n + 1
                   set out to out & n & ": " & (title of t) & linefeed
                 end repeat
               end repeat
               return out
             end tell`;
        const r = await osascript(script);
        if (!r.ok || !r.out.trim()) return `No tabs open in ${app}.`;
        // Titles can be long; trim so a spoken reply stays listenable.
        const lines = r.out.split("\n").filter(Boolean).map((l) => l.slice(0, 70));
        return `${lines.length} tabs in ${app}:\n${lines.join("\n")}`;
      }

      case "switch_tab": {
        const n = Number(index);
        if (!n || n < 1) return "Which tab number? Run list_tabs first.";
        const script = isSafari
          ? `tell application "Safari"
               set n to 0
               repeat with w in windows
                 repeat with i from 1 to count of tabs of w
                   set n to n + 1
                   if n = ${n} then
                     set current tab of w to tab i of w
                     set index of w to 1
                     activate
                     return name of tab i of w
                   end if
                 end repeat
               end repeat
             end tell`
          : `tell application "${app}"
               set n to 0
               repeat with w in windows
                 repeat with i from 1 to count of tabs of w
                   set n to n + 1
                   if n = ${n} then
                     set active tab index of w to i
                     set index of w to 1
                     activate
                     return title of tab i of w
                   end if
                 end repeat
               end repeat
             end tell`;
        const r = await osascript(script);
        return r.ok && r.out ? `Switched to: ${r.out}` : `No tab ${n}.`;
      }

      case "close_tab": {
        const n = Number(index);
        if (!n || n < 1) return "Which tab number? Run list_tabs first.";
        const script = `tell application "${app}"
             set n to 0
             repeat with w in windows
               repeat with i from 1 to count of tabs of w
                 set n to n + 1
                 if n = ${n} then
                   close tab i of w
                   return "closed"
                 end if
               end repeat
             end repeat
           end tell`;
        const r = await osascript(script);
        return r.ok ? `Closed tab ${n}.` : `Couldn't close tab ${n}.`;
      }

      case "current_url": {
        const script = isSafari
          ? `tell application "Safari" to return (URL of current tab of front window) & " — " & (name of current tab of front window)`
          : `tell application "${app}" to return (URL of active tab of front window) & " — " & (title of active tab of front window)`;
        const r = await osascript(script);
        return r.ok && r.out ? r.out.slice(0, 200) : "Nothing open.";
      }

      case "open_url": {
        if (!url) return "Which address?";
        // Argument array, never a built command string — the URL comes from
        // a language model and must not be able to become shell syntax.
        await run("open", ["-a", app, url]);
        return `Opened ${url}`;
      }

      case "search_youtube": {
        if (!query) return "Search YouTube for what?";
        await run("open", ["-a", app, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`]);
        return `Searching YouTube for "${query}".`;
      }

      case "play_youtube_result": {
        if (!query) return "Play what?";
        // There is no public URL meaning "play the top result", so this opens
        // the results page and clicks the first video via injected JS.
        //
        // Honest about the trade: this is the one place in the project that
        // depends on someone else's page structure, and YouTube can change it
        // any afternoon. It is contained to this branch and fails into a
        // usable state — the search page is open and one click away — rather
        // than pretending it worked.
        await run("open", ["-a", app, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`]);
        await new Promise((r) => setTimeout(r, 2600)); // let results render

        if (isSafari) return `Opened YouTube results for "${query}" — Safari blocks scripted clicks, so pick one.`;

        const js = `var a=document.querySelector('a#video-title, ytd-video-renderer a#thumbnail');if(a){a.click();'ok'}else{'none'}`;
        const r = await osascript(
          `tell application "${app}" to tell active tab of front window to execute javascript "${js.replace(/"/g, '\\"')}"`,
        );
        if (r.ok && r.out === "ok") return `Playing the top YouTube result for "${query}".`;
        return `Opened YouTube results for "${query}". Enable View > Developer > Allow JavaScript from Apple Events in Chrome to auto-play the first hit.`;
      }

      default:
        return `Unknown browser operation: ${operation}`;
    }
  },
};
