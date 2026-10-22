import shippedRules from "../config/intake-spam-rules.json";
export { spamLabellingForMode, type SpamLabelling } from "./intake-spam-mode";

/**
 * Layer-1 intake spam scoring: a pure, local, deterministic check over an inquiry that is already
 * durably stored. It never sends data anywhere, never logs input text, and its evidence holds
 * counts and lengths only. See docs/INTAKE_SPAM.md.
 */

export type SpamReason =
  | "gibberish_name"
  | "gibberish_company"
  | "template_only_message"
  | "markup_or_links"
  | "gmail_dot_scatter"
  | "honeypot"
  | "fast_submit";
export type SpamHint = "vendor_pitch";
export type SpamVerdict = "clean" | "uncertain" | "likely_spam" | "unscored";
export type SpamStrength = "strong" | "medium" | "weak";

export interface SpamRules {
  rules_version: string;
  thresholds: {
    likely_spam: number;
    uncertain: number;
    min_reasons: number;
    min_strong_reasons: number;
    protected_own_letters: number;
    protection_exempt: string[];
  };
  rules: Record<SpamReason, { weight: number; strength: SpamStrength }>;
  gibberish: {
    min_token_length: number;
    min_case_switches: number;
    max_vowel_share: number;
    min_consonant_run: number;
  };
  template: {
    prompts: string[];
    solution_prompt: string;
    came_from_pattern: string;
    max_own_letters: number;
  };
  links: { min_urls: number };
  gmail: {
    domains: string[];
    min_dots: number;
    min_dot_share: number;
    min_dots_for_share: number;
    min_single_character_segments: number;
  };
  fast_submit: { max_elapsed_ms: number };
  vendor_pitch: { phrases: string[] };
}

export const SPAM_RULES = shippedRules as SpamRules;
export const SPAM_REASONS = Object.keys(SPAM_RULES.rules) as SpamReason[];
/** The largest accepted `elapsed_ms`: one day. */
export const MAX_ELAPSED_MS = 86_400_000;

/** What the scorer reads. Built from the stored inquiry, so a refile scores exactly the same. */
export interface SpamInput {
  kind: "demo" | "contact" | "waitlist" | "newsletter";
  name: string;
  email: string;
  company: string;
  message: string;
  honeypot_filled: boolean;
  elapsed_ms?: number;
}

/** Counts and lengths only; never the measured text. */
export type SpamEvidence = Partial<Record<SpamReason | SpamHint, Record<string, number>>>;

export interface SpamResult {
  score: number;
  verdict: SpamVerdict;
  reasons: string[];
  hints: SpamHint[];
  evidence: SpamEvidence;
  /** True when the 40-letter protection capped a likely_spam verdict at uncertain. */
  protected: boolean;
}

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const LATIN_TOKEN = /^\p{Script=Latin}+$/u;
const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

export interface TokenShape {
  length: number;
  case_switches: number;
  longest_consonant_run: number;
  vowel_share: number;
}

/** The shape of one name or company token. Only Latin-script letter tokens are measured. */
export function tokenShape(token: string): TokenShape | null {
  if (!LATIN_TOKEN.test(token)) return null;
  const chars = [...token];
  let switches = 0;
  let run = 0;
  let longest = 0;
  let vowels = 0;
  chars.forEach((char, index) => {
    const previous = chars[index - 1];
    if (
      previous &&
      previous !== previous.toUpperCase() &&
      previous === previous.toLowerCase() &&
      char !== char.toLowerCase() &&
      char === char.toUpperCase()
    )
      switches++;
    const base = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (VOWELS.has(base)) {
      vowels++;
      run = 0;
    } else longest = Math.max(longest, ++run);
  });
  return {
    length: chars.length,
    case_switches: switches,
    longest_consonant_run: longest,
    vowel_share: round(vowels / chars.length, 2),
  };
}

function gibberish(field: string, rules: SpamRules): TokenShape | null {
  const g = rules.gibberish;
  let found: TokenShape | null = null;
  for (const token of field.split(/\s+/)) {
    const shape = tokenShape(token);
    if (
      shape &&
      shape.length >= g.min_token_length &&
      shape.case_switches >= g.min_case_switches &&
      (shape.vowel_share < g.max_vowel_share || shape.longest_consonant_run >= g.min_consonant_run) &&
      (!found || shape.case_switches > found.case_switches)
    )
      found = shape;
  }
  return found;
}

/**
 * The visitor's own text: the message with the engage form's prefilled prompts, its "Came from"
 * line and a single-word solution the link filled in removed.
 */
export function ownText(message: string, rules: SpamRules = SPAM_RULES): { text: string; prompts: number } {
  const t = rules.template;
  const cameFrom = new RegExp(t.came_from_pattern, "i");
  const kept: string[] = [];
  let prompts = 0;
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    if (cameFrom.test(line)) continue;
    const prompt = t.prompts.find((candidate) => line.toLowerCase().startsWith(candidate.toLowerCase()));
    if (!prompt) {
      kept.push(line);
      continue;
    }
    prompts++;
    const answer = line.slice(prompt.length).trim();
    if (prompt === t.solution_prompt && /^[A-Za-z][\w.-]{0,29}$/.test(answer)) continue;
    kept.push(answer);
  }
  return { text: kept.join("\n").trim(), prompts };
}

/**
 * Scores one inquiry. Pure and deterministic: the same input and rules always give the same result.
 * Throws only on a programming error; callers use `safeScore`.
 */
export function scoreInquiry(input: SpamInput, rules: SpamRules = SPAM_RULES): SpamResult {
  const fired = new Map<SpamReason, Record<string, number>>();
  const name = gibberish(input.name, rules);
  if (name) fired.set("gibberish_name", { ...name });
  const company = gibberish(input.company, rules);
  if (company) fired.set("gibberish_company", { ...company });

  let ownLetters = 0;
  // Waitlist and newsletter signups have no message, so the message rules never apply to them.
  const hasMessage = input.kind === "demo" || input.kind === "contact";
  if (hasMessage) {
    const own = ownText(input.message, rules);
    ownLetters = letters(own.text);
    if (own.prompts > 0 && ownLetters <= rules.template.max_own_letters)
      fired.set("template_only_message", { prompts: own.prompts, own_letters: ownLetters });
    const urls = (input.message.match(/(?:https?:\/\/|www\.)\S+/gi) ?? []).length;
    const bbcode = (input.message.match(/\[url[=\]]/gi) ?? []).length;
    const anchors = (input.message.match(/<a\s[^>]*href/gi) ?? []).length;
    if (bbcode > 0 || anchors > 0 || urls >= rules.links.min_urls)
      fired.set("markup_or_links", { urls, bbcode, html_links: anchors });
  }

  const at = input.email.lastIndexOf("@");
  const local = at > 0 ? input.email.slice(0, at) : "";
  const domain = at > 0 ? input.email.slice(at + 1).toLowerCase() : "";
  if (local && rules.gmail.domains.includes(domain)) {
    const g = rules.gmail;
    const dots = [...local].filter((char) => char === ".").length;
    const share = dots / local.length;
    const segments = local.split(".");
    const singles = segments.filter((segment) => segment.length === 1).length;
    if (
      dots >= g.min_dots ||
      (dots >= g.min_dots_for_share && share >= g.min_dot_share) ||
      singles >= g.min_single_character_segments
    )
      fired.set("gmail_dot_scatter", {
        local_length: local.length,
        dots,
        dot_share: round(share, 2),
        segments: segments.length,
        single_character_segments: singles,
      });
  }

  if (input.honeypot_filled) fired.set("honeypot", { filled: 1 });
  if (
    input.elapsed_ms !== undefined &&
    Number.isInteger(input.elapsed_ms) &&
    input.elapsed_ms >= 0 &&
    input.elapsed_ms < rules.fast_submit.max_elapsed_ms
  )
    fired.set("fast_submit", { elapsed_ms: input.elapsed_ms });

  const hints: SpamHint[] = [];
  const evidence: SpamEvidence = Object.fromEntries(fired);
  if (hasMessage) {
    const lower = input.message.toLowerCase();
    const matches = rules.vendor_pitch.phrases.filter((phrase) => lower.includes(phrase)).length;
    if (matches > 0) {
      hints.push("vendor_pitch");
      evidence.vendor_pitch = { phrases: matches };
    }
  }

  const reasons = [...fired.keys()];
  const score = round(1 - reasons.reduce((product, reason) => product * (1 - rules.rules[reason].weight), 1));
  const strong = reasons.filter((reason) => rules.rules[reason].strength === "strong").length;
  const t = rules.thresholds;
  let verdict: SpamVerdict =
    // Decision 4: a filled honeypot is always labelled, even as the only reason.
    fired.has("honeypot") ||
    (score >= t.likely_spam && reasons.length >= t.min_reasons && strong >= t.min_strong_reasons)
      ? "likely_spam"
      : score >= t.uncertain
        ? "uncertain"
        : "clean";
  let isProtected = false;
  if (
    verdict === "likely_spam" &&
    ownLetters >= t.protected_own_letters &&
    !reasons.some((reason) => t.protection_exempt.includes(reason))
  ) {
    verdict = "uncertain";
    isProtected = true;
  }
  return { score, verdict, reasons, hints, evidence, protected: isProtected };
}

/** Any scorer failure is "unscored", which every caller treats exactly as clean. */
export function safeScore<T = SpamInput>(
  input: T,
  scorer: (input: T) => SpamResult = scoreInquiry as unknown as (input: T) => SpamResult,
): SpamResult {
  try {
    const result = scorer(input);
    if (
      !result ||
      !["clean", "uncertain", "likely_spam"].includes(result.verdict) ||
      !Number.isFinite(result.score) ||
      !Array.isArray(result.reasons)
    )
      throw new Error("invalid scorer result");
    return result;
  } catch {
    return {
      score: 0,
      verdict: "unscored",
      reasons: ["scorer_error"],
      hints: [],
      evidence: {},
      protected: false,
    };
  }
}
