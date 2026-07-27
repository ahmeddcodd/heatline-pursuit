import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a Vercel-ready Heatline Pursuit game", async () => {
  const [page, game, layout, packageSource, vercelSource] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/PursuitGame.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vercel.json", root), "utf8"),
  ]);

  const packageJson = JSON.parse(packageSource);
  const vercel = JSON.parse(vercelSource);
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(packageJson.scripts.start, "next start");
  assert.equal(vercel.framework, "nextjs");
  assert.equal(vercel.buildCommand, "npm run build");

  assert.match(page, /<PursuitGame \/>/);
  assert.match(layout, /Heatline Pursuit — Outrun the Law/);
  assert.match(game, /START ESCAPE/);
  assert.match(game, /10 ESCALATING LEVELS/);
  assert.match(game, /Coastal Warmup/);
  assert.doesNotMatch(`${page}${game}${layout}`, /codex-preview|react-loading-skeleton/);
});
