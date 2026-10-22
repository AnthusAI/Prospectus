import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SPAM_RULES,
  ownText,
  safeScore,
  scoreInquiry,
  spamLabellingForMode,
  tokenShape,
  type SpamInput,
} from "../server/intake-spam";
import { BOT_SHAPED, TEMPLATE_ONLY, exampleMailRules } from "./fixtures/intake-spam";

const demo = (changes: Partial<SpamInput> = {}): SpamInput => ({
  kind: "demo",
  name: "Alex Example",
  email: "alex@example.com",
  company: "Example Studio",
  message: "We review about 2,000 contracts a month and want to see the Papyrus demo.",
  honeypot_filled: false,
  ...changes,
});

test("the shipped rules file is versioned and only Gmail addresses are dot-insensitive", () => {
  const file = JSON.parse(readFileSync("config/intake-spam-rules.json", "utf8"));
  assert.equal(file.rules_version, "intake-spam-rules-1");
  assert.deepEqual(SPAM_RULES.gmail.domains, ["gmail.com", "googlemail.com"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(SPAM_RULES.rules).map(([code, rule]) => [code, rule.weight])),
    {
      gibberish_name: 0.55,
      gibberish_company: 0.35,
      template_only_message: 0.4,
      markup_or_links: 0.55,
      gmail_dot_scatter: 0.2,
      honeypot: 0.9,
      fast_submit: 0.2,
    },
  );
  assert.equal(SPAM_RULES.thresholds.likely_spam, 0.7);
  assert.equal(SPAM_RULES.thresholds.min_reasons, 2);
  assert.equal(SPAM_RULES.thresholds.min_strong_reasons, 1);
  assert.equal(SPAM_RULES.thresholds.protected_own_letters, 40);
  // The shipped gmail rule ignores the same address on any other domain.
  assert.equal(scoreInquiry(BOT_SHAPED).reasons.includes("gmail_dot_scatter"), false);
});

test("the 2026-10-20 bot submission's feature vector scores likely_spam at 0.784", () => {
  assert.deepEqual(tokenShape(BOT_SHAPED.name), {
    length: 22,
    case_switches: 6,
    longest_consonant_run: 11,
    vowel_share: 0.23,
  });
  const result = scoreInquiry(BOT_SHAPED, exampleMailRules);
  assert.deepEqual(result.reasons, ["gibberish_name", "template_only_message", "gmail_dot_scatter"]);
  assert.equal(result.score, 0.784);
  assert.equal(result.verdict, "likely_spam");
  assert.equal(result.protected, false);
  assert.deepEqual(result.evidence, {
    gibberish_name: { length: 22, case_switches: 6, longest_consonant_run: 11, vowel_share: 0.23 },
    template_only_message: { prompts: 4, own_letters: 0 },
    gmail_dot_scatter: {
      local_length: 21,
      dots: 8,
      dot_share: 0.38,
      segments: 9,
      single_character_segments: 5,
    },
  });
  // Evidence is counts and lengths only: no measured text survives.
  const flat = JSON.stringify(result.evidence);
  for (const value of Object.values(result.evidence).flatMap((entry) => Object.values(entry!)))
    assert.equal(typeof value, "number");
  for (const fragment of ["qRtv", "Qorvex", "example.com", "Solution", "Came from"])
    assert.equal(flat.includes(fragment), false);
  // The six-letter company stem is not a gibberish token.
  assert.equal(result.reasons.includes("gibberish_company"), false);
});

test("one signal alone is never likely_spam, and the strong pairs match the design", () => {
  const verdict = (input: SpamInput) => scoreInquiry(input, exampleMailRules);
  const onlyDots = verdict(demo({ email: BOT_SHAPED.email }));
  assert.deepEqual(onlyDots.reasons, ["gmail_dot_scatter"]);
  assert.equal(onlyDots.verdict, "clean");
  const onlyTemplate = verdict(demo({ message: TEMPLATE_ONLY }));
  assert.deepEqual(onlyTemplate.reasons, ["template_only_message"]);
  assert.equal(onlyTemplate.verdict, "uncertain");
  const onlyName = verdict(demo({ name: BOT_SHAPED.name }));
  assert.deepEqual(onlyName.reasons, ["gibberish_name"]);
  assert.equal(onlyName.verdict, "uncertain");
  // Gmail dots and a template-only message: 0.52, uncertain. Name and template: 0.73, likely.
  assert.equal(verdict(demo({ email: BOT_SHAPED.email, message: TEMPLATE_ONLY })).verdict, "uncertain");
  const pair = verdict(demo({ name: BOT_SHAPED.name, message: TEMPLATE_ONLY }));
  assert.equal(pair.score, 0.73);
  assert.equal(pair.verdict, "likely_spam");
  // Medium and weak reasons alone never reach likely_spam: 0.36 here.
  const weak = verdict(demo({ email: BOT_SHAPED.email, elapsed_ms: 400 }));
  assert.deepEqual(weak.reasons, ["gmail_dot_scatter", "fast_submit"]);
  assert.equal(weak.verdict, "uncertain");
});

test("real names are never measured as machine-generated", () => {
  for (const name of [
    "Li",
    "Bo Ng",
    "Ryan McDonald",
    "DeAndre O'Neil",
    "Krzysztof Szczepański",
    "Xu Zhengqi",
    "Nguyen Van An",
    "MARIA GARCIA",
    "maria garcia",
    "Jean-Baptiste Dupont-Aignan",
    "Αλέξανδρος Παπαδόπουλος",
    "山田太郎",
    "MacKenzieDeVries",
  ])
    assert.equal(scoreInquiry(demo({ name })).reasons.includes("gibberish_name"), false, name);
  for (const company of ["PayPal", "DeepMind Technologies", "McKinsey & Company", "Example GmbH"])
    assert.equal(scoreInquiry(demo({ company })).reasons.includes("gibberish_company"), false, company);
});

test("40 letters of the visitor's own text cap the verdict at uncertain unless markup, links or the honeypot fire", () => {
  const note = `${TEMPLATE_ONLY.split("\n")[0]}Contract review for our legal operations team, about two thousand a month.`;
  assert.ok(
    (ownText(note).text.match(/\p{L}/gu) ?? []).length >= 40,
    "the note has 40 or more letters of own text",
  );
  const realPerson = scoreInquiry(
    demo({ name: BOT_SHAPED.name, email: BOT_SHAPED.email, company: "QwXrtPlKmnZbVcd", message: note }),
    exampleMailRules,
  );
  assert.deepEqual(realPerson.reasons, ["gibberish_name", "gibberish_company", "gmail_dot_scatter"]);
  assert.ok(realPerson.score >= 0.7);
  assert.equal(realPerson.verdict, "uncertain");
  assert.equal(realPerson.protected, true);

  // 39 letters is not protected.
  const short = scoreInquiry(
    demo({ name: BOT_SHAPED.name, company: "QwXrtPlKmnZbVcd", message: "a".repeat(39) }),
    exampleMailRules,
  );
  assert.equal(short.verdict, "likely_spam");

  const links = `${note}\nhttps://one.example.com https://two.example.com https://three.example.com`;
  assert.equal(scoreInquiry(demo({ name: BOT_SHAPED.name, message: links })).verdict, "likely_spam");
  const markup = `${note}\n[url=https://example.com]cheap[/url]`;
  assert.equal(scoreInquiry(demo({ name: BOT_SHAPED.name, message: markup })).verdict, "likely_spam");
  assert.equal(scoreInquiry(demo({ message: note, honeypot_filled: true })).verdict, "likely_spam");
  // One or two links (often the sender's own site) never fire.
  assert.deepEqual(
    scoreInquiry(demo({ message: `${note}\nhttps://example.com https://example.com/about` })).reasons,
    [],
  );
});

test("a filled honeypot is always likely_spam, even as the only reason", () => {
  const result = scoreInquiry(demo({ honeypot_filled: true }));
  assert.deepEqual(result.reasons, ["honeypot"]);
  assert.equal(result.score, 0.9);
  assert.equal(result.verdict, "likely_spam");
  assert.deepEqual(result.evidence, { honeypot: { filled: 1 } });
});

test("a vendor pitch is a hint for a person, never a spam reason", () => {
  const pitch = scoreInquiry(
    demo({ message: "Hello, we offer affordable SEO services and backlinks to rank your website higher." }),
  );
  assert.deepEqual(pitch.reasons, []);
  assert.deepEqual(pitch.hints, ["vendor_pitch"]);
  assert.equal(pitch.verdict, "clean");
  assert.deepEqual(pitch.evidence, { vendor_pitch: { phrases: 3 } });
});

test("timing is a weak signal only when present and in range", () => {
  assert.deepEqual(scoreInquiry(demo({ elapsed_ms: 900 })).reasons, ["fast_submit"]);
  assert.deepEqual(scoreInquiry(demo({ elapsed_ms: 900 })).evidence, { fast_submit: { elapsed_ms: 900 } });
  for (const elapsed_ms of [1500, 60_000, undefined, -1, 1.5])
    assert.deepEqual(scoreInquiry(demo({ elapsed_ms })).reasons, [], String(elapsed_ms));
});

test("waitlists use the same scorer without the message rules", () => {
  const signup: SpamInput = {
    kind: "waitlist",
    name: BOT_SHAPED.name,
    email: BOT_SHAPED.email,
    company: "",
    message: TEMPLATE_ONLY,
    honeypot_filled: false,
  };
  const result = scoreInquiry(signup, exampleMailRules);
  assert.deepEqual(result.reasons, ["gibberish_name", "gmail_dot_scatter"]);
  assert.equal(result.verdict, "uncertain");
  assert.equal(scoreInquiry({ ...signup, name: "", email: "casey@example.com" }).verdict, "clean");
  assert.equal(scoreInquiry({ ...signup, honeypot_filled: true }).verdict, "likely_spam");
});

test("the template rule strips only the prompts, the Came from line and a single-word solution", () => {
  assert.deepEqual(ownText(TEMPLATE_ONLY), { text: "", prompts: 4 });
  assert.deepEqual(ownText(TEMPLATE_ONLY.replace("problem: ", "problem: Primus")), { text: "", prompts: 4 });
  assert.equal(
    ownText(TEMPLATE_ONLY.replace("problem: ", "problem: Contract review")).text,
    "Contract review",
  );
  // A short message with no prompts is not "template only".
  assert.deepEqual(scoreInquiry(demo({ message: "hi" })).reasons, []);
});

test("scoring is deterministic and a scorer failure is unscored, which files as clean", () => {
  assert.deepEqual(scoreInquiry(BOT_SHAPED, exampleMailRules), scoreInquiry(BOT_SHAPED, exampleMailRules));
  const failed = safeScore(BOT_SHAPED, () => {
    throw new Error("boom");
  });
  assert.deepEqual(failed, {
    score: 0,
    verdict: "unscored",
    reasons: ["scorer_error"],
    hints: [],
    evidence: {},
    protected: false,
  });
  assert.equal(safeScore(BOT_SHAPED, () => ({ verdict: "maybe" }) as never).verdict, "unscored");
  assert.equal(
    safeScore(BOT_SHAPED, () => ({ ...scoreInquiry(BOT_SHAPED), score: NaN })).verdict,
    "unscored",
  );
});

test("the labelling flag accepts only shadow and label, and defaults to shadow", () => {
  assert.equal(spamLabellingForMode(undefined), "shadow");
  assert.equal(spamLabellingForMode(""), "shadow");
  assert.equal(spamLabellingForMode("label"), "label");
  assert.throws(() => spamLabellingForMode("off"), /Unknown spam labelling/);
  const deployment = JSON.parse(readFileSync("evaluation-deployment.json", "utf8"));
  assert.equal(deployment.spamLabelling, "shadow", "the rollout starts in shadow mode");
});
