// ---------------------------------------------------------------------------
// wakeword.js — deciding whether the user actually said the magic word.
//
// THE PROBLEM NOBODY WARNS YOU ABOUT:
//
// You will write `if (text.startsWith("overlord"))` and it will fail
// constantly. Speech-to-text does not return the word you said. It returns
// its best guess, and for an unusual name that guess is wrong most of the
// time. Real Whisper output for someone saying "Overlord, open Spotify":
//
//     "Over lord, open Spotify"      <- split into two words
//     "Overload, open Spotify"       <- heard a real English word instead
//     "Oberlord open spotify"        <- b/v confusion
//     "over Lord. Open Spotify."     <- punctuation and caps invented
//     "Overlord open Spotify"        <- (correct, sometimes!)
//
// Exact matching catches maybe 40% of these. The user experiences this as
// "it just ignores me" and stops using your product.
//
// THE FIX: fuzzy matching. Measure how DIFFERENT two strings are, and accept
// anything close enough. The standard tool is LEVENSHTEIN DISTANCE — the
// minimum number of single-character edits (insert, delete, substitute) to
// turn one string into another.
//
//     overlord -> overload   = 1 edit  (swap 'r' for 'a')  ACCEPT
//     overlord -> spotify    = 8 edits                     REJECT
//
// You will recognise this from DSA — it's the classic 2D dynamic programming
// problem (LeetCode 72, "Edit Distance"). This is one of those rare moments
// where a textbook algorithm is EXACTLY the right tool for a real product
// problem, so it's worth reading the implementation properly.
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance via dynamic programming.
 *
 * The insight: to know the cost of converting a[0..i] into b[0..j], you only
 * need three already-solved smaller problems:
 *   - delete    a[i]      -> 1 + cost(i-1, j)
 *   - insert    b[j]      -> 1 + cost(i, j-1)
 *   - substitute a[i]→b[j] -> cost(i-1, j-1) + (chars differ ? 1 : 0)
 * Take the cheapest. Build a table bottom-up and the answer is the corner.
 *
 * The textbook version allocates a full (m+1)×(n+1) matrix. We only ever
 * look at the previous row, so we keep TWO rows instead — O(n) memory
 * instead of O(m×n). That's a standard DP space optimisation and it's a good
 * one to have in your fingers for interviews.
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev]; // swap the rows, reuse the arrays
  }
  return prev[b.length];
}

/**
 * Similarity as 0..1, so the threshold means the same thing regardless of
 * word length. A distance of 2 is trivial in a 12-letter word and huge in a
 * 3-letter one — raw distance is not comparable across words. Normalising
 * is what lets you write ONE threshold that works for any wake word.
 */
export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// Strip punctuation/case so "Over-Lord." and "over lord" compare equal.
// Note we also squash internal spaces: STT loves splitting invented names
// into two words, so "over lord" must be able to match "overlord".
const normalise = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// A DESIGN RULE that is easy to get wrong, and that the test suite catches:
//
//   NORMALISE FOR MATCHING. RETURN THE ORIGINAL FOR USE.
//
// My first version compared normalised text AND returned the normalised
// command. So "Overlord, open Spotify" reached the router as "open spotify"
// — lowercased, punctuation gone. That silently throws away information the
// next stage wants: capitalisation is a real hint about proper nouns
// ("Spotify", "VS Code"), and the router is a language model that reads it.
//
// Lowercasing is a comparison trick. It is not a fact about the input.
// Keep the two apart: match on the cleaned copy, hand on the real thing.
// This bug class shows up everywhere — search, dedupe, login, sorting.
// ---------------------------------------------------------------------------

/**
 * Split into words while keeping the original spelling of each one aligned
 * with its normalised form, so we can match on one and slice from the other.
 */
function alignedWords(text) {
  const pairs = [];
  for (const raw of text.trim().split(/\s+/)) {
    const norm = normalise(raw);
    if (norm) pairs.push({ raw, norm }); // drop pure-punctuation tokens
  }
  return pairs;
}

/**
 * Look for the wake word near the START of the transcript, and return the
 * command that follows it.
 *
 * WHY ONLY THE START?
 * If you scan the whole sentence, then saying "I was reading about the
 * overlord in that manga" fires a command. Wake words live at the front of
 * an utterance; enforcing that kills a whole category of false triggers for
 * free. We check the first 3 words to allow for a stray "um" or "hey".
 *
 * @returns {{matched: boolean, command: string, score: number}}
 */
export function detectWakeWord(transcript, wakeWord, threshold = 0.72) {
  const words = alignedWords(transcript);
  const wake = normalise(wakeWord);
  if (!words.length) return { matched: false, command: "", score: 0 };

  const wakeWordCount = wake.split(" ").length;
  let best = { matched: false, command: "", score: 0 };

  // Track the closest candidate even when nothing clears the bar. A rejection
  // that reports 0.68 tells you to lower the threshold; a rejection that just
  // says "no" tells you nothing. Failure paths should carry as much
  // information as success paths — that is what makes a system debuggable
  // from the outside.
  let bestScore = 0;

  // Try consuming 1..N words from the front as the candidate wake phrase,
  // and allow it to start after up to 2 filler words ("um", "hey", "ok").
  for (let start = 0; start <= Math.min(2, words.length - 1); start++) {
    for (let take = wakeWordCount; take <= wakeWordCount + 1; take++) {
      const candidate = words.slice(start, start + take).map((w) => w.norm).join(" ");
      if (!candidate) continue;

      const score = similarity(candidate, wake);
      if (score > bestScore) bestScore = score;
      if (score >= threshold && score > best.score) {
        best = {
          matched: true,
          // .raw — the user's ACTUAL words, capitals and all, handed to the
          // router untouched. Only the wake word itself is removed.
          command: words.slice(start + take).map((w) => w.raw).join(" ").trim(),
          score,
        };
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// CHOOSING A GOOD WAKE WORD — this matters more than the code.
//
// GOOD wake words are:
//   - 3+ syllables ("Overlord", "Jarvis", "Computer"). Short words collide
//     with ordinary speech constantly.
//   - Not common English. "Hey" or "Go" would fire all day.
//   - Phonetically distinctive — few near-neighbours in the language.
//
// This is exactly why Amazon picked "Alexa" and Apple picked "Siri" — rare,
// multi-syllable, few sound-alikes. If your false-trigger rate is annoying,
// change the WORD before you touch the threshold.
//
// TUNING THE THRESHOLD:
//   too many false triggers  -> raise it (0.8+), or pick a rarer word
//   it ignores you           -> lower it (0.65), or pick a longer word
// Run `npm run wake:test` to see exactly what your current setting accepts.
// ---------------------------------------------------------------------------
