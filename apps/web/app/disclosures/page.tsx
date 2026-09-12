import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { parseDisclosures, type Inline } from "../../lib/disclosures";
import { Shell } from "../../components/shell";

export const metadata: Metadata = { title: "Disclosures" };

/** docs/DISCLOSURES.md, found by walking up from the app directory. Read at build time. */
function loadMarkdown(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "docs", "DISCLOSURES.md");
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8");
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** "item 26" / "items 31-32" in the text become links to those items. */
function linkItems(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\b(items?) (\d+)(?:-(\d+))?/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a key={`${key}-${m.index}`} href={`#item-${m[2]}`} className="underline decoration-edge-strong underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-dim">
        {m[0]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Inlines({ nodes, k }: { nodes: Inline[]; k: string }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.t === "code" ? (
          <code key={`${k}-${i}`} className="bg-surface-2 px-1 py-px font-mono text-[12px] text-fg [overflow-wrap:anywhere]">
            {n.v}
          </code>
        ) : n.t === "strong" ? (
          <strong key={`${k}-${i}`} className="font-medium text-fg">
            <Inlines nodes={n.children} k={`${k}-${i}`} />
          </strong>
        ) : (
          <span key={`${k}-${i}`}>{linkItems(n.v, `${k}-${i}`)}</span>
        ),
      )}
    </>
  );
}

export default function DisclosuresPage() {
  const md = loadMarkdown();
  if (!md) {
    return (
      <Shell>
        <section className="border border-edge bg-surface px-4 py-10">
          <p className="label-caps !text-warn">Disclosures unavailable</p>
          <p className="mt-2 text-sm text-fg-muted">docs/DISCLOSURES.md was not found when this page was built.</p>
        </section>
      </Shell>
    );
  }
  const doc = parseDisclosures(md);
  const count = doc.sections.reduce((a, s) => a + s.items.length, 0);
  return (
    <Shell className="grid grid-cols-1 gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Sections" className="lg:sticky lg:top-16 lg:self-start">
        <div className="border border-edge bg-surface">
          <div className="border-b border-edge px-3 py-2 label-caps !text-fg-muted">Contents</div>
          <ol className="py-1">
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="flex min-h-9 items-center justify-between gap-2 px-3 text-xs text-fg-dim transition-colors duration-150 hover:bg-surface-2 hover:text-fg">
                  <span>{s.title}</span>
                  {s.items.length ? (
                    <span className="num text-[11px] text-fg-faint">
                      {s.items[0].n}
                      {s.items.length > 1 ? `-${s.items[s.items.length - 1].n}` : ""}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>

      <article className="flex min-w-0 flex-col gap-3">
        <header className="border border-edge bg-surface px-4 py-3">
          <h1 className="font-mono text-lg font-medium tracking-tight">{doc.title || "Disclosures"}</h1>
          {doc.intro.map((p, i) => (
            <p key={i} className="mt-2 max-w-[92ch] text-sm leading-6 text-fg-muted">
              <Inlines nodes={p} k={`intro-${i}`} />
            </p>
          ))}
          <p className="num mt-2 text-[11px] text-fg-dim">{count} statements · rendered from docs/DISCLOSURES.md when this page was built</p>
        </header>

        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="scroll-mt-16 border border-edge bg-surface">
            <h2 id={`${s.id}-title`} className="border-b border-edge px-3 py-2 label-caps !text-fg-muted">
              {s.title}
            </h2>
            {s.paragraphs.map((p, i) => (
              <p key={i} className="px-3 pt-3 text-sm leading-6 text-fg-muted">
                <Inlines nodes={p} k={`${s.id}-p${i}`} />
              </p>
            ))}
            <ol>
              {s.items.map((it) => (
                <li
                  key={it.n}
                  id={`item-${it.n}`}
                  className="grid scroll-mt-16 grid-cols-[2.25rem_minmax(0,1fr)] gap-2 border-t border-edge px-3 py-3 first:border-t-0 target:bg-surface-2"
                >
                  <a href={`#item-${it.n}`} className="num pt-0.5 text-xs text-fg-faint transition-colors duration-150 hover:text-fg" aria-label={`Disclosure ${it.n}`}>
                    {String(it.n).padStart(2, "0")}
                  </a>
                  <p className="max-w-[92ch] text-sm leading-6 text-fg-muted">
                    {it.lead ? (
                      <strong className="font-medium text-fg">
                        <Inlines nodes={it.lead} k={`i${it.n}-lead`} />
                      </strong>
                    ) : null}
                    {it.lead ? it.sep : null}
                    <Inlines nodes={it.body} k={`i${it.n}`} />
                  </p>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </article>
    </Shell>
  );
}
