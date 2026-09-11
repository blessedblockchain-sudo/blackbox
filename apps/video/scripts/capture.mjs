/**
 * Capture real footage of the BLACKBOX web app for the submission video.
 *
 * Headless Chrome over CDP (puppeteer-core drives the system Chrome), writing
 * PNG frames per shot and encoding each shot to an MP4 that Remotion plays with
 * <OffthreadVideo>. Nothing is staged: the pages read a live round.
 *
 *   node scripts/capture.mjs --base http://127.0.0.1:3101
 *   node scripts/capture.mjs --base http://127.0.0.1:3101 --dump /proof
 *   node scripts/capture.mjs --base http://127.0.0.1:3101 --only arena,back
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "public", "capture");
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = flag("base", "http://127.0.0.1:3101").replace(/\/$/, "");
const DUMP = flag("dump", null);
const ONLY = flag("only", null)?.split(",").map((s) => s.trim());

/** One shot = one page, filmed for `seconds` at `fps`. */
const SHOTS = [
  { name: "arena", path: "/", seconds: 26, fps: 10, settleMs: 6000 },
  { name: "back", path: "/back", seconds: 14, fps: 10, settleMs: 5000 },
  { name: "proof", path: "/proof", seconds: 18, fps: 10, settleMs: 3000, click: ["Run", "Check", "Start"] },
  { name: "hall", path: "/hall", seconds: 10, fps: 10, settleMs: 3000 },
  { name: "studio", path: "/studio", seconds: 14, fps: 10, settleMs: 4000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, candidates) {
  return page.evaluate((texts) => {
    const els = [...document.querySelectorAll("button, a[role=button], [role=button]")];
    for (const t of texts) {
      const hit = els.find((e) => (e.textContent ?? "").trim().toLowerCase().includes(t.toLowerCase()));
      if (hit) {
        hit.click();
        return (hit.textContent ?? "").trim();
      }
    }
    return null;
  }, candidates);
}

async function encode(dir, name, fps) {
  const out = path.join(OUT, `${name}.mp4`);
  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-framerate", String(fps),
      "-i", path.join(dir, "frame-%04d.png"),
      "-vf", "scale=1920:-2,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-r", "30",
      out,
    ]);
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", "--window-size=1920,1080", "--disable-gpu"],
  });

  try {
    if (DUMP) {
      const page = await browser.newPage();
      const problems = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
      });
      page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
      page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`));
      page.on("response", (r) => {
        if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url().slice(0, 160)}`);
      });
      await page.goto(BASE + DUMP, { waitUntil: "networkidle2", timeout: 90_000 });
      await sleep(8000);
      if (problems.length) console.log("PROBLEMS:\n" + [...new Set(problems)].slice(0, 25).join("\n"));
      const info = await page.evaluate(() => ({
        title: document.title,
        buttons: [...document.querySelectorAll("button, a[role=button]")].map((b) => (b.textContent ?? "").trim()).filter(Boolean).slice(0, 30),
        links: [...document.querySelectorAll("nav a")].map((a) => (a.textContent ?? "").trim()).filter(Boolean).slice(0, 20),
        text: (document.body.innerText ?? "").slice(0, 1200),
      }));
      const shot = path.join(OUT, `dump${DUMP.replace(/\//g, "_") || "_root"}.png`);
      await page.screenshot({ path: shot });
      console.log(JSON.stringify(info, null, 1));
      console.log("screenshot:", shot);
      return;
    }

    for (const shot of SHOTS) {
      if (ONLY && !ONLY.includes(shot.name)) continue;
      const dir = path.join(OUT, shot.name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const page = await browser.newPage();
      const url = BASE + shot.path;
      process.stdout.write(`${shot.name.padEnd(7)} ${url} `);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });
      await sleep(shot.settleMs);
      if (shot.click) {
        const clicked = await clickByText(page, shot.click);
        process.stdout.write(clicked ? `[clicked "${clicked}"] ` : "[no button matched] ");
        await sleep(1500);
      }
      const total = shot.seconds * shot.fps;
      const interval = 1000 / shot.fps;
      for (let i = 1; i <= total; i++) {
        const t0 = Date.now();
        await page.screenshot({ path: path.join(dir, `frame-${String(i).padStart(4, "0")}.png`) });
        const spent = Date.now() - t0;
        if (spent < interval) await sleep(interval - spent);
      }
      await page.close();
      const mp4 = await encode(dir, shot.name, shot.fps);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`-> ${path.relative(ROOT, mp4)} (${shot.seconds}s)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
