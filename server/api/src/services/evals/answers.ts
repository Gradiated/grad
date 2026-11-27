const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

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

const CHOICE_PATTERNS = [
  /answer(?:\s+is)?\s*[:：]?\s*\(?\**([A-P])\b/i,
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
    if (match?.[1]) return match[1].toUpperCase() === want;
  }

  return false;
};
