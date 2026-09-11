import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { parseDisclosures, parseInline, plainText } from "../lib/disclosures";

const MD = fs.readFileSync(path.join(__dirname, "../../../docs/DISCLOSURES.md"), "utf8");
const strip = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "");

describe("disclosures: docs/DISCLOSURES.md", () => {
  const doc = parseDisclosures(MD);

  it("keeps the title and the intro", () => {
    expect(doc.title).to.equal("BLACKBOX disclosures");
    expect(doc.intro.length).to.be.greaterThan(0);
    expect(plainText(doc.intro[0])).to.match(/^Plain statements about what BLACKBOX hides/);
  });

  it("keeps every section and every numbered statement, in order", () => {
    const headings = MD.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
    expect(doc.sections.map((s) => s.title)).to.deep.equal(headings);
    const numbers = doc.sections.flatMap((s) => s.items.map((i) => i.n));
    const expected = MD.split("\n")
      .map((l) => /^(\d+)\.\s/.exec(l))
      .filter(Boolean)
      .map((m) => Number(m![1]));
    expect(numbers).to.deep.equal(expected);
    expect(numbers.length).to.be.greaterThan(30);
  });

  it("renders each statement word for word (markup removed)", () => {
    const raw = new Map<number, string>();
    let cur: number | null = null;
    for (const line of MD.split("\n")) {
      const m = /^(\d+)\.\s+(.*)$/.exec(line);
      if (m) {
        cur = Number(m[1]);
        raw.set(cur, m[2]);
      } else if (!line.trim() || line.startsWith("#")) cur = null;
      else if (cur !== null) raw.set(cur, `${raw.get(cur)} ${line.trim()}`);
    }
    for (const s of doc.sections) {
      for (const it of s.items) {
        const text = `${it.lead ? `${plainText(it.lead)}${it.sep}` : ""}${plainText(it.body)}`.trim();
        expect(text, `item ${it.n}`).to.equal(strip(raw.get(it.n)!).trim());
      }
    }
  });

  it("splits the bold lead from the body", () => {
    const first = doc.sections[0].items[0];
    expect(plainText(first.lead!)).to.equal("Nothing here is mainnet.");
    const notClaimed = doc.sections.find((s) => s.title === "Not claimed")!;
    expect(notClaimed.items[0].lead).to.equal(null);
    // "**After the round**, the private bodies ..." keeps the comma tight against the lead.
    const twelve = doc.sections.flatMap((s) => s.items).find((i) => i.n === 12)!;
    expect(plainText(twelve.lead!)).to.equal("After the round");
    expect(twelve.sep).to.equal("");
    expect(plainText(twelve.body)).to.match(/^, the private bodies/);
  });
});

describe("disclosures: inline markup", () => {
  it("parses code and bold, including code inside bold", () => {
    expect(parseInline("a `b` c")).to.deep.equal([
      { t: "text", v: "a " },
      { t: "code", v: "b" },
      { t: "text", v: " c" },
    ]);
    expect(parseInline("**x `y`** z")).to.deep.equal([
      {
        t: "strong",
        children: [
          { t: "text", v: "x " },
          { t: "code", v: "y" },
        ],
      },
      { t: "text", v: " z" },
    ]);
    expect(parseInline("`**not bold**`")).to.deep.equal([{ t: "code", v: "**not bold**" }]);
  });
});
