/**
 * Telegram message packing shared by the daily digest and the push layer.
 *
 * Both surfaces used to emit one message per item (a batch of 12 picks = 12 pings).
 * The user wants the whole batch inside ONE message. Telegram's 4096-char cap counts
 * only the visible text — a link's URL lives in the link entity, not the text — so with
 * HTML links a single message holds 40-90 items. Titles are shortened in stages first
 * (a trimmed title always beats a second message) and only a truly huge day spills over.
 */

export const TG_TEXT_LIMIT = 4000;
/** Room for the header line and the trailing footer link */
export const TG_HEADER_RESERVE = 60;
/** Progressively shorter title caps, tried in order */
export const TITLE_CAPS = [110, 96, 80, 64, 48];

export type PackItem = { title: string; url: string };

export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanTitle(title: string): string {
  const raw = (title || "").replace(/\s+/g, " ").trim();
  return raw || "(untitled)";
}

function titleFor(title: string, cap: number): string {
  const raw = cleanTitle(title);
  if (raw.length <= cap) return raw;
  return raw.slice(0, cap - 1).trimEnd() + "…";
}

function linkLine(item: PackItem, index: number, cap: number): string {
  const url = htmlEscape(item.url || "").replace(/"/g, "&quot;");
  return index + '. <a href="' + url + '">' + htmlEscape(titleFor(item.title, cap)) + "</a>";
}

/** Only the visible text counts against Telegram's cap: "N. title" */
function visibleLen(item: PackItem, index: number, cap: number): number {
  return String(index).length + 2 + titleFor(item.title, cap).length;
}

/**
 * One numbered, hyperlinked line per item, packed into the fewest messages possible.
 * Returned messages are already part-labelled by `headerFor`; parts > 1 only when the
 * list cannot physically fit into a single message.
 */
export function packItemMessages(
  items: PackItem[],
  headerFor: (part: number, parts: number) => string,
  footerFor?: (part: number, parts: number) => string,
): string[] {
  if (!items.length) return [];
  const headerLen = Math.max(headerFor(1, 1).length, headerFor(99, 99).length);
  const footerLen = footerFor ? footerFor(1, 1).length + 1 : 0;
  const budget = Math.max(400, TG_TEXT_LIMIT - TG_HEADER_RESERVE - headerLen - footerLen);

  let packed: string[] = [];
  for (const cap of TITLE_CAPS) {
    const chunks: string[][] = [];
    let lines: string[] = [];
    let used = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      const cost = visibleLen(item, i + 1, cap) + 1;
      if (lines.length && used + cost > budget) {
        chunks.push(lines);
        lines = [];
        used = 0;
      }
      lines.push(linkLine(item, i + 1, cap));
      used += cost;
    }
    if (lines.length) chunks.push(lines);
    const parts = chunks.length;
    packed = chunks.map((body, idx) => {
      const head = headerFor(idx + 1, parts);
      const foot = footerFor ? footerFor(idx + 1, parts) : "";
      return [head, ...body, foot].filter((x) => x !== "").join("\n");
    });
    if (packed.length <= 1) return packed;
  }
  return packed;
}
