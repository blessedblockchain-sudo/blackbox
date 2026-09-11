import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicLicenses, publicRoundInfo, sanitize, upsertLicenseRecord, withRoundFileLock } from "../lib/server/round-file";

function tmpRoundFile(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bx-web-"));
  const file = path.join(dir, "round-local.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      cluster: "local",
      round: "ROUND1",
      phase: "live",
      entrants: [{ name: "Momentum", owner: "A", bot: true, secretKey: [1, 2, 3] }],
      backers: [{ name: "Copycat", owner: "C", secretKey: [4, 5, 6] }],
      licenses: [{ name: "Copycat", buyer: "C", author: "A", bot: true, scheduled: true }],
      ...extra,
    }),
  );
  return { dir, file };
}

describe("round file: license records", () => {
  it("appends a record and keeps everything else", async () => {
    const { file } = tmpRoundFile();
    const added = await upsertLicenseRecord(file, "ROUND1", { name: "Web backer", buyer: "W", author: "A", bot: false, source: "web" });
    expect(added).to.equal(true);
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cur.licenses).to.have.length(2);
    expect(cur.licenses[1]).to.deep.equal({ name: "Web backer", buyer: "W", author: "A", bot: false, source: "web" });
    expect(cur.entrants[0].secretKey).to.deep.equal([1, 2, 3]);
    expect(cur.phase).to.equal("live");
    expect(fs.existsSync(`${file}.lock`)).to.equal(false);
  });

  it("merges into an existing record (scheduled flag set later)", async () => {
    const { file } = tmpRoundFile();
    await upsertLicenseRecord(file, "ROUND1", { name: "Web backer", buyer: "W", author: "A", bot: false });
    const added = await upsertLicenseRecord(file, "ROUND1", { buyer: "W", author: "A", scheduled: true });
    expect(added).to.equal(false);
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cur.licenses.filter((l: { buyer: string }) => l.buyer === "W")).to.deep.equal([{ name: "Web backer", buyer: "W", author: "A", bot: false, scheduled: true }]);
  });

  it("refuses to write into a newer round's file", async () => {
    const { file } = tmpRoundFile();
    let msg = "";
    await upsertLicenseRecord(file, "OLD", { buyer: "W", author: "A" }).catch((e: Error) => (msg = e.message));
    expect(msg).to.match(/round file now describes round ROUND1/);
  });

  it("serializes concurrent writers and never leaves a torn file", async () => {
    const { file, dir } = tmpRoundFile();
    await Promise.all(Array.from({ length: 8 }, (_, i) => upsertLicenseRecord(file, "ROUND1", { buyer: `W${i}`, author: "A" })));
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cur.licenses).to.have.length(9);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).to.deep.equal([]);
  });

  it("waits for a held lock and breaks a stale one", async () => {
    const { file } = tmpRoundFile();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
    const out = await withRoundFileLock(file, () => "ran");
    expect(out).to.equal("ran");
    expect(fs.existsSync(lock)).to.equal(false);
  });

  it("serves licenses and backers without secret keys", () => {
    const { file } = tmpRoundFile();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(JSON.stringify(sanitize(raw))).not.to.contain("secretKey");
    expect(publicLicenses(raw)).to.deep.equal([{ name: "Copycat", buyer: "C", author: "A", bot: true, scheduled: true, source: null }]);
    process.env.BLACKBOX_ROUND_FILE = file;
    try {
      const info = publicRoundInfo("local", true);
      expect(JSON.stringify(info)).not.to.contain("secretKey");
      expect(info.backers).to.deep.equal([{ name: "Copycat", owner: "C" }]);
      expect(info.licenses).to.have.length(1);
    } finally {
      delete process.env.BLACKBOX_ROUND_FILE;
    }
  });
});
