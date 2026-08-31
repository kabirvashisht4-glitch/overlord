# ▚ Overlord

A local voice agent for macOS. You speak, it decides, it acts on your machine.

Not a dictation tool. Dictation converts speech into *text*. This converts
speech into *actions*.

```
"open Spotify"                     → launches Spotify
"play lofi on youtube"             → opens the search in your browser
"ask Claude what a closure is"     → hits the Anthropic API, reads it back
"ask Gemini to summarise that"     → hits Google's API instead
"turn the volume down"             → sets system volume
"take a screenshot"                → saves it to your Desktop
"hey how's it going"               → just talks back
```

---

It answers to its name. You don't press anything.

```
you:  "Overlord, open Spotify"
you:  "...and turn the volume down"      ← no wake word needed for 8s
you:  "Overlord, ask Gemini what a monad is"
```

---

## Run it in 60 seconds (no API keys needed)

```bash
cd overlord
npm run dry
```

That starts the **mock brain** — keyword matching, no network, no keys. Type
commands and watch the whole pipeline work. This exists so you can see the
machine turning before you spend a rupee.

## Run it for real (typing)

```bash
cp .env.example .env
npm run text
```

Now a real model does the routing. Try phrasing things badly on purpose —
"yo can you fire up spotify for me" — and watch it still work. That's the
whole point of the design.

## Run it with your voice (always listening)

```bash
brew install sox whisper-cpp
curl -L -o ~/.overlord-whisper.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
npm run doctor
npm start
```

Now just talk. Say **"Overlord, open Spotify"** from across the room.

Run those lines **one at a time**, not as a block.

`npm run doctor` checks every dependency is installed.

If it starts but never reacts to your voice, run:

```bash
npm run tune
```

That records five seconds, then reports what each stage of the pipeline
actually saw — microphone level, the transcript whisper produced, and the
wake-word score against your threshold. In wake mode every failure looks the
same from outside (silence), so `tune` exists to turn that silence back into
a readable number.

**Push-to-talk instead** (no wake word, press Enter to talk): `npm run ptt`

macOS will ask for mic permission the first time. Terminal also needs
**System Settings → Privacy & Security → Accessibility** ticked for the
volume/media-key actions to work.

There are no npm dependencies. `npm install` does nothing. That's deliberate.

### Your audio stays on your laptop

Wake mode defaults to `WHISPER_MODE=local` — whisper.cpp transcribes on your
machine and nothing is uploaded. That default is deliberate: push-to-talk
sends audio only when you press a key, but always-on listening would
otherwise stream your entire room to someone's server forever. Your
flatmates never agreed to that.

Set `WHISPER_MODE=cloud` if you want the (more accurate) API and understand
the trade.

### Tuning it

| Symptom | Fix in `.env` |
|---|---|
| Ignores you | `WAKE_THRESHOLD=0.65` |
| Fires at random | `WAKE_THRESHOLD=0.80`, or pick a rarer wake word |
| Triggers on fan/typing noise | `VAD_THRESHOLD=4` |
| Cuts you off mid-sentence | `VAD_SILENCE=2.0` |
| Follow-up window too short | `FOLLOW_UP_SECONDS=15` |

Run `npm run wake:test` to see exactly what your current threshold accepts.

---

## The architecture (four layers, swap any one)

```
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │   EARS   │──▶│  BRAIN   │──▶│  HANDS   │──▶│  MOUTH   │
  │ wake.js  │   │router.js │   │ actions/ │   │ speak()  │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘
   mic → text    text → {name,   run the        result →
                        input}   function       spoken
```

In wake mode the ear is a state machine:

```
   ┌───────────────────────────────────────────────────┐
   ▼            heard the wake word                    │
 SLEEPING ─────────────────────────▶ AWAKE ─▶ THINKING │
   ▲  │ heard anything else            ▲         │     │
   │  └─(discard, never logged)        │         ▼     │
   │                                   │      SPEAKING │
   │        follow-up window expires   │         │     │
   └───────────────────────────────────┴─────────┘◀────┘
                        stay AWAKE for 8s after replying
```

Two states beginners always forget, and both bite:
**SPEAKING** (mic must be off, or it hears itself and loops forever) and the
**follow-up window** (what makes it feel like a conversation, not a vending
machine).

Each layer talks to the next through a tiny, boring interface. That means
you can rip out any single layer without touching the others:

| Want to change | Edit only | Everything else |
|---|---|---|
| Local/private speech-to-text | `listen.js` | untouched |
| Use GPT or a local Llama as the router | `router.js` | untouched |
| Add a new capability | one new file in `actions/` | untouched |
| Menu-bar app instead of terminal | wrap `index.js` in Electron | untouched |

`src/index.js` → `runOnce()` is the entire program in ~20 lines. Read that
first.

---

## Adding your own action

Drop a file in `src/actions/`. The registry finds it automatically — you
never edit the router or the main loop.

```js
// src/actions/openUrl.js
import { run } from "../sh.js";

export default {
  name: "open_url",
  description:
    "Open a website in the default browser. Use for 'open github', " +
    "'go to twitter', 'pull up my linkedin'.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL including https://" },
    },
    required: ["url"],
  },
  async run({ url }) {
    await run("open", [url]);
    return `Opening ${url}`;
  },
};
```

Restart. Say "open my github". Done — that's the entire cost of a new skill.

**The `description` field is not a comment.** It is the only thing the model
reads when deciding whether to use your action. A vague description is a bug.
Write it like a function signature that a stranger has to understand.

---

## The concepts this project is actually teaching

1. **Tool calling replaces parsing.** Never write `if (text.includes("open"))`.
   Hand the model your function schemas and let it produce structured JSON.
   You stop fighting the infinite ways humans phrase things.

2. **Schemas are seatbelts.** `operation` is an `enum` of five values, not a
   free string. The model gets a menu, never a blank cheque. Ask of every
   action: "if the model went insane, what's the worst this allows?"

3. **Never build shell commands with string concatenation.** `execFile(cmd,
   [args])` instead of `exec(\`cmd ${arg}\`)`. Same bug family as SQL
   injection, which you'll meet again in Express + Mongo.

4. **Build the fake version of your slowest dependency.** The mock router
   (bottom of `router.js`) lets you test everything with no key, no internet
   and no wait — and tells you instantly whether a failure is "model chose
   wrong" or "the code is broken".

5. **Registries beat manual lists.** Auto-discovery means adding a feature
   touches exactly one file. Design the boring mistake out of existence
   rather than remembering not to make it.

6. **Put a cheap gate in front of an expensive stage.** Naive wake-word code
   transcribes 43,000 clips a day, almost all of them silence. Voice activity
   detection costs ~nothing and blocks 99.9% of them. Same shape as an index
   before a table scan, or a cache before an API call. Whenever something
   expensive sits in a loop, ask what cheap test goes in front of it.

7. **Fuzzy match what humans say.** Speech-to-text returns its *guess*, not
   your word. `text === "overlord"` catches maybe 40% of real utterances.
   Levenshtein distance (yes — LeetCode 72) catches all of them. See
   `wakeword.js`.

8. **Normalise for matching; return the original for use.** Easy to get
   wrong, and the test suite catches it: lowercasing is a comparison trick,
   not a fact about the input. Match on the cleaned copy, pass on the real
   thing.

9. **A convenience change can secretly be a consent change.** Push-to-talk
   and always-listening are the same code path with completely different
   ethics. Notice when "just more convenient" quietly becomes a different
   product.

10. **Ship a doctor.** In wake mode, a broken setup fails as *silence* — no
    error, nothing to read. `npm run doctor` checks every dependency and
    prints the exact fix. Worth more than most features.

---

## Where to take it next

- **v2 — real YouTube playback.** YouTube Data API v3, ~20 lines. The exact
  code is commented at the bottom of `playYouTube.js`.
- **v2 — barge-in.** Right now you can't interrupt it mid-sentence. Real
  assistants stop talking the moment you speak. Needs the mic live during
  SPEAKING plus echo cancellation so it doesn't hear itself — the hardest
  remaining piece, and the one that most makes it feel real.
- **v3 — memory.** "play that video I watched yesterday" needs history. Add
  a `history.json`, feed the last N interactions to the router as context.
  Suddenly it can resolve "that one", "again", "like before".
- **v3 — multi-step.** Right now: one sentence, one action. Let the router
  return several tool calls, feed results back in, loop. That's the jump from
  "voice remote" to "agent".
- **v3 — MCP.** Instead of writing every action yourself, speak to the
  hundreds of existing MCP servers (Spotify, Notion, GitHub). Your router
  already speaks tool-calling, which is exactly what MCP exposes. This is
  the highest-leverage upgrade in the whole list.
- **v4 — fully local.** whisper.cpp + Ollama = zero API cost, works offline,
  your voice never leaves the laptop.

---

## Status — what's verified and what isn't

Stated plainly, because this is public and someone might rely on it.

**Verified, runs green:**

- 24 automated tests (wake-word matching, conversation state machine)
- The full pipeline in `--dry` and `--text` mode: registry → router → action
  dispatch → error handling
- Every file parses; `npm run doctor` correctly reports a broken environment

**Not yet verified on real hardware:**

- The macOS path — `sox` recording from a live mic, whisper.cpp transcription,
  and the AppleScript actions (`open -a`, volume, media keys) have never been
  executed on an actual Mac. They were written against documented behaviour.
- Accuracy of wake detection against a *real* microphone in a *real* room.
  The 16 mishearings in the test suite are realistic, but they are
  predicted Whisper output, not recordings of it.

So: the logic is tested, the hardware integration is not. Expect the first
real run to need tuning (`VAD_THRESHOLD` and `WAKE_THRESHOLD` are the two
dials). `npm run doctor` exists precisely because that first run is where
things break.

---

## Tests

```bash
npm run wake:test
node test/statemachine.test.mjs
npm run doctor
```

All of it runs with no microphone, no API key and no network. That's not an
accident — wake detection and timing logic are exactly the parts you cannot
debug by using the app, because when they're wrong you get silence.

## Safety notes

- The `.env` file holds live API keys. It is **not** in git — check that
  `.gitignore` covers it before you push to GitHub.
- Actions run real commands on your Mac. Read any action you add from the
  internet before running it.
- If you ever add a `run_shell_command` action, you have given a language
  model root on your laptop. Don't.
