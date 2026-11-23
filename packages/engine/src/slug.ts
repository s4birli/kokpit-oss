// Turns a free-form card name into a string safe to use as a directory name and
// as part of a git branch name: [a-z0-9] runs joined by single dashes.

const TURKISH: Record<string, string> = {
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ü: "u",
  Ü: "u",
  ç: "c",
  Ç: "c",
};

function trimDashes(s: string): string {
  return s.replace(/^-+|-+$/g, "");
}

export function slugify(name: string, maxLen: number, fallback: string): string {
  const mapped = name.replace(/[şŞğĞıIİöÖüÜçÇ]/g, (ch) => TURKISH[ch] ?? ch);
  const ascii = mapped.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const dashed = trimDashes(ascii.replace(/[^a-z0-9]+/g, "-"));
  const cut = trimDashes(dashed.slice(0, Math.max(0, maxLen)));
  return cut === "" ? fallback : cut;
}
