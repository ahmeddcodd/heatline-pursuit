# Heatline Pursuit

Heatline Pursuit is a mobile-ready Three.js police pursuit game built with
Next.js. Escape increasingly difficult police chases across ten low-poly city
tracks using keyboard or touch steering.

## Features

- Ten increasingly long and difficult pursuit levels
- Responsive keyboard and mobile touch controls
- Animated player and police vehicles with working wheels
- Adaptive police pursuit behavior and bust-lock system
- Procedural city, road, grass, building, and obstacle materials
- Original adaptive pursuit soundtrack
- Optimized instanced scenery for browser gameplay

## Local development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Validation

```bash
npm run lint
npm test
```

## Deploy to Vercel

Import `ahmeddcodd/heatline-pursuit` in Vercel. The included `vercel.json`
selects the Next.js framework, installs with `npm ci`, and builds with
`npm run build`. The game requires no environment variables or external
services.
