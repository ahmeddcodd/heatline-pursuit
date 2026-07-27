# Heatline Pursuit

Heatline Pursuit is a mobile-ready Three.js police pursuit game built entirely
with Vite and TypeScript. Escape increasingly difficult police chases across
ten low-poly city tracks using keyboard or touch steering.

## Stack

- Vite 8
- TypeScript 5
- Three.js
- Native HTML and CSS
- Web Audio API

There is no React, Next.js, vinext, server runtime, database, or
environment-variable requirement.

## Features

- Ten increasingly long and difficult pursuit levels
- Responsive keyboard and mobile touch controls
- Animated player and police vehicles with working wheels
- Adaptive police pursuit behavior and bust-lock system
- Procedural city, road, grass, building, and obstacle materials
- Original adaptive pursuit soundtrack
- RPM-responsive player engine, wind, police engine, and spatial siren SFX
- Instanced scenery optimized for browser gameplay

## Local development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite.

## Validation

```bash
npm run lint
npm test
```

## Deploy to Vercel

Import `ahmeddcodd/heatline-pursuit` in Vercel. The included configuration uses
the Vite framework preset, installs with `npm ci`, builds with `npm run build`,
and serves the static `dist` output.
