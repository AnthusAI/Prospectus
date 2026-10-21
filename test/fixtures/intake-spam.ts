import { SPAM_RULES, type SpamInput, type SpamRules } from "../../server/intake-spam";

/**
 * The scorer only sees strings, but test data uses @example.com addresses only. These rules treat
 * example.com as a dot-insensitive mailbox exactly as the shipped rules treat gmail.com.
 */
export const exampleMailRules: SpamRules = {
  ...SPAM_RULES,
  gmail: { ...SPAM_RULES.gmail, domains: ["example.com"] },
};

/** The four prefilled engage prompts with nothing typed, plus the "Came from" line. */
export const TEMPLATE_ONLY =
  "Solution or problem: \nRough volume or scale: \nDo you have an AWS account (yes/no): \nTimeline: \n(Came from: /solutions/example)";

/**
 * A synthetic stand-in for the 2026-10-20 bot submission: the same measured shapes, made-up values.
 * Name: 22 letters, 6 lower-to-upper switches, an 11-letter consonant run, vowel share 0.23.
 * Email: a 21-character local part with 8 dots in nine segments of one or two characters, ending in digits.
 */
export const BOT_SHAPED: SpamInput = {
  kind: "demo",
  name: "qRtvKlmnPsXaeGhoiTuwbd",
  email: "q.x.vo.r.tk.e.lu.w.42@example.com",
  company: "Qorvex LLC",
  message: TEMPLATE_ONLY,
  honeypot_filled: false,
};
