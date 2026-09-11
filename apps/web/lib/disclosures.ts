/**
 * A small parser for docs/DISCLOSURES.md: a title, intro paragraphs, `##`
 * sections of numbered items whose lead sentence is bold, inline `code` and
 * **bold**. The /disclosures page renders its output at build time, so the
 * page stays word for word the document.
 */

export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "strong"; children: Inline[] };

export interface DisclosureItem {
  n: number;
  /** The bold lead sentence, when the item starts with one. */
  lead: Inline[] | null;
  /** Exactly what sits between the lead and the body in the source ("" before a comma, " " usually). */
  sep: string;
  body: Inline[];
}

export interface DisclosureSection {
  id: string;
  title: string;
  items: DisclosureItem[];
  paragraphs: Inline[][];
}

export interface Disclosures {
  title: string;
  intro: Inline[][];
  sections: DisclosureSection[];
}

/** `code` first (its content is literal), then **bold** (its content may hold code). */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else out.push({ t: "strong", children: parseInline(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Plain text of inline nodes (for search, labels and tests). */
export function plainText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "strong" ? plainText(n.children) : n.v)).join("");
}

export function parseDisclosures(md: string): Disclosures {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  const intro: Inline[][] = [];
  const sections: DisclosureSection[] = [];
  let buf: string[] = [];
  let item: { n: number; text: string[] } | null = null;

  const current = () => sections[sections.length - 1];
  const flushItem = () => {
    if (!item || !current()) return;
    const text = item.text.join(" ").trim();
    const m = /^\*\*(.+?)\*\*(\s*)(.*)$/.exec(text);
    current().items.push({ n: item.n, lead: m ? parseInline(m[1]) : null, sep: m ? m[2] : "", body: parseInline(m ? m[3] : text) });
    item = null;
  };
  const flushPara = () => {
    const text = buf.join(" ").trim();
    buf = [];
    if (!text) return;
    if (current()) current().paragraphs.push(parseInline(text));
    else intro.push(parseInline(text));
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    const li = /^(\d+)\.\s+(.*)$/.exec(line);
    if (h1 && !title) {
      title = h1[1].trim();
    } else if (h2) {
      flushItem();
      flushPara();
      sections.push({ id: slug(h2[1]), title: h2[1].trim(), items: [], paragraphs: [] });
    } else if (li && current()) {
      flushItem();
      flushPara();
      item = { n: Number(li[1]), text: [li[2]] };
    } else if (!line.trim()) {
      flushItem();
      flushPara();
    } else if (item) {
      item.text.push(line.trim());
    } else {
      buf.push(line.trim());
    }
  }
  flushItem();
  flushPara();
  return { title, intro, sections };
}
