import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);

test("ships a framework-clean Vite and TypeScript game", async () => {
  const [
    html,
    main,
    game,
    styles,
    cloudSave,
    youtubePlayables,
    packageSource,
    vercelSource,
  ] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("src/main.ts", root), "utf8"),
    readFile(new URL("src/game.ts", root), "utf8"),
    readFile(new URL("src/globals.css", root), "utf8"),
    readFile(new URL("src/cloud-save.ts", root), "utf8"),
    readFile(new URL("src/youtube-playables.ts", root), "utf8"),
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
  assert.match(html, /src="\.\/assets\/[^"]+\.js"/);
  const sdkPosition = html.indexOf("https://www.youtube.com/game_api/v1");
  const gameBundlePosition = html.indexOf('type="module"');
  assert.ok(sdkPosition >= 0, "YouTube Playables SDK v1 must be included");
  assert.ok(
    sdkPosition < gameBundlePosition,
    "YouTube Playables SDK must load before game code",
  );
  assert.doesNotMatch(
    html,
    /\b(?:src|href|content)="\/(?!\/)/,
    "Bundled files must use relative paths for YouTube Playables",
  );
  assert.doesNotMatch(game, /["'`]\/models\//);
  assert.match(main, /createYouTubePlayablesLifecycle\(\)/);
  assert.match(main, /await youtubePlayables\.loadCloudData\(\)/);
  assert.match(
    main,
    /startPursuitGame\(youtubePlayables, cloudSaveData\)/,
  );
  assert.match(game, /youtubePlayables: YouTubePlayablesLifecycle/);
  assert.match(cloudSave, /CLOUD_SAVE_VERSION = 1/);
  assert.match(cloudSave, /parseCloudSave/);
  assert.match(cloudSave, /serializeCloudSave/);
  assert.match(youtubePlayables, /\.loadData\(\)/);
  assert.match(youtubePlayables, /\.saveData\(data\)/);
  assert.match(youtubePlayables, /Number\.isSafeInteger\(value\)/);
  assert.match(youtubePlayables, /sendScore\(\{ value \}\)/);
  assert.match(game, /campaignScore = \(\) => completedThrough \+ 1/);
  assert.match(game, /setTrackPosition\(/);
  assert.match(game, /sweptProgressDistance\(/);
  assert.match(game, /choosePoliceLane/);
  assert.match(game, /minimumPoliceLaneGap/);
  assert.match(game, /driveableLaneLimit/);
  assert.match(game, /headingOffset/);
  assert.match(game, /maximumHeading/);
  assert.match(game, /counterSteering/);
  assert.match(game, /corneringRoll/);
  assert.match(game, /scheduleChordStab/);
  assert.match(game, /scheduleTensionSweep/);
  assert.match(game, /shouldOutput \? 0\.28 : 0/);
  assert.match(game, /ENGINE_GEAR_SPEEDS/);
  assert.match(game, /sportsEnginePrimary/);
  assert.match(game, /playGearShift/);
  assert.match(game, /engineRpm/);
  assert.match(game, /smoothedEngineRpm/);
  assert.match(game, /createPeriodicWave/);
  assert.match(game, /ENGINE_UPSHIFT_LOCKOUT = 1\.05/);
  assert.match(game, /ENGINE_DOWNSHIFT_LOCKOUT = 0\.78/);
  assert.match(game, /v10FiringFrequency = engineRpm \/ 12/);
  assert.doesNotMatch(game, /copEngineGain|copSirenGain/);
  assert.match(styles, /max-width: 620px[^}]+orientation: portrait/s);
  assert.match(styles, /safe-area-inset-(?:top|right|bottom|left)/);
  assert.match(youtubePlayables, /isAudioEnabled\(\)/);
  assert.match(youtubePlayables, /onAudioEnabledChange/);
  assert.match(youtubePlayables, /onPause/);
  assert.match(youtubePlayables, /onResume/);
  assert.match(youtubePlayables, /firstFrameReady\(\)/);
  assert.match(youtubePlayables, /gameReady\(\)/);
  assert.match(game, /cancelAnimationFrame\(raf\)/);
  assert.match(game, /void audio\.suspend\(\)/);
  assert.match(game, /gameShell\.inert = hostPaused/);
  const runtimeSources = [main, game, cloudSave, youtubePlayables].join("\n");
  const forbiddenPersistenceApis = [
    ["local", "Storage"].join(""),
    ["session", "Storage"].join(""),
    ["indexed", "DB"].join(""),
    ["document", "cookie"].join("."),
    ["Cache", "Storage"].join(""),
    ["caches", "."].join(""),
  ];
  forbiddenPersistenceApis.forEach((apiName) => {
    assert.doesNotMatch(runtimeSources, new RegExp(apiName, "i"));
  });
  assert.match(html, /START ESCAPE/);
  assert.match(html, /10 ESCALATING LEVELS/);
  await access(new URL("dist/models/player-car.glb", root));
  await access(new URL("dist/models/police-car.glb", root));
});

test("contains no React, Next.js, or vinext dependency", async () => {
  const packageSource = await readFile(new URL("package.json", root), "utf8");
  assert.doesNotMatch(packageSource, /react|next|vinext|react-server-dom/i);
});

test("cloud saves are versioned, bounded, and backward-compatible", async () => {
  const source = await readFile(new URL("src/cloud-save.ts", root), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${Date.now()}`;
  const { parseCloudSave, serializeCloudSave } = await import(moduleUrl);

  assert.deepEqual(parseCloudSave("not-json", 10), {
    version: 1,
    completedThrough: -1,
    resumeLevel: 0,
    playerMuted: false,
  });
  assert.deepEqual(
    parseCloudSave(
      JSON.stringify({
        completedThrough: 50,
        resumeLevel: 4,
        playerMuted: true,
      }),
      10,
    ),
    {
      version: 1,
      completedThrough: 9,
      resumeLevel: 4,
      playerMuted: true,
    },
  );
  assert.deepEqual(
    JSON.parse(
      serializeCloudSave(
        {
          completedThrough: 3,
          resumeLevel: 4,
          playerMuted: true,
        },
        10,
      ),
    ),
    {
      version: 1,
      campaign: {
        completedThrough: 3,
        resumeLevel: 4,
      },
      playerMuted: true,
    },
  );
});

test("YouTube lifecycle gives host pause and audio events priority", async () => {
  const source = await readFile(
    new URL("src/youtube-playables.ts", root),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const callbacks = {};
  const readinessCalls = [];
  const cloudCalls = [];
  const scoreCalls = [];
  let removedListeners = 0;

  globalThis.ytgame = {
    IN_PLAYABLES_ENV: true,
    engagement: {
      sendScore: async ({ value }) => {
        scoreCalls.push(value);
      },
    },
    game: {
      firstFrameReady: () => readinessCalls.push("first-frame"),
      gameReady: () => readinessCalls.push("game-ready"),
      loadData: async () => {
        cloudCalls.push("load");
        return '{"version":1}';
      },
      saveData: async (data) => {
        cloudCalls.push(`save:${data}`);
      },
    },
    system: {
      isAudioEnabled: () => false,
      onAudioEnabledChange: (callback) => {
        callbacks.audio = callback;
        return () => removedListeners++;
      },
      onPause: (callback) => {
        callbacks.pause = callback;
        return () => removedListeners++;
      },
      onResume: (callback) => {
        callbacks.resume = callback;
        return () => removedListeners++;
      },
    },
  };

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${Date.now()}`;
    const { createYouTubePlayablesLifecycle } = await import(moduleUrl);
    const lifecycle = createYouTubePlayablesLifecycle();
    const states = [];
    lifecycle.onStateChange((state) => states.push(state));

    assert.equal(lifecycle.getState().audioEnabled, false);
    await lifecycle.saveCloudData('{"blocked":true}');
    lifecycle.gameReady();
    lifecycle.firstFrameReady();
    lifecycle.firstFrameReady();
    lifecycle.gameReady();
    assert.deepEqual(readinessCalls, ["first-frame"]);

    assert.equal(await lifecycle.loadCloudData(), '{"version":1}');
    await lifecycle.saveCloudData('{"version":1}');
    await lifecycle.sendScore(1.5);
    await lifecycle.sendScore(0);
    await lifecycle.sendScore(0);
    await lifecycle.sendScore(3);
    lifecycle.gameReady();
    lifecycle.gameReady();
    assert.deepEqual(readinessCalls, ["first-frame", "game-ready"]);
    assert.deepEqual(cloudCalls, ["load", 'save:{"version":1}']);
    assert.deepEqual(scoreCalls, [0, 3]);

    callbacks.pause();
    callbacks.audio(true);
    callbacks.resume();
    assert.deepEqual(
      states.map(({ paused, audioEnabled }) => ({ paused, audioEnabled })),
      [
        { paused: true, audioEnabled: false },
        { paused: true, audioEnabled: true },
        { paused: false, audioEnabled: true },
      ],
    );

    lifecycle.destroy();
    assert.equal(removedListeners, 3);
  } finally {
    delete globalThis.ytgame;
  }
});
