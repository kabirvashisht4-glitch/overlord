// ---------------------------------------------------------------------------
// sh.js — run shell commands safely.
//
// THE MOST IMPORTANT SECURITY IDEA IN THIS WHOLE PROJECT:
//
// An LLM is producing the arguments here. An LLM can be tricked (someone says
// something weird, a webpage says "ignore your instructions"). If you build
// a command by gluing strings together:
//
//     exec(`open -a ${appName}`)          // <-- NEVER DO THIS
//
// ...and appName is `Safari; rm -rf ~/Documents`, you just deleted your
// documents. That's called SHELL INJECTION. Same family of bug as SQL
// injection, which you'll meet in your MongoDB/Express work.
//
// The fix is to never build a command string at all. `execFile` takes the
// program and its arguments as SEPARATE values. The OS hands the array
// straight to the program — no shell parses it, so `;` and `|` and `&&`
// are just ordinary characters with no power.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a program with an array of arguments. No shell involved.
 * @param {string} cmd  program name, e.g. "open"
 * @param {string[]} args  arguments, e.g. ["-a", "Spotify"]
 */
export async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 15000,
      ...opts,
    });
    return { ok: true, out: (stdout || "").trim() };
  } catch (err) {
    return { ok: false, out: "", error: err.message };
  }
}

/**
 * Run an AppleScript snippet. This is macOS's built-in automation language —
 * it can control basically any Mac app (Spotify, Music, Finder, System
 * Events for keystrokes). This is your single biggest lever for "control
 * the local device" and it costs zero libraries.
 *
 * Note we pass the script via `-e` as one argument — still no shell.
 * Do NOT interpolate untrusted text directly into a script body; use
 * `applescriptWithArgs` below for that.
 */
export async function osascript(script) {
  return run("osascript", ["-e", script]);
}

/**
 * Safer AppleScript: passes user data as `argv` instead of splicing it into
 * the script text. Inside the script you read them via `item 1 of argv`.
 */
export async function osascriptWithArgs(script, args = []) {
  return run("osascript", ["-e", script, ...args.map(String)]);
}
