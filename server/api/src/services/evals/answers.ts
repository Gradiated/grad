/**
 * A number: commas only as thousands separators ("1,018", not the list
 * "2,3,5"), and a minus only as a sign (not the dash of a range, "3-5").
 */
const NUMBER = /(?<!\d)-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

const lastNumber = (text: string): number | null => {
  const marked = text.split("####");
  const tail = marked.length > 1 ? (marked[marked.length - 1] as string) : text;
  const matches = tail.match(NUMBER);
  const last = matches?.[matches.length - 1];
  if (last === undefined) return null;
  const value = Number(last.replace(/,/g, ""));

  return Number.isFinite(value) ? value : null;
};

/** GSM8K-style: the final number (after `####` when present) equals the reference. */
export const finalNumberMatches = (
  output: string,
  reference: string | null,
): boolean => {
  if (reference === null) return false;
  const want = lastNumber(reference);
  const got = lastNumber(output);

  return want !== null && got !== null && Math.abs(want - got) < 1e-6;
};

/**
 * "Answer: C", "The answer is (b)", "**D**": a letter in parentheses may be
 * lower case, a bare one must be a capital ("the answer is a bit…" names no
 * option), and a bare "I" followed by a word is the pronoun ("Answer: I
 * think B").
 */
const CHOICE_PATTERNS = [
  /(?:[Aa]nswer|ANSWER)(?:\s+is)?\s*[:：]?\s*(?:\(([A-Pa-p])\)|\**([A-HJ-P]|I(?!\s+[a-z]|['’]))\b)/,
  /^\s*\(?([A-P])[).:\s]*$/,
  /^\s*\(?([A-P])[).:]/,
];

/** Multiple choice: the chosen letter ("Answer: C", "(C)", "C.") equals the reference. */
export const choiceMatches = (
  output: string,
  reference: string | null,
): boolean => {
  if (reference === null) return false;
  const want = reference.trim().toUpperCase();
  for (const pattern of CHOICE_PATTERNS) {
    const match = pattern.exec(output);
    const letter = match?.[1] ?? match?.[2];
    if (letter) return letter.toUpperCase() === want;
  }

  return false;
};
