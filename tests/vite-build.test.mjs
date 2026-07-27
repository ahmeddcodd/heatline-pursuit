import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a framework-clean Vite and TypeScript game", async () => {
  const [html, main, game, packageSource, vercelSource] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("src/main.ts", root), "utf8"),
    readFile(new URL("src/game.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vercel.json", root), "utf8"),
  ]);

  const packageJson = JSON.parse(packageSource);
  const vercel = JSON.parse(vercelSource);
  assert.match(packageJson.scripts.build, /vite build/);
  assert.equal(vercel.framework, "vite");
  assert.equal(vercel.outputDirectory, "dist");
  assert.equal(packageJson.dependencies.react, undefined);
  assert.equal(packageJson.dependencies.next, undefined);
  assert.equal(packageJson.devDependencies.vinext, undefined);

  assert.match(html, /<title>Heatline Pursuit — Outrun the Law<\/title>/);
  assert.match(html, /src="\/assets\/[^"]+\.js"/);
  assert.match(main, /startPursuitGame\(\)/);
  assert.match(game, /export function startPursuitGame\(\)/);
  assert.match(html, /START ESCAPE/);
  assert.match(html, /10 ESCALATING LEVELS/);
  await access(new URL("dist/models/player-car.glb", root));
  await access(new URL("dist/models/police-car.glb", root));
});

test("contains no React, Next.js, or vinext dependency", async () => {
  const packageSource = await readFile(new URL("package.json", root), "utf8");
  assert.doesNotMatch(packageSource, /react|next|vinext|react-server-dom/i);
});
