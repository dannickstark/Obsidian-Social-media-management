const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatShortDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}

export function monthTitle(year: number, month: number, locale?: string): string {
  return new Date(year, month, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
}

export function weekTitle(from: number, to: number, locale?: string): string {
  const a = new Date(from).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const b = new Date(to).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  return `${a} – ${b}`;
}

export function initials(name: string): string {
  const words = name.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}
