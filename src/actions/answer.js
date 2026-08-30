// ---------------------------------------------------------------------------
// ACTION: answer
//
// CONCEPT: THE ESCAPE HATCH.
//
// Most beginner agents break on inputs that aren't commands at all —
// "hey", "what's 2+2", "never mind". Without a fallback the router either
// crashes or forces a wrong action ("open app called 'never mind'").
//
// So we give the model a legitimate way to say "no tool needed, just talk".
// Every agent you ever build needs one of these. It converts a whole class
// of crashes into a normal reply.
// ---------------------------------------------------------------------------

export default {
  name: "answer",

  description:
    "Reply in words without touching the computer. Use for greetings, small talk, " +
    "quick factual answers, arithmetic, or when the user's request doesn't match " +
    "any other action. Also use this to say you didn't understand.",

  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "What to say back. One or two short sentences — it will be spoken aloud.",
      },
    },
    required: ["text"],
  },

  async run({ text }) {
    return text;
  },
};
