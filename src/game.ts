import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type {
  YouTubePlayablesLifecycle,
  YouTubePlayablesState,
} from "./youtube-playables";
import { parseCloudSave, serializeCloudSave } from "./cloud-save";

type Phase = "menu" | "playing" | "won" | "busted";
type Wheel = {
  steerPivot: THREE.Group;
  spinPivot: THREE.Group;
  front: boolean;
};
type Cop = {
  root: THREE.Group;
  visual: THREE.Group;
  wheels: Wheel[];
  progress: number;
  lane: number;
  phase: number;
  wheelSpin: number;
  yaw: number;
  targetLane: number;
  stun: number;
  impactLean: number;
  red: THREE.Mesh;
  blue: THREE.Mesh;
};
type Obstacle = {
  root: THREE.Object3D;
  progress: number;
  lane: number;
  halfWidth: number;
  halfLength: number;
  kind: "cone" | "crate" | "barrier" | "oil";
  hit: boolean;
};
type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
};

type LevelConfig = {
  name: string;
  length: number;
  curve: number;
  frequency: number;
  roadEdge: number;
  cops: number;
  hazards: number;
  policeGrip: number;
};

const LEVELS: LevelConfig[] = [
  { name: "Coastal Warmup", length: 700, curve: 0.72, frequency: 0.94, roadEdge: 14, cops: 2, hazards: 14, policeGrip: 0.92 },
  { name: "Harbor Sweep", length: 790, curve: 0.82, frequency: 0.98, roadEdge: 13.7, cops: 2, hazards: 17, policeGrip: 0.98 },
  { name: "Palm Switchbacks", length: 890, curve: 0.94, frequency: 1.02, roadEdge: 13.4, cops: 3, hazards: 20, policeGrip: 1.04 },
  { name: "Cliffside Run", length: 1000, curve: 1.06, frequency: 1.06, roadEdge: 13, cops: 3, hazards: 24, policeGrip: 1.1 },
  { name: "Old Town Squeeze", length: 1110, curve: 1.18, frequency: 1.1, roadEdge: 12.6, cops: 3, hazards: 28, policeGrip: 1.16 },
  { name: "Canyon Coil", length: 1220, curve: 1.3, frequency: 1.14, roadEdge: 12.2, cops: 4, hazards: 32, policeGrip: 1.22 },
  { name: "Serpent Coast", length: 1330, curve: 1.42, frequency: 1.18, roadEdge: 11.8, cops: 4, hazards: 36, policeGrip: 1.28 },
  { name: "Midnight Spiral", length: 1440, curve: 1.54, frequency: 1.22, roadEdge: 11.5, cops: 4, hazards: 40, policeGrip: 1.34 },
  { name: "Interceptor Alley", length: 1550, curve: 1.66, frequency: 1.26, roadEdge: 11.2, cops: 5, hazards: 44, policeGrip: 1.4 },
  { name: "Final Heatline", length: 1680, curve: 1.8, frequency: 1.3, roadEdge: 10.8, cops: 5, hazards: 49, policeGrip: 1.48 },
];

const MAX_TRACK_LENGTH = LEVELS[LEVELS.length - 1].length;
const PLAYER_HALF_WIDTH = 1.02;
const PLAYER_HALF_LENGTH = 2.08;
const COP_HALF_WIDTH = 1.08;
const COP_HALF_LENGTH = 2.12;

function roadCenter(p: number, levelIndex: number) {
  const level = LEVELS[levelIndex];
  const phase = levelIndex * 0.57;
  const sharpness = 1.25 + levelIndex * 0.19;
  const chicane =
    Math.tanh(
      Math.sin(p * (0.0105 + levelIndex * 0.00062) + phase * 1.45) * sharpness,
    ) *
    levelIndex *
    1.65;
  return (
    Math.sin(p * 0.0082 * level.frequency + phase) * 15 * level.curve +
    Math.sin(p * 0.019 * level.frequency + 0.7 + phase * 0.65) * 5.5 * level.curve +
    Math.sin(p * 0.0035 + phase * 0.3) * 7 +
    chicane
  );
}

function roadAngle(p: number, levelIndex: number) {
  const d = 0.5;
  return Math.atan2(
    roadCenter(p + d, levelIndex) - roadCenter(p - d, levelIndex),
    -d * 2,
  );
}

function roadFrame(p: number, levelIndex: number) {
  const sample = 0.7;
  const centerX = roadCenter(p, levelIndex);
  const tangentX =
    roadCenter(p + sample, levelIndex) -
    roadCenter(p - sample, levelIndex);
  const tangentZ = -sample * 2;
  const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
  return {
    centerX,
    normalX: -tangentZ / tangentLength,
    normalZ: tangentX / tangentLength,
  };
}

function setTrackPosition(
  target: THREE.Vector3,
  progress: number,
  lane: number,
  height: number,
  levelIndex: number,
) {
  const frame = roadFrame(progress, levelIndex);
  return target.set(
    frame.centerX + frame.normalX * lane,
    height,
    -progress + frame.normalZ * lane,
  );
}

function sweptProgressDistance(from: number, to: number, target: number) {
  const minimum = Math.min(from, to);
  const maximum = Math.max(from, to);
  if (target >= minimum && target <= maximum) return 0;
  return Math.min(Math.abs(target - minimum), Math.abs(target - maximum));
}

function laneAtProgress(
  fromProgress: number,
  toProgress: number,
  fromLane: number,
  toLane: number,
  targetProgress: number,
) {
  const distance = toProgress - fromProgress;
  if (Math.abs(distance) < 0.0001) return toLane;
  return THREE.MathUtils.lerp(
    fromLane,
    toLane,
    THREE.MathUtils.clamp((targetProgress - fromProgress) / distance, 0, 1),
  );
}

function dampAngle(current: number, target: number, smoothing: number, dt: number) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-smoothing * dt));
}

function fallbackCar(color: number, police = false) {
  const car = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.15, 0.68, 4.15),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.15 }),
  );
  body.position.y = 0.68;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.65, 0.65, 1.85),
    new THREE.MeshStandardMaterial({ color: 0x172432, roughness: 0.25 }),
  );
  cabin.position.set(0, 1.18, 0.05);
  car.add(body, cabin);
  const tire = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.95 });
  for (const x of [-1.05, 1.05]) {
    for (const z of [-1.35, 1.35]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12), tire);
      wheel.name = `${z < 0 ? "Front" : "Rear"}_Wheel`;
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.45, z);
      car.add(wheel);
    }
  }
  if (police) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.13, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x27323c, roughness: 0.45 }),
    );
    bar.position.set(0, 1.58, -0.1);
    car.add(bar);
  }
  car.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return car;
}

function rigWheels(model: THREE.Object3D) {
  const wheels: Wheel[] = [];
  const wheelMeshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mesh.name.toLowerCase().includes("wheel")) wheelMeshes.push(mesh);
  });

  wheelMeshes.forEach((mesh) => {
    const parent = mesh.parent;
    if (!parent) return;
    const name = mesh.name.toLowerCase();
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    mesh.geometry.boundingBox?.getCenter(center);
    mesh.geometry.translate(-center.x, -center.y, -center.z);
    const pivotPosition = mesh.position.clone().add(center);
    parent.remove(mesh);
    mesh.position.set(0, 0, 0);
    const steerPivot = new THREE.Group();
    const spinPivot = new THREE.Group();
    steerPivot.name = `${mesh.name}_SteerPivot`;
    spinPivot.name = `${mesh.name}_SpinPivot`;
    steerPivot.position.copy(pivotPosition);
    parent.add(steerPivot);
    steerPivot.add(spinPivot);
    spinPivot.add(mesh);
    wheels.push({
      steerPivot,
      spinPivot,
      front: name.includes("front") || name.includes("_fl") || name.includes("_fr"),
    });
  });
  return wheels;
}

function billboard(text: string, color = "#ffe34e") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#111923";
  ctx.font = "900 60px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 67);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(10, 2.5),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
}

function requiredElement<T extends HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required game element: #${id}`);
  return node as T;
}

export function startPursuitGame(
  youtubePlayables: YouTubePlayablesLifecycle,
  serializedCloudSave: string | null,
) {
  const mount = requiredElement<HTMLDivElement>("game-canvas");
  const gameShell = requiredElement<HTMLElement>("game-shell");
  const speedRef = { current: requiredElement<HTMLElement>("speed-value") };
  const distanceRef = {
    current: requiredElement<HTMLElement>("distance-value"),
  };
  const bustRef = { current: requiredElement<HTMLDivElement>("bust-fill") };
  const nitroRef = { current: requiredElement<HTMLDivElement>("nitro-fill") };
  const routeRef = { current: requiredElement<HTMLSpanElement>("route-fill") };
  const statusRef = {
    current: requiredElement<HTMLSpanElement>("status-value"),
  };
  const knobRef = {
    current: requiredElement<HTMLDivElement>("steer-knob"),
  };
  const gameHud = requiredElement<HTMLDivElement>("game-hud");
  const startScreen = requiredElement<HTMLElement>("start-screen");
  const resultScreen = requiredElement<HTMLElement>("result-screen");
  const resultStamp = requiredElement<HTMLElement>("result-stamp");
  const resultTitle = requiredElement<HTMLElement>("result-title");
  const resultCopy = requiredElement<HTMLElement>("result-copy");
  const resultButton = requiredElement<HTMLButtonElement>("result-button");
  const levelChip = requiredElement<HTMLElement>("level-chip");
  const soundButton = requiredElement<HTMLButtonElement>("sound-button");
  const playButton = requiredElement<HTMLButtonElement>("play-button");
  const initialYouTubeState = youtubePlayables.getState();
  let hostPaused = initialYouTubeState.paused;
  let hostAudioEnabled = initialYouTubeState.audioEnabled;
  gameShell.inert = hostPaused;
  gameShell.classList.toggle("youtube-paused", hostPaused);
  playButton.disabled = true;
  const initialCloudSave = parseCloudSave(
    serializedCloudSave,
    LEVELS.length,
  );
  const actions: {
    current: {
    start: () => void;
    retry: () => void;
    next: () => void;
    sound: () => void;
    } | null;
  } = { current: null };
  let displayLevel = 0;

  const setDisplayLevel = (level: number) => {
    displayLevel = level;
    levelChip.textContent =
      `LEVEL ${level + 1} / ${LEVELS.length} · ${LEVELS[level].name}`;
    distanceRef.current.textContent = `${LEVELS[level].length}m`;
  };
  const setSoundOn = (enabled: boolean) => {
    soundButton.textContent = enabled ? "SOUND ON" : "MUTED";
    soundButton.setAttribute(
      "aria-label",
      enabled ? "Mute game audio" : "Turn on game audio",
    );
  };
  const setPhase = (phase: Phase) => {
    gameHud.classList.toggle("is-active", phase === "playing");
    startScreen.hidden = phase !== "menu";
    resultScreen.hidden = phase === "menu" || phase === "playing";
    resultScreen.className = `result-screen ${phase}`;
    if (phase !== "won" && phase !== "busted") return;

    const campaignComplete =
      phase === "won" && displayLevel === LEVELS.length - 1;
    resultStamp.textContent =
      phase === "won"
        ? campaignComplete
          ? "CAMPAIGN COMPLETE"
          : `LEVEL ${displayLevel + 1} CLEAR`
        : `LEVEL ${displayLevel + 1} · PURSUIT ENDED`;
    resultTitle.textContent =
      phase === "won"
        ? campaignComplete
          ? "HEATLINE MASTERED!"
          : "CLEAN GETAWAY!"
        : "BUSTED";
    resultCopy.textContent =
      phase === "won"
        ? campaignComplete
          ? "You conquered all ten routes and left every unit behind."
          : `Next: ${LEVELS[displayLevel + 1].name} — a longer, tighter pursuit.`
        : "The units boxed you in. Keep moving and use the whole road.";
    resultButton.textContent =
      phase === "won"
        ? campaignComplete
          ? "RESTART CAMPAIGN"
          : `START LEVEL ${displayLevel + 2}`
        : "RETRY ESCAPE";
  };

    let levelIndex = initialCloudSave.resumeLevel;
    const currentLevel = () => LEVELS[levelIndex];

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x76c9f4);
    scene.fog = new THREE.Fog(0x9bd7ec, 70, 195);
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const mobileRendering =
      coarsePointer ||
      Math.min(window.innerWidth, window.innerHeight) < 600;
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 650);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, mobileRendering ? 1.25 : 1.6),
    );
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xc9efff, 0x8a5c45, 2.2);
    const sun = new THREE.DirectionalLight(0xfff1cf, 3.15);
    sun.position.set(-35, 55, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(
      mobileRendering ? 512 : 1024,
      mobileRendering ? 512 : 1024,
    );
    sun.shadow.camera.left = -38;
    sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -22;
    sun.shadow.camera.far = 120;
    scene.add(hemi, sun, sun.target);
    const world = new THREE.Group();
    scene.add(world);

    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 2600),
      new THREE.MeshStandardMaterial({ color: 0x50b6d0, roughness: 0.55, metalness: 0.06 }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(0, -0.62, -850);
    world.add(ocean);
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 1850),
      new THREE.MeshStandardMaterial({ color: 0xc99362, roughness: 1 }),
    );
    island.rotation.x = -Math.PI / 2;
    island.position.set(0, -0.5, -850);
    island.receiveShadow = true;
    world.add(island);

    const asphaltCanvas = document.createElement("canvas");
    asphaltCanvas.width = 512;
    asphaltCanvas.height = 512;
    const asphaltContext = asphaltCanvas.getContext("2d");
    if (asphaltContext) {
      const image = asphaltContext.createImageData(512, 512);
      let seed = 918273;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < image.data.length; i += 4) {
        const grain = Math.floor(43 + random() * 25);
        image.data[i] = grain;
        image.data[i + 1] = grain + 5;
        image.data[i + 2] = grain + 9;
        image.data[i + 3] = 255;
      }
      asphaltContext.putImageData(image, 0, 0);
      asphaltContext.globalAlpha = 0.32;
      for (let i = 0; i < 420; i++) {
        const tone = 80 + Math.floor(random() * 65);
        asphaltContext.fillStyle = `rgb(${tone},${tone},${tone})`;
        const radius = 0.35 + random() * 1.5;
        asphaltContext.beginPath();
        asphaltContext.arc(
          random() * 512,
          random() * 512,
          radius,
          0,
          Math.PI * 2,
        );
        asphaltContext.fill();
      }
      asphaltContext.globalAlpha = 0.16;
      asphaltContext.strokeStyle = "#0c1117";
      asphaltContext.lineWidth = 6;
      for (const x of [124, 388]) {
        asphaltContext.beginPath();
        asphaltContext.moveTo(x, 0);
        asphaltContext.bezierCurveTo(x - 6, 145, x + 8, 350, x - 2, 512);
        asphaltContext.stroke();
      }
      asphaltContext.globalAlpha = 0.28;
      asphaltContext.lineWidth = 1.4;
      for (let i = 0; i < 14; i++) {
        const x = random() * 512;
        const y = random() * 512;
        asphaltContext.beginPath();
        asphaltContext.moveTo(x, y);
        asphaltContext.lineTo(x + random() * 24 - 12, y + 10 + random() * 24);
        asphaltContext.lineTo(x + random() * 38 - 19, y + 28 + random() * 30);
        asphaltContext.stroke();
      }
    }
    const asphaltTexture = new THREE.CanvasTexture(asphaltCanvas);
    asphaltTexture.colorSpace = THREE.SRGBColorSpace;
    asphaltTexture.wrapS = THREE.RepeatWrapping;
    asphaltTexture.wrapT = THREE.RepeatWrapping;
    asphaltTexture.repeat.set(2.2, 1);
    asphaltTexture.anisotropy = Math.min(
      8,
      renderer.capabilities.getMaxAnisotropy(),
    );
    const makeSurfaceTexture = (
      paint: (context: CanvasRenderingContext2D, size: number) => void,
      repeatX = 1,
      repeatY = 1,
    ) => {
      const canvas = document.createElement("canvas");
      const size = 256;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (context) paint(context, size);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      texture.anisotropy = asphaltTexture.anisotropy;
      return texture;
    };

    const sidewalkTexture = makeSurfaceTexture((context, size) => {
      context.fillStyle = "#d6c9a8";
      context.fillRect(0, 0, size, size);
      for (let i = 0; i < 900; i++) {
        const x = (i * 83) % size;
        const y = (i * 149) % size;
        const shade = 155 + (i % 42);
        context.fillStyle = `rgba(${shade},${shade - 8},${shade - 20},.18)`;
        context.fillRect(x, y, 1 + (i % 2), 1 + ((i + 1) % 2));
      }
      context.strokeStyle = "rgba(91,82,67,.4)";
      context.lineWidth = 2;
      for (let y = 0; y <= size; y += 64) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(size, y);
        context.stroke();
      }
      for (let row = 0; row < 4; row++) {
        const offset = row % 2 ? 32 : 0;
        for (let x = offset; x <= size; x += 64) {
          context.beginPath();
          context.moveTo(x, row * 64);
          context.lineTo(x, row * 64 + 64);
          context.stroke();
        }
      }
      context.strokeStyle = "rgba(255,248,220,.26)";
      context.lineWidth = 1;
      for (let y = 2; y <= size; y += 64) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(size, y);
        context.stroke();
      }
    }, 5.5, 1.5);

    const curbTexture = makeSurfaceTexture((context, size) => {
      context.fillStyle = "#e2e4df";
      context.fillRect(0, 0, size, size);
      context.save();
      context.translate(-size * 0.25, 0);
      context.rotate(-0.42);
      for (let x = -size; x < size * 2; x += 54) {
        context.fillStyle = "rgba(43,52,58,.3)";
        context.fillRect(x, -size, 20, size * 3);
      }
      context.restore();
      context.fillStyle = "rgba(255,255,255,.34)";
      for (let i = 0; i < 180; i++) {
        context.fillRect((i * 101) % size, (i * 47) % size, 1, 3 + (i % 4));
      }
      context.strokeStyle = "rgba(38,45,48,.28)";
      context.lineWidth = 1;
      for (let y = 0; y < size; y += 42) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(size, y + ((y / 42) % 2 ? 3 : -2));
        context.stroke();
      }
    }, 1.2, 3.5);

    const grassTexture = makeSurfaceTexture((context, size) => {
      context.fillStyle = "#76aa50";
      context.fillRect(0, 0, size, size);
      for (let i = 0; i < 3200; i++) {
        const x = (i * 67 + (i % 13) * 11) % size;
        const y = (i * 139 + (i % 7) * 17) % size;
        const green = 90 + (i % 58);
        context.strokeStyle =
          i % 4 === 0
            ? `rgba(44,${green},48,.48)`
            : `rgba(123,${Math.min(190, green + 35)},75,.38)`;
        context.lineWidth = i % 9 === 0 ? 1.4 : 0.7;
        context.beginPath();
        context.moveTo(x, y + 2 + (i % 3));
        context.lineTo(x + (i % 3) - 1, y - 2 - (i % 4));
        context.stroke();
      }
      context.globalAlpha = 0.14;
      for (let i = 0; i < 90; i++) {
        context.fillStyle = i % 2 ? "#365f31" : "#b2ce72";
        context.beginPath();
        context.arc(
          (i * 97) % size,
          (i * 53) % size,
          2 + (i % 5),
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.globalAlpha = 1;
    });

    const facadeTextures = [
      makeSurfaceTexture((context, size) => {
        context.fillStyle = "#e1ded5";
        context.fillRect(0, 0, size, size);
        for (let i = 0; i < 700; i++) {
          const value = 175 + (i % 55);
          context.fillStyle = `rgba(${value},${value},${value},.16)`;
          context.fillRect((i * 71) % size, (i * 137) % size, 2, 2);
        }
        context.strokeStyle = "rgba(82,88,91,.28)";
        context.lineWidth = 2;
        for (let x = 0; x <= size; x += 64) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, size);
          context.stroke();
        }
        for (let y = 0; y <= size; y += 48) {
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(size, y);
          context.stroke();
        }
      }, 2, 3),
      makeSurfaceTexture((context, size) => {
        context.fillStyle = "#d7d2c6";
        context.fillRect(0, 0, size, size);
        context.strokeStyle = "rgba(76,68,57,.34)";
        context.lineWidth = 2;
        for (let y = 0; y <= size; y += 24) {
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(size, y);
          context.stroke();
          const offset = (y / 24) % 2 ? 24 : 0;
          for (let x = offset; x <= size; x += 48) {
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(x, y + 24);
            context.stroke();
          }
        }
        context.fillStyle = "rgba(91,63,50,.12)";
        for (let i = 0; i < 80; i++) {
          context.fillRect((i * 97) % size, (i * 61) % size, 18, 5);
        }
      }, 2.4, 4),
      makeSurfaceTexture((context, size) => {
        const gradient = context.createLinearGradient(0, 0, size, 0);
        gradient.addColorStop(0, "#c8c9c4");
        gradient.addColorStop(0.5, "#e4e2d9");
        gradient.addColorStop(1, "#c3c5c1");
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
        context.strokeStyle = "rgba(55,62,66,.3)";
        context.lineWidth = 3;
        for (let x = 0; x <= size; x += 51.2) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, size);
          context.stroke();
        }
        context.strokeStyle = "rgba(255,255,245,.2)";
        context.lineWidth = 1;
        for (let x = 3; x <= size; x += 51.2) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, size);
          context.stroke();
        }
      }, 2, 3.5),
    ];

    const roadMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: asphaltTexture,
      bumpMap: asphaltTexture,
      bumpScale: 0.055,
      roughness: 0.94,
      metalness: 0.02,
    });
    const shoulderMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: sidewalkTexture,
      bumpMap: sidewalkTexture,
      bumpScale: 0.035,
      roughness: 0.96,
    });
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0xfff0a1,
      emissive: 0x514714,
      emissiveIntensity: 0.2,
    });
    const railMaterials = [
      new THREE.MeshStandardMaterial({
        color: 0x1bd0e3,
        map: curbTexture,
        bumpMap: curbTexture,
        bumpScale: 0.025,
        emissive: 0x075b68,
        emissiveIntensity: 0.36,
        roughness: 0.62,
      }),
      new THREE.MeshStandardMaterial({
        color: 0xffd640,
        map: curbTexture,
        bumpMap: curbTexture,
        bumpScale: 0.025,
        emissive: 0x5e4810,
        emissiveIntensity: 0.32,
        roughness: 0.64,
      }),
    ];
    const roadPieces: Array<{
      progress: number;
      shoulder: THREE.Mesh;
      road: THREE.Mesh;
      line?: THREE.Mesh;
    }> = [];
    for (let p = -16; p <= MAX_TRACK_LENGTH + 24; p += 8) {
      const rp = Math.max(0, p);
      const x = roadCenter(rp, levelIndex);
      const angle = roadAngle(rp, levelIndex);
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(34, 0.2, 8.28), shoulderMat);
      shoulder.position.set(x, -0.28, -p);
      shoulder.rotation.y = angle;
      shoulder.receiveShadow = true;
      world.add(shoulder);
      const road = new THREE.Mesh(new THREE.BoxGeometry(28, 0.24, 8.1), roadMat);
      road.position.set(x, -0.13, -p);
      road.rotation.y = angle;
      road.receiveShadow = true;
      world.add(road);
      if (Math.round(p / 8) % 2 === 0) {
        for (const side of [-1, 1]) {
          const rail = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.24, 7.02, 4, 8),
            railMaterials[(Math.abs(Math.round(p / 8)) + (side > 0 ? 1 : 0)) % 2],
          );
          rail.position.set(side * 13.45, 0.16, 0);
          rail.rotation.x = Math.PI / 2;
          rail.castShadow = true;
          road.add(rail);
        }
      }
      let line: THREE.Mesh | undefined;
      if (Math.round(p / 8) % 2 === 0) {
        line = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 3.7), lineMat);
        line.position.set(x, 0.065, -p);
        line.rotation.y = angle;
        world.add(line);
      }
      roadPieces.push({ progress: p, shoulder, road, line });
    }

    const ribbonMaterial = roadMat.clone();
    ribbonMaterial.polygonOffset = true;
    ribbonMaterial.polygonOffsetFactor = -1;
    ribbonMaterial.polygonOffsetUnits = -1;
    const roadRibbon = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMaterial);
    roadRibbon.receiveShadow = true;
    roadRibbon.renderOrder = 1;
    world.add(roadRibbon);
    const grassFieldMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: grassTexture,
      bumpMap: grassTexture,
      bumpScale: 0.045,
      roughness: 1,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const grassFields = [
      new THREE.Mesh(new THREE.BufferGeometry(), grassFieldMaterial),
      new THREE.Mesh(new THREE.BufferGeometry(), grassFieldMaterial),
    ];
    grassFields.forEach((field) => {
      field.receiveShadow = true;
      world.add(field);
    });
    const rebuildRoadRibbon = () => {
      const level = currentLevel();
      const start = -18;
      const step = 3.5;
      const pointCount = Math.ceil((level.length + 24 - start) / step) + 1;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < pointCount; i++) {
        const p = Math.min(level.length + 24, start + i * step);
        const rp = Math.max(0, p);
        const center = roadCenter(rp, levelIndex);
        const sample = 0.7;
        const tangentX =
          roadCenter(rp + sample, levelIndex) -
          roadCenter(Math.max(0, rp - sample), levelIndex);
        const tangentZ = -sample * 2;
        const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
        const normalX = -tangentZ / tangentLength;
        const normalZ = tangentX / tangentLength;
        positions.push(
          center + normalX * level.roadEdge,
          0.018,
          -p + normalZ * level.roadEdge,
          center - normalX * level.roadEdge,
          0.018,
          -p - normalZ * level.roadEdge,
        );
        uvs.push(0, p / 12, 1, p / 12);
        if (i < pointCount - 1) {
          const a = i * 2;
          indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      roadRibbon.geometry.dispose();
      roadRibbon.geometry = geometry;
    };
    const rebuildGrassFields = () => {
      const level = currentLevel();
      const start = -22;
      const step = 5;
      const pointCount = Math.ceil((level.length + 35 - start) / step) + 1;
      for (const [fieldIndex, field] of grassFields.entries()) {
        const side = fieldIndex === 0 ? -1 : 1;
        const positions: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < pointCount; i++) {
          const p = Math.min(level.length + 35, start + i * step);
          const frame = roadFrame(Math.max(0, p), levelIndex);
          const inner = level.roadEdge + 3.25;
          const outer = 66;
          positions.push(
            frame.centerX + side * frame.normalX * inner,
            -0.205,
            -p + side * frame.normalZ * inner,
            frame.centerX + side * frame.normalX * outer,
            -0.215,
            -p + side * frame.normalZ * outer,
          );
          const shade = i % 4 === 0 ? 0.94 : i % 3 === 0 ? 1.05 : 1;
          colors.push(
            0.44 * shade,
            0.66 * shade,
            0.32 * shade,
            0.39 * shade,
            0.59 * shade,
            0.28 * shade,
          );
          uvs.push(0, p / 10, 5.2, p / 10);
          if (i < pointCount - 1) {
            const a = i * 2;
            indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
          "color",
          new THREE.Float32BufferAttribute(colors, 3),
        );
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        field.geometry.dispose();
        field.geometry = geometry;
      }
    };

    const buildingColors = [0xff765e, 0xffc64f, 0x8e79e8, 0x36b8bd, 0xe78843, 0xe55e8a];
    const windowFrameGeometry = new THREE.BoxGeometry(0.92, 0.86, 0.12);
    const windowGlassGeometry = new THREE.BoxGeometry(0.64, 0.58, 0.15);
    const windowFrameMaterial = new THREE.MeshStandardMaterial({
      color: 0x263746,
      roughness: 0.48,
      metalness: 0.08,
    });
    const windowMaterials = [
      new THREE.MeshStandardMaterial({
        color: 0x77e8f2,
        emissive: 0x1a6974,
        emissiveIntensity: 0.8,
        roughness: 0.2,
        metalness: 0.28,
      }),
      new THREE.MeshStandardMaterial({
        color: 0xffd879,
        emissive: 0x7b4a16,
        emissiveIntensity: 0.7,
        roughness: 0.24,
        metalness: 0.18,
      }),
    ];
    const trimMaterial = new THREE.MeshStandardMaterial({
      color: 0xf7e8ca,
      roughness: 0.72,
    });
    const shopGlassMaterial = new THREE.MeshStandardMaterial({
      color: 0x18384c,
      emissive: 0x0a2636,
      emissiveIntensity: 0.5,
      roughness: 0.18,
      metalness: 0.3,
    });
    const buildings: Array<{
      mesh: THREE.Group;
      progress: number;
      side: number;
      offset: number;
    }> = [];
    const buildingHeights = [9.8, 13.6, 18.4, 24.5, 11.8, 21.2, 16.1];
    for (let i = 0; i < 168; i++) {
      const p = 38 + i * 9.85;
      const h = buildingHeights[(i * 3 + Math.floor(i / 5)) % buildingHeights.length];
      const width = 7 + (i % 4) * 1.25;
      const depth = 7.2 + ((i + 1) % 3) * 1.2;
      const side = i % 2 ? -1 : 1;
      const offset = 21 + (i % 4) * 5.7;
      const building = new THREE.Group();
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: buildingColors[i % buildingColors.length],
        map: facadeTextures[i % facadeTextures.length],
        bumpMap: facadeTextures[i % facadeTextures.length],
        bumpScale: 0.035,
        roughness: 0.84,
      });
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(width, h, depth),
        bodyMaterial,
      );
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      building.add(body);

      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.35, 0.45, depth + 0.35),
        new THREE.MeshStandardMaterial({
          color: 0x7e4d42,
          roughness: 0.88,
        }),
      );
      plinth.position.y = 0.23;
      building.add(plinth);

      const roofCap = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.38, 0.28, depth + 0.38),
        trimMaterial,
      );
      roofCap.position.y = h + 0.14;
      roofCap.castShadow = true;
      building.add(roofCap);

      if (i % 3 === 0) {
        const upper = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.58, 1.45, depth * 0.55),
          bodyMaterial,
        );
        upper.position.set(0, h + 0.86, 0);
        upper.castShadow = true;
        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(Math.min(width, depth) * 0.36, 1.55, 4),
          new THREE.MeshStandardMaterial({
            color: 0x5f3b4a,
            roughness: 0.78,
          }),
        );
        roof.position.y = h + 2.35;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        building.add(upper, roof);
      } else {
        const utility = new THREE.Mesh(
          new THREE.BoxGeometry(1.5, 0.85, 1.25),
          new THREE.MeshStandardMaterial({ color: 0x4a5962, roughness: 0.82 }),
        );
        utility.position.set(width * 0.18, h + 0.58, 0);
        const antenna = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.08, 2, 6),
          trimMaterial,
        );
        antenna.position.set(-width * 0.22, h + 1.15, 0);
        building.add(utility, antenna);
      }

      const floors = Math.max(3, Math.floor((h - 1.2) / 1.45));
      const columns = Math.max(3, Math.floor((width - 1) / 1.65));
      const sideRows = Math.max(1, Math.floor(depth / 2.3));
      const windowCount = floors * columns * 2 + floors * sideRows * 2;
      const frames = new THREE.InstancedMesh(
        windowFrameGeometry,
        windowFrameMaterial,
        windowCount,
      );
      const glass = new THREE.InstancedMesh(
        windowGlassGeometry,
        windowMaterials[i % windowMaterials.length],
        windowCount,
      );
      const windowDummy = new THREE.Object3D();
      let windowIndex = 0;
      const setWindow = (
        x: number,
        y: number,
        z: number,
        rotationY: number,
        glassOffsetX: number,
        glassOffsetZ: number,
      ) => {
        windowDummy.position.set(x, y, z);
        windowDummy.rotation.set(0, rotationY, 0);
        windowDummy.scale.set(1, 1, 1);
        windowDummy.updateMatrix();
        frames.setMatrixAt(windowIndex, windowDummy.matrix);
        windowDummy.position.x += glassOffsetX;
        windowDummy.position.z += glassOffsetZ;
        windowDummy.updateMatrix();
        glass.setMatrixAt(windowIndex, windowDummy.matrix);
        windowIndex++;
      };
      for (let floor = 0; floor < floors; floor++) {
        const y = 1.65 + floor * 1.36;
        for (let column = 0; column < columns; column++) {
          const x = -((columns - 1) * 1.35) / 2 + column * 1.35;
          setWindow(x, y, depth / 2 + 0.055, 0, 0, 0.025);
          setWindow(x, y, -depth / 2 - 0.055, 0, 0, -0.025);
        }
        for (let row = 0; row < sideRows; row++) {
          const z = -((sideRows - 1) * 1.55) / 2 + row * 1.55;
          setWindow(width / 2 + 0.055, y, z, Math.PI / 2, 0.025, 0);
          setWindow(-width / 2 - 0.055, y, z, Math.PI / 2, -0.025, 0);
        }
      }
      frames.instanceMatrix.needsUpdate = true;
      glass.instanceMatrix.needsUpdate = true;
      frames.castShadow = true;
      glass.castShadow = false;
      building.add(frames, glass);

      const storefront = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.48, 1.35, 0.16),
        shopGlassMaterial,
      );
      storefront.position.set(0, 0.95, depth / 2 + 0.08);
      const awning = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.58, 0.18, 1.05),
        new THREE.MeshStandardMaterial({
          color: buildingColors[(i + 2) % buildingColors.length],
          roughness: 0.62,
        }),
      );
      awning.position.set(0, 1.75, depth / 2 + 0.48);
      awning.rotation.x = -0.12;
      building.add(storefront, awning);

      if (i % 2 === 0) {
        const balcony = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.62, 0.16, 0.92),
          trimMaterial,
        );
        balcony.position.set(0, Math.min(h - 1.1, 4.5), depth / 2 + 0.42);
        const balconyRail = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.62, 0.55, 0.1),
          windowFrameMaterial,
        );
        balconyRail.position.set(
          0,
          Math.min(h - 0.8, 4.8),
          depth / 2 + 0.85,
        );
        building.add(balcony, balconyRail);
      }

      building.position.set(
        roadCenter(p, levelIndex) + side * offset,
        -0.2,
        -p,
      );
      building.rotation.y = roadAngle(p, levelIndex) + Math.PI / 2;
      world.add(building);
      buildings.push({ mesh: building, progress: p, side, offset });
    }

    const BACKGROUND_BUILDING_COUNT = 136;
    const backgroundBuildingData: Array<{
      progress: number;
      side: number;
      offset: number;
      width: number;
      height: number;
      depth: number;
    }> = [];
    const backgroundTowers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        map: facadeTextures[2],
        bumpMap: facadeTextures[2],
        bumpScale: 0.03,
        roughness: 0.86,
      }),
      BACKGROUND_BUILDING_COUNT,
    );
    const backgroundRoofs = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xf4dfbd, roughness: 0.76 }),
      BACKGROUND_BUILDING_COUNT,
    );
    const BACKGROUND_WINDOW_COLUMNS = 5;
    const BACKGROUND_WINDOW_ROWS = 7;
    const BACKGROUND_WINDOWS_PER_BUILDING =
      BACKGROUND_WINDOW_COLUMNS * BACKGROUND_WINDOW_ROWS;
    const backgroundWindowFrames = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 0.12),
      new THREE.MeshStandardMaterial({
        color: 0x23313a,
        roughness: 0.58,
        metalness: 0.12,
      }),
      BACKGROUND_BUILDING_COUNT * BACKGROUND_WINDOWS_PER_BUILDING,
    );
    const backgroundWindows = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0x7ce3ed,
        emissive: 0x175e6a,
        emissiveIntensity: 0.65,
        roughness: 0.28,
      }),
      BACKGROUND_BUILDING_COUNT * BACKGROUND_WINDOWS_PER_BUILDING,
    );
    for (let i = 0; i < BACKGROUND_BUILDING_COUNT; i++) {
      backgroundTowers.setColorAt(
        i,
        new THREE.Color(buildingColors[(i * 5 + 2) % buildingColors.length]),
      );
      backgroundBuildingData.push({
        progress: 30 + i * 12.25,
        side: i % 2 === 0 ? -1 : 1,
        offset: 40 + (i % 3) * 8.5,
        width: 8.5 + (i % 4) * 1.45,
        height: 18 + (i % 7) * 3.25,
        depth: 8 + ((i + 2) % 4) * 1.4,
      });
    }
    backgroundTowers.instanceColor!.needsUpdate = true;
    backgroundTowers.castShadow = true;
    backgroundTowers.receiveShadow = true;
    backgroundRoofs.castShadow = true;
    world.add(
      backgroundTowers,
      backgroundRoofs,
      backgroundWindowFrames,
      backgroundWindows,
    );

    const GRASS_PATCH_COUNT = 300;
    const grassPatchGeometry = new THREE.CircleGeometry(2.8, 7);
    grassPatchGeometry.rotateX(-Math.PI / 2);
    const grassPatches = new THREE.InstancedMesh(
      grassPatchGeometry,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: grassTexture,
        bumpMap: grassTexture,
        bumpScale: 0.04,
        roughness: 1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
      GRASS_PATCH_COUNT,
    );
    const patchColors = [0x78aa55, 0x6d9e4d, 0x86b95f, 0x5f9148];
    for (let i = 0; i < GRASS_PATCH_COUNT; i++) {
      grassPatches.setColorAt(
        i,
        new THREE.Color(patchColors[i % patchColors.length]),
      );
    }
    grassPatches.instanceColor!.needsUpdate = true;
    grassPatches.receiveShadow = true;
    world.add(grassPatches);

    const GRASS_COUNT = 620;
    const grassGeometry = new THREE.BufferGeometry();
    grassGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          -0.22, 0, 0, 0, 0.72, 0, 0.22, 0, 0,
          0, 0, -0.22, 0, 0.6, 0, 0, 0, 0.22,
          -0.16, 0, -0.16, 0.1, 0.52, 0.1, 0.16, 0, 0.16,
        ],
        3,
      ),
    );
    grassGeometry.computeVertexNormals();
    const grass = new THREE.InstancedMesh(
      grassGeometry,
      new THREE.MeshStandardMaterial({
        color: 0x4f9b58,
        side: THREE.DoubleSide,
        roughness: 1,
      }),
      GRASS_COUNT,
    );
    grass.receiveShadow = true;
    world.add(grass);

    const TREE_COUNT = 92;
    const treeTrunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.28, 0.48, 2.8, 7),
      new THREE.MeshStandardMaterial({ color: 0x704b35, roughness: 1 }),
      TREE_COUNT,
    );
    const treeCrowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x3f8b5c, roughness: 0.95 }),
      TREE_COUNT,
    );
    treeTrunks.castShadow = true;
    treeCrowns.castShadow = true;
    const crownColors = [0x3f8b5c, 0x4f9b58, 0x2f7860, 0x669f4c];
    for (let i = 0; i < TREE_COUNT; i++) {
      treeCrowns.setColorAt(i, new THREE.Color(crownColors[i % crownColors.length]));
    }
    treeCrowns.instanceColor!.needsUpdate = true;
    world.add(treeTrunks, treeCrowns);

    const cloudMaterial = new THREE.MeshStandardMaterial({
      color: 0xf5fbff,
      roughness: 0.9,
      flatShading: false,
    });
    const cloudGeometry = new THREE.SphereGeometry(2.2, 18, 12);
    const clouds: Array<{
      root: THREE.Group;
      progress: number;
      baseX: number;
      phase: number;
    }> = [];
    for (let i = 0; i < 19; i++) {
      const root = new THREE.Group();
      const pieceCount = 4 + (i % 3);
      for (let piece = 0; piece < pieceCount; piece++) {
        const puff = new THREE.Mesh(cloudGeometry, cloudMaterial);
        puff.position.set(
          (piece - (pieceCount - 1) / 2) * 2.35,
          Math.sin(piece * 1.7 + i) * 0.7,
          (piece % 2) * 0.75,
        );
        puff.scale.set(
          1.15 + (piece % 2) * 0.35,
          0.62 + (piece % 3) * 0.12,
          0.82 + (piece % 2) * 0.18,
        );
        root.add(puff);
      }
      const cloudProgress = 35 + i * 88;
      const baseX =
        roadCenter(cloudProgress, levelIndex) +
        (i % 2 ? -1 : 1) * (20 + (i % 4) * 11);
      root.position.set(baseX, 22 + (i % 4) * 3.8, -cloudProgress);
      root.scale.setScalar(0.8 + (i % 3) * 0.18);
      world.add(root);
      clouds.push({
        root,
        progress: cloudProgress,
        baseX,
        phase: i * 1.83,
      });
    }

    const directionSign = billboard("KEEP MOVING  ››");
    directionSign.position.set(roadCenter(120, levelIndex) - 18, 4.2, -120);
    directionSign.rotation.y = roadAngle(120, levelIndex);
    world.add(directionSign);

    const archColors = [0xff5b62, 0x28cbd2, 0xffc63d, 0x8b72e8];
    const trackArches: Array<{ root: THREE.Group; progress: number }> = [];
    for (let i = 0; i < 7; i++) {
      const progressOnTrack = 210 + i * 215;
      const arch = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({
        color: archColors[i % archColors.length],
        emissive: archColors[i % archColors.length],
        emissiveIntensity: 0.24,
        roughness: 0.58,
      });
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.85, 6.4, 0.85), material);
      const right = left.clone();
      left.position.set(-12.2, 3.2, 0);
      right.position.set(12.2, 3.2, 0);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(25.2, 0.72, 0.9), material);
      beam.position.y = 6.15;
      const beaconA = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      const beaconB = beaconA.clone();
      beaconA.position.set(-9, 6.8, 0);
      beaconB.position.set(9, 6.8, 0);
      arch.add(left, right, beam, beaconA, beaconB);
      arch.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = true;
      });
      arch.position.set(
        roadCenter(progressOnTrack, levelIndex),
        0,
        -progressOnTrack,
      );
      arch.rotation.y = roadAngle(progressOnTrack, levelIndex);
      world.add(arch);
      trackArches.push({ root: arch, progress: progressOnTrack });
    }

    const finish = new THREE.Group();
    finish.position.set(
      roadCenter(currentLevel().length, levelIndex),
      0,
      -currentLevel().length,
    );
    finish.rotation.y = roadAngle(currentLevel().length, levelIndex);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x111a24, roughness: 0.55 });
    for (const x of [-12, 12]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 0.8), postMat);
      post.position.set(x, 3.5, 0);
      post.castShadow = true;
      finish.add(post);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(24.8, 1.1, 0.85), postMat);
    top.position.y = 6.55;
    finish.add(top);
    const sign = billboard("EXTRACTION");
    sign.position.set(0, 6.55, -0.48);
    sign.scale.set(1.5, 0.55, 1);
    finish.add(sign);
    for (let i = -12; i < 12; i += 2) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(2, 0.05, 2.2),
        new THREE.MeshStandardMaterial({ color: (i / 2) % 2 ? 0xffffff : 0x151b25 }),
      );
      tile.position.set(i + 1, 0.03, 0);
      finish.add(tile);
    }
    world.add(finish);

    const obstacles: Obstacle[] = [];
    const woodCanvas = document.createElement("canvas");
    woodCanvas.width = 256;
    woodCanvas.height = 256;
    const woodContext = woodCanvas.getContext("2d");
    if (woodContext) {
      woodContext.fillStyle = "#a76636";
      woodContext.fillRect(0, 0, 256, 256);
      for (let y = 0; y < 256; y += 32) {
        woodContext.fillStyle = y % 64 === 0 ? "#8a4f2a" : "#b97843";
        woodContext.fillRect(0, y, 256, 3);
        woodContext.strokeStyle = "rgba(74,37,19,.42)";
        woodContext.lineWidth = 1;
        for (let line = 0; line < 5; line++) {
          woodContext.beginPath();
          woodContext.moveTo(0, y + 7 + line * 5);
          woodContext.bezierCurveTo(
            70,
            y + 2 + line * 6,
            170,
            y + 12 + line * 4,
            256,
            y + 6 + line * 5,
          );
          woodContext.stroke();
        }
      }
      for (const [x, y] of [[46, 54], [184, 118], [92, 210]]) {
        woodContext.fillStyle = "rgba(70,34,18,.58)";
        woodContext.beginPath();
        woodContext.ellipse(x, y, 8, 4, 0.2, 0, Math.PI * 2);
        woodContext.fill();
      }
    }
    const woodTexture = new THREE.CanvasTexture(woodCanvas);
    woodTexture.colorSpace = THREE.SRGBColorSpace;
    woodTexture.wrapS = THREE.RepeatWrapping;
    woodTexture.wrapT = THREE.RepeatWrapping;
    woodTexture.repeat.set(1.5, 1.5);
    woodTexture.anisotropy = asphaltTexture.anisotropy;

    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xff641f,
      roughness: 0.7,
    });
    const rubberMat = new THREE.MeshStandardMaterial({
      color: 0x20252a,
      roughness: 0.92,
    });
    const whiteMat = new THREE.MeshStandardMaterial({
      color: 0xfff7df,
      emissive: 0x4f472f,
      emissiveIntensity: 0.18,
      roughness: 0.56,
    });
    const crateMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: woodTexture,
      bumpMap: woodTexture,
      bumpScale: 0.045,
      roughness: 0.92,
    });
    const crateFrameMat = new THREE.MeshStandardMaterial({
      color: 0x6d3d23,
      map: woodTexture,
      roughness: 0.96,
    });
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0xf4f2e9,
      roughness: 0.72,
    });
    const redMat = new THREE.MeshStandardMaterial({
      color: 0xf03d4f,
      emissive: 0x6b101d,
      emissiveIntensity: 0.25,
      roughness: 0.48,
    });
    const oilMat = new THREE.MeshStandardMaterial({
      color: 0x080d13,
      roughness: 0.12,
      metalness: 0.48,
    });
    const barrelMat = new THREE.MeshStandardMaterial({
      color: 0x2088a6,
      roughness: 0.5,
      metalness: 0.42,
    });
    const warningLightMat = new THREE.MeshStandardMaterial({
      color: 0xffb52e,
      emissive: 0xff7815,
      emissiveIntensity: 2.4,
      roughness: 0.32,
    });

    const addObstacle = (
      kind: Obstacle["kind"],
      progress: number,
      lane: number,
      halfWidth: number,
      halfLength: number,
    ) => {
      const root = new THREE.Group();
      if (kind === "cone") {
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(1.05, 0.13, 1.05),
          rubberMat,
        );
        base.position.y = 0.065;
        const cone = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.47, 1.42, 16),
          coneMat,
        );
        cone.position.y = 0.79;
        const lowerBand = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.38, 0.17, 16),
          whiteMat,
        );
        lowerBand.position.y = 0.68;
        const upperBand = new THREE.Mesh(
          new THREE.CylinderGeometry(0.2, 0.25, 0.13, 16),
          whiteMat,
        );
        upperBand.position.y = 1.02;
        root.add(base, cone, lowerBand, upperBand);
      } else if (kind === "crate") {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(2.18, 2.18, 2.18),
          crateMat,
        );
        box.position.y = 1.16;
        root.add(box);
        for (const z of [-1.13, 1.13]) {
          for (const y of [0.22, 2.1]) {
            const beam = new THREE.Mesh(
              new THREE.BoxGeometry(2.48, 0.22, 0.18),
              crateFrameMat,
            );
            beam.position.set(0, y, z);
            root.add(beam);
          }
          for (const x of [-1.12, 1.12]) {
            const beam = new THREE.Mesh(
              new THREE.BoxGeometry(0.22, 2.34, 0.18),
              crateFrameMat,
            );
            beam.position.set(x, 1.16, z);
            root.add(beam);
          }
          for (const rotation of [-0.73, 0.73]) {
            const brace = new THREE.Mesh(
              new THREE.BoxGeometry(2.72, 0.17, 0.14),
              crateFrameMat,
            );
            brace.position.set(0, 1.16, z + Math.sign(z) * 0.05);
            brace.rotation.z = rotation;
            root.add(brace);
          }
        }
      } else if (kind === "oil") {
        for (let i = 0; i < 4; i++) {
          const oil = new THREE.Mesh(
            new THREE.CircleGeometry(1.5 + (i % 2) * 0.5, 24),
            oilMat,
          );
          oil.rotation.x = -Math.PI / 2;
          oil.rotation.z = i * 0.72;
          oil.scale.set(1.35, 0.72 + (i % 3) * 0.16, 1);
          oil.position.set(
            Math.cos(i * 1.9) * 0.72,
            0.025 + i * 0.002,
            Math.sin(i * 1.7) * 0.48,
          );
          root.add(oil);
        }
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.58, 0.58, 1.55, 18),
          barrelMat,
        );
        barrel.rotation.z = Math.PI / 2;
        barrel.position.set(1.45, 0.58, 0.38);
        root.add(barrel);
        for (const x of [0.93, 1.97]) {
          const ring = new THREE.Mesh(
            new THREE.CylinderGeometry(0.61, 0.61, 0.1, 18),
            postMat,
          );
          ring.rotation.z = Math.PI / 2;
          ring.position.set(x, 0.58, 0.38);
          root.add(ring);
        }
      } else {
        for (const y of [1.18, 2.05]) {
          const rail = new THREE.Mesh(
            new THREE.BoxGeometry(5.35, 0.62, 0.32),
            barrierMat,
          );
          rail.position.y = y;
          root.add(rail);
          for (let stripeIndex = 0; stripeIndex < 6; stripeIndex++) {
            const stripe = new THREE.Mesh(
              new THREE.BoxGeometry(0.5, 0.65, 0.075),
              redMat,
            );
            stripe.position.set(-2.15 + stripeIndex * 0.86, y, -0.195);
            stripe.rotation.z = -0.55;
            root.add(stripe);
          }
        }
        for (const x of [-2.05, 2.05]) {
          const post = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 2.45, 0.32),
            postMat,
          );
          post.position.set(x, 1.25, 0);
          const foot = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.16, 1.55),
            postMat,
          );
          foot.position.set(x, 0.08, 0);
          const lampBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.25, 0.18, 10),
            postMat,
          );
          lampBase.position.set(x, 2.55, 0);
          const lamp = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 12, 8),
            warningLightMat,
          );
          lamp.position.set(x, 2.78, 0);
          root.add(post, foot, lampBase, lamp);
        }
      }
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = true;
      });
      setTrackPosition(root.position, progress, lane, 0, levelIndex);
      root.rotation.y = roadAngle(progress, levelIndex);
      world.add(root);
      obstacles.push({
        root,
        progress,
        lane,
        halfWidth,
        halfLength,
        kind,
        hit: false,
      });
    };
    const obstacleKinds: Obstacle["kind"][] = ["cone", "crate", "oil", "cone", "barrier"];
    const obstacleHitboxes = {
      cone: { halfWidth: 0.56, halfLength: 0.56 },
      crate: { halfWidth: 1.14, halfLength: 1.14 },
      oil: { halfWidth: 2.15, halfLength: 1.2 },
      barrier: { halfWidth: 2.72, halfLength: 0.72 },
    };
    for (let i = 0; i < LEVELS[LEVELS.length - 1].hazards; i++) {
      const kind = obstacleKinds[i % obstacleKinds.length];
      const hitbox = obstacleHitboxes[kind];
      addObstacle(
        kind,
        70 + i * 30,
        0,
        hitbox.halfWidth,
        hitbox.halfLength,
      );
    }

    const playerRoot = new THREE.Group();
    const playerVisual = new THREE.Group();
    playerRoot.add(playerVisual);
    world.add(playerRoot);
    const initialPlayer = fallbackCar(0xf4d03f);
    playerVisual.add(initialPlayer);
    let playerWheels = rigWheels(initialPlayer);

    const cops: Cop[] = [];
    const lightMaterial = (color: number) =>
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 5 });
    const addLightBar = (root: THREE.Group) => {
      const red = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.28), lightMaterial(0xff294b));
      const blue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.28), lightMaterial(0x248fff));
      red.position.set(-0.32, 1.65, -0.34);
      blue.position.set(0.32, 1.65, -0.34);
      root.add(red, blue);
      return { red, blue };
    };
    const copFormation = [-3.5, 3.5, 0, -6.5, 6.5];
    for (let i = 0; i < 5; i++) {
      const root = new THREE.Group();
      const visual = new THREE.Group();
      const car = fallbackCar(0xe9eef3, true);
      visual.add(car);
      root.add(visual);
      const lights = addLightBar(root);
      world.add(root);
      cops.push({
        root,
        visual,
        wheels: rigWheels(car),
        progress: -24 - i * 12,
        lane: copFormation[i],
        phase: i * 2.1,
        wheelSpin: 0,
        yaw: roadAngle(0, levelIndex),
        targetLane: copFormation[i],
        stun: 0,
        impactLean: 0,
        ...lights,
      });
    }

    const deferredAssetUpdates: Array<() => void> = [];
    const runWhenHostActive = (update: () => void) => {
      if (youtubePlayables.getState().paused) {
        deferredAssetUpdates.push(update);
      } else {
        update();
      }
    };
    let loaded = 0;
    const assetLoaded = () => {
      runWhenHostActive(() => {
        loaded++;
        if (loaded >= 2 && statusRef.current) {
          statusRef.current.textContent = "READY TO RUN";
        }
      });
    };
    const loader = new GLTFLoader();
    loader.load(
      "./models/player-car.glb",
      (gltf) => {
        runWhenHostActive(() => {
          playerVisual.clear();
          const car = gltf.scene;
          car.scale.setScalar(0.009);
          car.position.y = 0.02;
          playerVisual.add(car);
          playerWheels = rigWheels(car);
          assetLoaded();
        });
      },
      undefined,
      assetLoaded,
    );
    loader.load(
      "./models/police-car.glb",
      (gltf) => {
        runWhenHostActive(() => {
          cops.forEach((cop) => {
            cop.visual.clear();
            const car = gltf.scene.clone(true);
            car.scale.setScalar(1.25);
            car.position.y = 0.03;
            cop.visual.add(car);
            cop.wheels = rigWheels(car);
          });
          assetLoaded();
        });
      },
      undefined,
      assetLoaded,
    );

    const particles: Particle[] = [];
    const particleGeo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
    const particleColors = [0xffd85a, 0xff6b35, 0xe8edf0, 0x74d38a, 0x55b7ff];
    const particlePoolSize = mobileRendering ? 64 : 96;
    for (let i = 0; i < particlePoolSize; i++) {
      const mesh = new THREE.Mesh(
        particleGeo,
        new THREE.MeshBasicMaterial({ color: particleColors[i % particleColors.length] }),
      );
      mesh.visible = false;
      world.add(mesh);
      particles.push({ mesh, velocity: new THREE.Vector3(), life: 0 });
    }
    let particleIndex = 0;
    const emit = (position: THREE.Vector3, count: number, power: number, party = false) => {
      for (let i = 0; i < count; i++) {
        const p = particles[particleIndex++ % particles.length];
        p.mesh.visible = true;
        p.mesh.position.copy(position);
        p.mesh.position.x += (Math.random() - 0.5) * 2;
        p.mesh.scale.setScalar(party ? 1.8 : 1);
        p.velocity.set(
          (Math.random() - 0.5) * power,
          Math.random() * power * (party ? 1.3 : 0.65),
          (Math.random() - 0.5) * power,
        );
        p.life = party ? 2.4 + Math.random() : 0.55 + Math.random() * 0.45;
      }
    };

    const input = { left: false, right: false, gas: false, brake: false, boost: false, touch: 0 };
    let gamePhase: Phase = "menu";
    let progress = 0;
    let lane = 0;
    let lateral = 0;
    let previousLateral = 0;
    let headingOffset = 0;
    let speed = 0;
    let steer = 0;
    let bust = 0;
    let nitro = 100;
    let shake = 0;
    let cooldown = 0;
    let spin = 0;
    let playerYaw = roadAngle(0, levelIndex);
    let time = 0;
    let audio: AudioContext | null = null;
    let master: GainNode | null = null;
    let musicBus: GainNode | null = null;
    let musicTimer: ReturnType<typeof setInterval> | null = null;
    let noiseBuffer: AudioBuffer | null = null;
    let nextMusicTime = 0;
    let musicStep = 0;
    let muted = initialCloudSave.playerMuted;
    let completedThrough = initialCloudSave.completedThrough;
    let resumeLevel = initialCloudSave.resumeLevel;
    const persistCloudState = () =>
      youtubePlayables.saveCloudData(
        serializeCloudSave(
          {
            completedThrough,
            resumeLevel,
            playerMuted: muted,
          },
          LEVELS.length,
        ),
      );
    const campaignScore = () => completedThrough + 1;
    void youtubePlayables.sendScore(campaignScore());

    const scheduleKick = (when: number, intensity: number) => {
      if (!audio || !musicBus) return;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(152, when);
      oscillator.frequency.exponentialRampToValueAtTime(43, when + 0.12);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.235 * intensity, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.19);
      oscillator.connect(gain).connect(musicBus);
      oscillator.start(when);
      oscillator.stop(when + 0.21);
    };
    const scheduleNoise = (
      when: number,
      duration: number,
      frequency: number,
      volume: number,
    ) => {
      if (!audio || !musicBus || !noiseBuffer) return;
      const source = audio.createBufferSource();
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      source.buffer = noiseBuffer;
      filter.type = frequency > 4000 ? "highpass" : "bandpass";
      filter.frequency.value = frequency;
      filter.Q.value = frequency > 4000 ? 0.7 : 1.2;
      gain.gain.setValueAtTime(volume, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      source.connect(filter).connect(gain).connect(musicBus);
      source.start(when);
      source.stop(when + duration);
    };
    const scheduleBass = (
      when: number,
      frequency: number,
      duration: number,
      intensity: number,
    ) => {
      if (!audio || !musicBus) return;
      const oscillator = audio.createOscillator();
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(frequency, when);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(170 + intensity * 260, when);
      filter.Q.value = 4.5;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.062 * intensity, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      oscillator.connect(filter).connect(gain).connect(musicBus);
      oscillator.start(when);
      oscillator.stop(when + duration + 0.03);
    };
    const schedulePulse = (
      when: number,
      frequency: number,
      intensity: number,
    ) => {
      if (!audio || !musicBus) return;
      const oscillator = audio.createOscillator();
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, when);
      filter.type = "lowpass";
      filter.frequency.value = 1450 + intensity * 900;
      filter.Q.value = 2.2;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.019 * intensity, when + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.095);
      oscillator.connect(filter).connect(gain).connect(musicBus);
      oscillator.start(when);
      oscillator.stop(when + 0.11);
    };
    const scheduleTom = (
      when: number,
      frequency: number,
      intensity: number,
      pan: number,
    ) => {
      if (!audio || !musicBus) return;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const panner = audio.createStereoPanner();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency * 1.8, when);
      oscillator.frequency.exponentialRampToValueAtTime(frequency, when + 0.14);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.065 * intensity, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
      panner.pan.value = pan;
      oscillator.connect(gain).connect(panner).connect(musicBus);
      oscillator.start(when);
      oscillator.stop(when + 0.24);
    };
    const scheduleChordStab = (
      when: number,
      rootFrequency: number,
      intensity: number,
      pan: number,
    ) => {
      if (!audio || !musicBus) return;
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      const panner = audio.createStereoPanner();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1150 + intensity * 720, when);
      filter.Q.value = 1.35;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.018 * intensity, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
      panner.pan.value = pan;
      filter.connect(gain).connect(panner).connect(musicBus);
      [1, 1.1892, 1.4983].forEach((ratio, index) => {
        const oscillator = audio!.createOscillator();
        oscillator.type = index === 0 ? "sawtooth" : "triangle";
        oscillator.frequency.setValueAtTime(rootFrequency * ratio, when);
        oscillator.detune.value = (index - 1) * 4;
        oscillator.connect(filter);
        oscillator.start(when);
        oscillator.stop(when + 0.26);
      });
    };
    const scheduleTensionSweep = (
      when: number,
      frequency: number,
      intensity: number,
      duration: number,
    ) => {
      if (!audio || !musicBus) return;
      const oscillator = audio.createOscillator();
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      const panner = audio.createStereoPanner();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(frequency, when);
      oscillator.frequency.exponentialRampToValueAtTime(
        frequency * 1.5,
        when + duration,
      );
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(900, when);
      filter.frequency.exponentialRampToValueAtTime(2400, when + duration);
      filter.Q.value = 3.2;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.012 * intensity, when + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      panner.pan.value = Math.sin(musicStep * 0.7) * 0.48;
      oscillator.connect(filter).connect(gain).connect(panner).connect(musicBus);
      oscillator.start(when);
      oscillator.stop(when + duration + 0.02);
    };
    const scheduleMusic = () => {
      if (
        !audio ||
        !musicBus ||
        audio.state !== "running" ||
        hostPaused ||
        !hostAudioEnabled ||
        muted
      ) {
        return;
      }
      const sixteenth = 60 / 136 / 4;
      const bassRoots = [73.42, 65.41, 58.27, 55];
      const bassRatios = [
        1, 1, 1.1892, 1, 1, 0.8909, 1, 1.1892,
        1, 1.4983, 1.1892, 1, 0.8909, 1, 1.1892, 1.3348,
      ];
      const pulseRatios = [4, 4.7568, 5.9932, 7.1272, 5.9932, 4.7568, 7.1272, 5.3394];
      if (nextMusicTime < audio.currentTime) {
        nextMusicTime = audio.currentTime + 0.035;
      }
      while (nextMusicTime < audio.currentTime + 0.18) {
        const step = musicStep % 16;
        const phrase = Math.floor(musicStep / 16) % bassRoots.length;
        const bassRoot = bassRoots[phrase];
        const intensity =
          gamePhase === "playing"
            ? THREE.MathUtils.clamp(0.78 + speed / 110 + bust / 210, 0.78, 1.34)
            : 0.56;
        if ([0, 5, 8, 11].includes(step)) {
          scheduleKick(nextMusicTime, intensity);
        }
        if (step === 4 || step === 12) {
          scheduleNoise(nextMusicTime, 0.18, 1500, 0.095 * intensity);
          scheduleNoise(nextMusicTime, 0.1, 4200, 0.034 * intensity);
        }
        if (step === 3 || step === 14) {
          scheduleTom(
            nextMusicTime,
            step === 3 ? bassRoot * 1.5 : bassRoot * 1.25,
            intensity,
            step === 3 ? -0.42 : 0.42,
          );
        }
        scheduleNoise(
          nextMusicTime,
          step % 4 === 3 ? 0.075 : 0.035,
          6800,
          (step % 2 === 0 ? 0.03 : 0.014) * intensity,
        );
        if (step % 2 === 0 || step === 11) {
          scheduleBass(
            nextMusicTime,
            bassRoot * bassRatios[step],
            sixteenth * (step % 4 === 0 ? 1.8 : 0.88),
            intensity,
          );
        }
        if (step % 2 === 1) {
          schedulePulse(
            nextMusicTime,
            bassRoot * pulseRatios[Math.floor(step / 2) % pulseRatios.length],
            intensity,
          );
        }
        if ([2, 7, 10, 15].includes(step)) {
          scheduleChordStab(
            nextMusicTime,
            bassRoot * 2,
            intensity,
            step % 4 < 2 ? -0.28 : 0.28,
          );
        }
        if (step === 12 && gamePhase === "playing") {
          scheduleTensionSweep(
            nextMusicTime,
            bassRoot * 2,
            intensity,
            sixteenth * 3.8,
          );
        }
        nextMusicTime += sixteenth;
        musicStep++;
      }
    };
    const stopMusicScheduler = () => {
      if (!musicTimer) return;
      clearInterval(musicTimer);
      musicTimer = null;
    };
    const startMusicScheduler = () => {
      if (
        musicTimer ||
        !audio ||
        audio.state !== "running" ||
        hostPaused ||
        !hostAudioEnabled ||
        muted
      ) {
        return;
      }
      nextMusicTime = audio.currentTime + 0.05;
      scheduleMusic();
      musicTimer = setInterval(scheduleMusic, 45);
    };
    const refreshSoundButton = () => {
      if (!hostAudioEnabled) {
        soundButton.textContent = "YOUTUBE MUTED";
        soundButton.setAttribute("aria-label", "Audio muted by YouTube");
        soundButton.disabled = true;
        return;
      }
      setSoundOn(!muted);
      soundButton.disabled = hostPaused;
    };
    const syncAudioPolicy = () => {
      refreshSoundButton();
      if (!audio || !master) return;

      const shouldOutput = hostAudioEnabled && !hostPaused && !muted;
      master.gain.cancelScheduledValues(audio.currentTime);
      master.gain.setValueAtTime(shouldOutput ? 0.28 : 0, audio.currentTime);

      if (!hostAudioEnabled || hostPaused || muted) {
        stopMusicScheduler();
        if (audio.state === "running") void audio.suspend();
        return;
      }

      void audio.resume().then(() => {
        if (hostAudioEnabled && !hostPaused && !muted) {
          startMusicScheduler();
        }
      });
    };
    const setupAudio = () => {
      if (audio) {
        syncAudioPolicy();
        return;
      }
      audio = new AudioContext();
      master = audio.createGain();
      master.gain.value = 0;
      const compressor = audio.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 10;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.16;
      master.connect(compressor).connect(audio.destination);

      musicBus = audio.createGain();
      musicBus.gain.value = 1;
      const lowShelf = audio.createBiquadFilter();
      const presence = audio.createBiquadFilter();
      lowShelf.type = "lowshelf";
      lowShelf.frequency.value = 165;
      lowShelf.gain.value = 2.4;
      presence.type = "peaking";
      presence.frequency.value = 2800;
      presence.Q.value = 0.7;
      presence.gain.value = 1.6;
      const delay = audio.createDelay(0.5);
      const feedback = audio.createGain();
      const delayWet = audio.createGain();
      delay.delayTime.value = 0.22;
      feedback.gain.value = 0.2;
      delayWet.gain.value = 0.16;
      musicBus.connect(lowShelf).connect(presence).connect(master);
      musicBus.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(delayWet).connect(presence);

      noiseBuffer = audio.createBuffer(
        1,
        Math.floor(audio.sampleRate * 0.32),
        audio.sampleRate,
      );
      const noise = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noise.length; i++) {
        noise[i] = Math.random() * 2 - 1;
      }

      musicStep = 0;
      syncAudioPolicy();
    };

    const configureTrack = () => {
      const level = currentLevel();
      roadPieces.forEach(({ progress: p, shoulder, road, line }) => {
        const rp = Math.max(0, p);
        const visible = p <= level.length + 24;
        const x = roadCenter(rp, levelIndex);
        const angle = roadAngle(rp, levelIndex);
        shoulder.visible = visible;
        road.visible = visible;
        shoulder.position.set(x, -0.28, -p);
        road.position.set(x, -0.13, -p);
        shoulder.rotation.y = angle;
        road.rotation.y = angle;
        shoulder.scale.x = (level.roadEdge + 3) / 17;
        road.scale.x = level.roadEdge / 14;
        if (line) {
          line.visible = visible;
          line.position.set(x, 0.065, -p);
          line.rotation.y = angle;
        }
      });
      rebuildRoadRibbon();
      rebuildGrassFields();

      buildings.forEach(({ mesh, progress: p, side, offset }) => {
        mesh.visible = p < level.length + 10;
        const frame = roadFrame(p, levelIndex);
        const sideDistance = offset + Math.max(0, 14 - level.roadEdge);
        mesh.position.set(
          frame.centerX + side * frame.normalX * sideDistance,
          -0.2,
          -p + side * frame.normalZ * sideDistance,
        );
        mesh.rotation.y = roadAngle(p, levelIndex) + Math.PI / 2;
      });

      const towerDummy = new THREE.Object3D();
      const roofDummy = new THREE.Object3D();
      const windowFrameDummy = new THREE.Object3D();
      const windowPaneDummy = new THREE.Object3D();
      const facadeOffset = new THREE.Vector3();
      const facadeYAxis = new THREE.Vector3(0, 1, 0);
      backgroundBuildingData.forEach((building, i) => {
        const visible = building.progress < level.length + 28;
        const visibilityScale = visible ? 1 : 0;
        const frame = roadFrame(building.progress, levelIndex);
        const sideDistance =
          building.offset + Math.max(0, 14 - level.roadEdge);
        const x =
          frame.centerX + building.side * frame.normalX * sideDistance;
        const z =
          -building.progress + building.side * frame.normalZ * sideDistance;
        const angle = roadAngle(building.progress, levelIndex) + Math.PI / 2;

        towerDummy.position.set(x, building.height / 2 - 0.18, z);
        towerDummy.rotation.set(0, angle, 0);
        towerDummy.scale.set(
          building.width * visibilityScale,
          building.height * visibilityScale,
          building.depth * visibilityScale,
        );
        towerDummy.updateMatrix();
        backgroundTowers.setMatrixAt(i, towerDummy.matrix);

        roofDummy.position.set(x, building.height + 0.02, z);
        roofDummy.rotation.set(0, angle, 0);
        roofDummy.scale.set(
          (building.width + 0.65) * visibilityScale,
          0.42 * visibilityScale,
          (building.depth + 0.65) * visibilityScale,
        );
        roofDummy.updateMatrix();
        backgroundRoofs.setMatrixAt(i, roofDummy.matrix);

        for (let row = 0; row < BACKGROUND_WINDOW_ROWS; row++) {
          for (let column = 0; column < BACKGROUND_WINDOW_COLUMNS; column++) {
            const windowIndex =
              i * BACKGROUND_WINDOWS_PER_BUILDING +
              row * BACKGROUND_WINDOW_COLUMNS +
              column;
            const localX =
              -building.width * 0.32 +
              column *
                ((building.width * 0.64) /
                  Math.max(1, BACKGROUND_WINDOW_COLUMNS - 1));
            const y =
              2.15 +
              row *
                ((building.height - 4.2) /
                  Math.max(1, BACKGROUND_WINDOW_ROWS - 1));
            facadeOffset
              .set(localX, 0, building.depth / 2 + 0.065)
              .applyAxisAngle(facadeYAxis, angle);
            windowFrameDummy.position.set(
              x + facadeOffset.x,
              y,
              z + facadeOffset.z,
            );
            windowFrameDummy.rotation.set(0, angle, 0);
            windowFrameDummy.scale.set(
              0.92 * visibilityScale,
              0.9 * visibilityScale,
              visibilityScale,
            );
            windowFrameDummy.updateMatrix();
            backgroundWindowFrames.setMatrixAt(
              windowIndex,
              windowFrameDummy.matrix,
            );

            facadeOffset
              .set(localX, 0, building.depth / 2 + 0.13)
              .applyAxisAngle(facadeYAxis, angle);
            windowPaneDummy.position.set(
              x + facadeOffset.x,
              y,
              z + facadeOffset.z,
            );
            windowPaneDummy.rotation.set(0, angle, 0);
            windowPaneDummy.scale.set(
              0.62 * visibilityScale,
              0.58 * visibilityScale,
              visibilityScale,
            );
            windowPaneDummy.updateMatrix();
            backgroundWindows.setMatrixAt(
              windowIndex,
              windowPaneDummy.matrix,
            );
          }
        }
      });
      backgroundTowers.instanceMatrix.needsUpdate = true;
      backgroundRoofs.instanceMatrix.needsUpdate = true;
      backgroundWindowFrames.instanceMatrix.needsUpdate = true;
      backgroundWindows.instanceMatrix.needsUpdate = true;

      const patchDummy = new THREE.Object3D();
      for (let i = 0; i < GRASS_PATCH_COUNT; i++) {
        const p = 16 + i * 5.55;
        const visible = p < level.length + 24;
        const side = i % 2 === 0 ? -1 : 1;
        const frame = roadFrame(p, levelIndex);
        const sideDistance =
          level.roadEdge + 12.5 + ((i * 11) % 8) * 3.25;
        const scale = visible ? 0.9 + (i % 6) * 0.16 : 0;
        patchDummy.position.set(
          frame.centerX + side * frame.normalX * sideDistance,
          -0.195,
          -p + side * frame.normalZ * sideDistance,
        );
        patchDummy.rotation.set(0, i * 1.37, 0);
        patchDummy.scale.set(scale * (1.1 + (i % 3) * 0.22), scale, scale);
        patchDummy.updateMatrix();
        grassPatches.setMatrixAt(i, patchDummy.matrix);
      }
      grassPatches.instanceMatrix.needsUpdate = true;

      const grassDummy = new THREE.Object3D();
      for (let i = 0; i < GRASS_COUNT; i++) {
        const p = 14 + i * 2.7;
        const visible = p < level.length + 18;
        const side = i % 2 === 0 ? -1 : 1;
        const frame = roadFrame(p, levelIndex);
        const sideDistance =
          level.roadEdge + 10.5 + ((i * 7) % 11) * 2.35;
        const scale = visible ? 1.05 + (i % 6) * 0.13 : 0;
        grassDummy.position.set(
          frame.centerX + side * frame.normalX * sideDistance,
          -0.19,
          -p + side * frame.normalZ * sideDistance,
        );
        grassDummy.rotation.set(0, i * 1.91, 0);
        grassDummy.scale.set(scale * (0.85 + (i % 3) * 0.12), scale, scale);
        grassDummy.updateMatrix();
        grass.setMatrixAt(i, grassDummy.matrix);
      }
      grass.instanceMatrix.needsUpdate = true;

      const trunkDummy = new THREE.Object3D();
      const crownDummy = new THREE.Object3D();
      for (let i = 0; i < TREE_COUNT; i++) {
        const p = 34 + i * 17.7;
        const visible = p < level.length + 25;
        const side = i % 2 === 0 ? -1 : 1;
        const frame = roadFrame(p, levelIndex);
        const sideDistance =
          level.roadEdge + 24 + ((i * 5) % 5) * 5.6;
        const scale = visible ? 0.74 + (i % 5) * 0.11 : 0;
        const x = frame.centerX + side * frame.normalX * sideDistance;
        const z = -p + side * frame.normalZ * sideDistance;

        trunkDummy.position.set(x, 1.4 * scale - 0.19, z);
        trunkDummy.rotation.set(0, i * 0.73, 0);
        trunkDummy.scale.set(scale, scale, scale);
        trunkDummy.updateMatrix();
        treeTrunks.setMatrixAt(i, trunkDummy.matrix);

        crownDummy.position.set(x, 3.75 * scale - 0.19, z);
        crownDummy.rotation.set(0, i * 0.91, (i % 3 - 1) * 0.08);
        crownDummy.scale.set(scale * 1.08, scale, scale * 1.08);
        crownDummy.updateMatrix();
        treeCrowns.setMatrixAt(i, crownDummy.matrix);
      }
      treeTrunks.instanceMatrix.needsUpdate = true;
      treeCrowns.instanceMatrix.needsUpdate = true;

      clouds.forEach((cloud, i) => {
        cloud.root.visible = cloud.progress < level.length + 150;
        cloud.baseX =
          roadCenter(cloud.progress, levelIndex) +
          (i % 2 ? -1 : 1) * (22 + (i % 4) * 11);
        cloud.root.position.set(
          cloud.baseX,
          22 + (i % 4) * 3.8,
          -cloud.progress,
        );
      });
      directionSign.position.set(roadCenter(120, levelIndex) - level.roadEdge - 4, 4.2, -120);
      directionSign.rotation.y = roadAngle(120, levelIndex);
      trackArches.forEach(({ root, progress: p }) => {
        root.visible = p < level.length - 45;
        root.position.set(roadCenter(p, levelIndex), 0, -p);
        root.rotation.y = roadAngle(p, levelIndex);
        root.scale.x = level.roadEdge / 14;
      });
      finish.position.set(roadCenter(level.length, levelIndex), 0, -level.length);
      finish.rotation.y = roadAngle(level.length, levelIndex);

      const usableLength = level.length - 145;
      obstacles.forEach((obstacle, i) => {
        const active = i < level.hazards;
        const progressOnTrack = 72 + (i / Math.max(1, level.hazards - 1)) * usableLength;
        const laneLimit = Math.max(
          3.2,
          level.roadEdge - (obstacle.kind === "barrier" ? 4.2 : 2.3),
        );
        const laneWave =
          Math.sin((i + 1) * 2.41 + levelIndex * 1.17) * 0.72 +
          Math.sin((i + 3) * 0.83 + levelIndex) * 0.28;
        obstacle.progress = progressOnTrack;
        obstacle.lane = THREE.MathUtils.clamp(laneWave * laneLimit, -laneLimit, laneLimit);
        obstacle.hit = false;
        obstacle.root.visible = active;
        setTrackPosition(
          obstacle.root.position,
          obstacle.progress,
          obstacle.lane,
          0,
          levelIndex,
        );
        obstacle.root.rotation.set(0, roadAngle(obstacle.progress, levelIndex), 0);
      });
    };

    const driveableLaneLimit = () =>
      Math.max(2.5, currentLevel().roadEdge - PLAYER_HALF_WIDTH - 0.28);

    const choosePoliceLane = (cop: Cop, index: number, copSpeed: number) => {
      const laneLimit = driveableLaneLimit();
      const mastery = THREE.MathUtils.clamp(0.66 + levelIndex * 0.035, 0, 0.98);
      const formationOffset =
        copFormation[index] * (0.3 + levelIndex * 0.014);
      const pursuitLane = THREE.MathUtils.clamp(
        lane +
          formationOffset +
          Math.sin(time * (0.52 + index * 0.05) + cop.phase) *
            (1.05 - mastery * 0.42),
        -laneLimit,
        laneLimit,
      );
      const lookAhead = 20 + copSpeed * 0.34 + levelIndex * 1.65;
      const safety = 0.42 + mastery * 0.42;
      const candidates = [pursuitLane];
      const laneStep = 1.9;
      for (let candidate = -laneLimit; candidate <= laneLimit; candidate += laneStep) {
        candidates.push(candidate);
      }
      candidates.push(laneLimit, -laneLimit);

      let bestLane = pursuitLane;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        let score = Math.abs(candidate - pursuitLane) * (0.72 + mastery * 0.32);
        score += Math.abs(candidate - cop.lane) * (0.2 - mastery * 0.08);

        for (const obstacle of obstacles) {
          if (!obstacle.root.visible || obstacle.hit) continue;
          const ahead = obstacle.progress - cop.progress;
          if (ahead < -COP_HALF_LENGTH || ahead > lookAhead) continue;
          const requiredClearance =
            COP_HALF_WIDTH + obstacle.halfWidth + safety;
          const clearance = Math.abs(candidate - obstacle.lane);
          const urgency = 1 - THREE.MathUtils.clamp(ahead / lookAhead, 0, 1);
          if (clearance < requiredClearance) {
            score += (requiredClearance - clearance + 0.4) * (32 + urgency * 120);
          } else {
            score += urgency * 0.45 / Math.max(0.25, clearance - requiredClearance);
          }
        }

        for (let otherIndex = 0; otherIndex < currentLevel().cops; otherIndex++) {
          if (otherIndex === index) continue;
          const other = cops[otherIndex];
          const progressGap = Math.abs(other.progress - cop.progress);
          if (progressGap > 12) continue;
          const requiredSeparation = 2 * COP_HALF_WIDTH + 0.28;
          const laneGap = Math.abs(candidate - other.lane);
          if (laneGap < requiredSeparation) {
            score +=
              (requiredSeparation - laneGap + 0.2) *
              (16 + (1 - progressGap / 12) * 48);
          }
        }

        if (score < bestScore) {
          bestScore = score;
          bestLane = candidate;
        }
      }
      return THREE.MathUtils.clamp(bestLane, -laneLimit, laneLimit);
    };

    const reset = () => {
      progress = 0;
      lane = 0;
      lateral = 0;
      previousLateral = 0;
      headingOffset = 0;
      speed = 0;
      steer = 0;
      bust = 0;
      nitro = 100;
      shake = 0;
      cooldown = 0;
      spin = 0;
      playerYaw = roadAngle(0, levelIndex);
      time = 0;
      const startX = roadCenter(0, levelIndex);
      playerRoot.position.set(startX, 0.03, 0);
      playerRoot.rotation.y = roadAngle(0, levelIndex);
      setTrackPosition(camera.position, -12, 0, 6.4, levelIndex);
      setTrackPosition(smoothedLook, 12, 0, 1.05, levelIndex);
      particles.forEach((particle) => {
        particle.life = 0;
        particle.mesh.visible = false;
      });
      obstacles.forEach((o, i) => {
        o.hit = false;
        o.root.visible = i < currentLevel().hazards;
        o.root.rotation.x = 0;
        o.root.rotation.z = 0;
        o.root.rotation.y = roadAngle(o.progress, levelIndex);
        setTrackPosition(o.root.position, o.progress, o.lane, 0, levelIndex);
      });
      cops.forEach((cop, i) => {
        cop.progress = -24 - i * 12;
        cop.lane = copFormation[i];
        cop.targetLane = copFormation[i];
        cop.wheelSpin = 0;
        cop.yaw = roadAngle(0, levelIndex);
        cop.stun = 0;
        cop.impactLean = 0;
        cop.visual.rotation.z = 0;
        cop.root.visible = i < currentLevel().cops;
      });
    };
    const beginLevel = (nextLevel: number) => {
      if (hostPaused) return;
      levelIndex = THREE.MathUtils.clamp(nextLevel, 0, LEVELS.length - 1);
      resumeLevel = levelIndex;
      setDisplayLevel(levelIndex);
      configureTrack();
      reset();
      gamePhase = "playing";
      setPhase("playing");
      setupAudio();
      void persistCloudState();
    };
    configureTrack();
    actions.current = {
      start: () => beginLevel(resumeLevel),
      retry: () => beginLevel(levelIndex),
      next: () => beginLevel(Math.min(levelIndex + 1, LEVELS.length - 1)),
      sound: () => {
        if (hostPaused || !hostAudioEnabled) return;
        muted = !muted;
        syncAudioPolicy();
        void persistCloudState();
      },
    };
    playButton.addEventListener("click", () => actions.current?.start());
    soundButton.addEventListener("click", () => actions.current?.sound());
    resultButton.addEventListener("click", () => {
      if (hostPaused) return;
      if (gamePhase === "won" && levelIndex < LEVELS.length - 1) {
        actions.current?.next();
      } else if (gamePhase === "busted") {
        actions.current?.retry();
      } else {
        actions.current?.start();
      }
    });

    const onKey = (event: KeyboardEvent, down: boolean) => {
      if (hostPaused) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === "ArrowLeft" || event.code === "KeyA") input.left = down;
      if (event.code === "ArrowRight" || event.code === "KeyD") input.right = down;
      if (event.code === "ArrowUp" || event.code === "KeyW") input.gas = down;
      if (event.code === "ArrowDown" || event.code === "KeyS" || event.code === "Space") input.brake = down;
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") input.boost = down;
      if (down && event.code === "Enter" && gamePhase !== "playing") {
        if (gamePhase === "won" && levelIndex < LEVELS.length - 1) actions.current?.next();
        else if (gamePhase === "busted") actions.current?.retry();
        else actions.current?.start();
      }
    };
    const keyDown = (e: KeyboardEvent) => onKey(e, true);
    const keyUp = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", keyDown, { passive: false });
    window.addEventListener("keyup", keyUp);

    const bindHold = (id: string, field: "gas" | "brake" | "boost") => {
      const el = document.getElementById(id);
      const down = (e: PointerEvent) => {
        if (hostPaused) return;
        e.preventDefault();
        input[field] = true;
        el?.setPointerCapture(e.pointerId);
      };
      const up = () => {
        input[field] = false;
      };
      el?.addEventListener("pointerdown", down);
      el?.addEventListener("pointerup", up);
      el?.addEventListener("pointercancel", up);
      return () => {
        el?.removeEventListener("pointerdown", down);
        el?.removeEventListener("pointerup", up);
        el?.removeEventListener("pointercancel", up);
      };
    };
    const unbindGas = bindHold("gas-control", "gas");
    const unbindBrake = bindHold("brake-control", "brake");
    const unbindBoost = bindHold("boost-control", "boost");
    const steerPad = document.getElementById("steer-control");
    const updateSteer = (e: PointerEvent) => {
      if (!steerPad || hostPaused) return;
      const rect = steerPad.getBoundingClientRect();
      input.touch = THREE.MathUtils.clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
      if (knobRef.current) knobRef.current.style.transform = `translateX(${input.touch * 38}px)`;
      steerPad.setAttribute("aria-valuenow", input.touch.toFixed(2));
    };
    const steerDown = (e: PointerEvent) => {
      if (hostPaused) return;
      e.preventDefault();
      steerPad?.setPointerCapture(e.pointerId);
      updateSteer(e);
    };
    const steerMove = (e: PointerEvent) => {
      if (hostPaused) return;
      if (steerPad?.hasPointerCapture(e.pointerId)) updateSteer(e);
    };
    const steerUp = () => {
      input.touch = 0;
      if (knobRef.current) knobRef.current.style.transform = "translateX(0)";
      steerPad?.setAttribute("aria-valuenow", "0");
    };
    steerPad?.addEventListener("pointerdown", steerDown);
    steerPad?.addEventListener("pointermove", steerMove);
    steerPad?.addEventListener("pointerup", steerUp);
    steerPad?.addEventListener("pointercancel", steerUp);

    const resize = () => {
      if (hostPaused) return;
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.fov = camera.aspect < 0.72 ? 64 : camera.aspect < 1.15 ? 59 : 56;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, mobileRendering ? 1.25 : 1.6),
      );
    };
    window.addEventListener("resize", resize);
    resize();

    const clock = new THREE.Clock();
    const camPosition = new THREE.Vector3();
    const lookPosition = new THREE.Vector3();
    const smoothedLook = new THREE.Vector3(roadCenter(0, levelIndex), 1.05, -12);
    const effectPosition = new THREE.Vector3();
    let raf = 0;
    let firstFrameReported = false;
    let gameReadyReported = false;
    const animate = () => {
      if (hostPaused) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.035);
      time += dt;
      cooldown = Math.max(0, cooldown - dt);

      if (gamePhase === "playing") {
        const previousProgress = progress;
        const previousLane = lane;
        const keys = (input.left ? -1 : 0) + (input.right ? 1 : 0);
        const rawSteer = Math.abs(input.touch) > 0.03 ? input.touch : keys;
        const targetSteer =
          Math.sign(rawSteer) * Math.pow(Math.abs(rawSteer), 1.18);
        const speedRatio = THREE.MathUtils.clamp(speed / 38, 0, 1);
        const counterSteering = targetSteer * steer < -0.02;
        const steeringResponse =
          THREE.MathUtils.lerp(10.8, 7.6, speedRatio) +
          (counterSteering ? 3.4 : 0);
        steer = THREE.MathUtils.damp(
          steer,
          targetSteer,
          rawSteer === 0 ? steeringResponse + 3 : steeringResponse,
          dt,
        );
        const boosting = input.boost && nitro > 0.5 && speed > 8;
        const autoGas = coarsePointer && !input.brake;
        if (input.gas || autoGas) speed += (boosting ? 20 : 13.5) * dt;
        else speed -= 4.5 * dt;
        if (input.brake) speed -= 28 * dt;
        speed = THREE.MathUtils.clamp(speed, 0, boosting ? 48 : 38);
        if (boosting) {
          nitro = Math.max(0, nitro - 22 * dt);
          if (Math.random() < 0.65) {
            setTrackPosition(
              effectPosition,
              progress - 2.4,
              lane,
              0.35,
              levelIndex,
            );
            emit(effectPosition, 1, 2.2);
          }
        } else {
          nitro = Math.min(100, nitro + 5.5 * dt);
        }
        const steeringAuthority = THREE.MathUtils.smoothstep(speed, 0.8, 7);
        const maximumHeading = THREE.MathUtils.lerp(0.34, 0.23, speedRatio);
        const targetHeading = steer * maximumHeading * steeringAuthority;
        headingOffset = dampAngle(
          headingOffset,
          targetHeading,
          THREE.MathUtils.lerp(9.4, 6.7, speedRatio) +
            (counterSteering ? 1.6 : 0),
          dt,
        );
        const targetLateralSpeed =
          Math.sin(headingOffset) *
          speed *
          THREE.MathUtils.lerp(0.88, 0.99, speedRatio);
        lateral = THREE.MathUtils.damp(
          lateral,
          targetLateralSpeed,
          boosting ? 5.4 : 6.6,
          dt,
        );
        const upcomingTurn = Math.atan2(
          Math.sin(
            roadAngle(progress + 3, levelIndex) -
              roadAngle(progress, levelIndex),
          ),
          Math.cos(
            roadAngle(progress + 3, levelIndex) -
              roadAngle(progress, levelIndex),
          ),
        );
        lateral +=
          upcomingTurn *
          speed *
          speed *
          (0.009 + levelIndex * 0.0007) *
          dt;
        const laneLimit = driveableLaneLimit();
        const requestedLane = lane + lateral * dt;
        lane = THREE.MathUtils.clamp(requestedLane, -laneLimit, laneLimit);
        if (lane !== requestedLane) {
          lateral *= -0.16;
          headingOffset *= -0.2;
          speed = Math.max(0, speed - 18 * dt);
          shake = Math.max(shake, 0.12);
          if (Math.random() < 0.3) {
            setTrackPosition(
              effectPosition,
              progress - 2,
              lane,
              0.1,
              levelIndex,
            );
            emit(effectPosition, 1, 1.2);
          }
        }
        progress += speed * Math.max(0.88, Math.cos(headingOffset)) * dt;
        spin -= speed * dt * 1.55;
        playerWheels.forEach(({ steerPivot, spinPivot, front }) => {
          spinPivot.rotation.x = spin;
          steerPivot.rotation.y = front
            ? THREE.MathUtils.damp(
                steerPivot.rotation.y,
                -steer * THREE.MathUtils.lerp(0.44, 0.34, speedRatio),
                13,
                dt,
              )
            : 0;
        });
        if (Math.abs(steer) > 0.58 && speed > 20 && Math.random() < 0.38) {
          setTrackPosition(
            effectPosition,
            progress - 1.7,
            lane - steer * 0.8,
            0.15,
            levelIndex,
          );
          emit(effectPosition, 1, 1.6);
        }

        for (const obstacle of obstacles) {
          if (!obstacle.root.visible) continue;
          if (obstacle.hit) {
            obstacle.root.rotation.x += dt * 3.8;
            obstacle.root.rotation.z += dt * 2.4;
            obstacle.root.position.y -= dt * 0.65;
            continue;
          }
          const collisionLane = laneAtProgress(
            previousProgress,
            progress,
            previousLane,
            lane,
            obstacle.progress,
          );
          if (
            sweptProgressDistance(
              previousProgress,
              progress,
              obstacle.progress,
            ) <= PLAYER_HALF_LENGTH + obstacle.halfLength &&
            Math.abs(collisionLane - obstacle.lane) <=
              PLAYER_HALF_WIDTH + obstacle.halfWidth
          ) {
            obstacle.hit = true;
            speed *= obstacle.kind === "oil" ? 0.72 : 0.5;
            const impactDirection = collisionLane > obstacle.lane ? 1 : -1;
            lateral += impactDirection * 9;
            headingOffset += impactDirection * 0.07;
            shake = 0.85;
            setTrackPosition(
              effectPosition,
              obstacle.progress,
              obstacle.lane,
              0.8,
              levelIndex,
            );
            emit(effectPosition, obstacle.kind === "oil" ? 8 : 18, 7);
          }
        }

        const activeCopCount = currentLevel().cops;
        for (let index = 0; index < activeCopCount; index++) {
          const cop = cops[index];
          const distance = progress - cop.progress;
          const grip = currentLevel().policeGrip;
          const catchup =
            distance > 28
              ? 6 * grip
              : distance > 12
                ? 2.8 * grip
                : distance < 6.2
                  ? -2.5
                  : 0.6 * grip;
          cop.stun = Math.max(0, cop.stun - dt);
          const baseCopSpeed = THREE.MathUtils.clamp(
            Math.max(speed, 4.5) + catchup + index * 0.25,
            2,
            43,
          );
          const copSpeed = baseCopSpeed * (cop.stun > 0 ? 0.32 : 1);
          const chaseGap = 6.2 + (index % 2) * 1.7 + Math.floor(index / 2) * 2.7;
          const previousCopProgress = cop.progress;
          const previousCopLane = cop.lane;
          cop.progress = Math.min(
            cop.progress + copSpeed * dt,
            progress - chaseGap,
          );
          cop.wheelSpin -= copSpeed * dt * 1.55;
          cop.targetLane = choosePoliceLane(cop, index, copSpeed);
          cop.lane = THREE.MathUtils.damp(
            cop.lane,
            cop.targetLane,
            (2.15 + levelIndex * 0.11) * grip,
            dt,
          );
          cop.lane = THREE.MathUtils.clamp(
            cop.lane,
            -driveableLaneLimit(),
            driveableLaneLimit(),
          );

          for (const obstacle of obstacles) {
            if (!obstacle.root.visible || obstacle.hit) continue;
            const collisionLane = laneAtProgress(
              previousCopProgress,
              cop.progress,
              previousCopLane,
              cop.lane,
              obstacle.progress,
            );
            if (
              sweptProgressDistance(
                previousCopProgress,
                cop.progress,
                obstacle.progress,
              ) <= COP_HALF_LENGTH + obstacle.halfLength &&
              Math.abs(collisionLane - obstacle.lane) <=
                COP_HALF_WIDTH + obstacle.halfWidth
            ) {
              obstacle.hit = true;
              cop.stun = 0.62;
              cop.progress = THREE.MathUtils.lerp(
                previousCopProgress,
                cop.progress,
                obstacle.kind === "oil" ? 0.72 : 0.38,
              );
              const impactDirection = collisionLane >= obstacle.lane ? 1 : -1;
              cop.lane = THREE.MathUtils.clamp(
                cop.lane + impactDirection * 0.48,
                -driveableLaneLimit(),
                driveableLaneLimit(),
              );
              cop.impactLean = -impactDirection * 0.14;
              setTrackPosition(
                effectPosition,
                obstacle.progress,
                obstacle.lane,
                0.75,
                levelIndex,
              );
              emit(effectPosition, obstacle.kind === "oil" ? 5 : 11, 5.5);
              break;
            }
          }
        }

        const minimumPoliceLaneGap = COP_HALF_WIDTH * 2 + 0.2;
        const minimumPoliceProgressGap = COP_HALF_LENGTH * 2 + 0.25;
        for (let first = 0; first < activeCopCount; first++) {
          for (let second = first + 1; second < activeCopCount; second++) {
            const a = cops[first];
            const b = cops[second];
            const progressGap = Math.abs(a.progress - b.progress);
            const laneGap = Math.abs(a.lane - b.lane);
            if (
              progressGap >= minimumPoliceProgressGap ||
              laneGap >= minimumPoliceLaneGap
            ) {
              continue;
            }

            const direction =
              laneGap > 0.05
                ? Math.sign(a.lane - b.lane)
                : (first + second) % 2 === 0
                  ? 1
                  : -1;
            const push = (minimumPoliceLaneGap - laneGap) * 0.52;
            const laneLimit = driveableLaneLimit();
            a.lane = THREE.MathUtils.clamp(a.lane + direction * push, -laneLimit, laneLimit);
            b.lane = THREE.MathUtils.clamp(b.lane - direction * push, -laneLimit, laneLimit);

            if (
              Math.abs(a.lane - b.lane) < minimumPoliceLaneGap * 0.82 &&
              Math.abs(a.progress - b.progress) < minimumPoliceProgressGap
            ) {
              const leading = a.progress >= b.progress ? a : b;
              const trailing = leading === a ? b : a;
              trailing.progress = Math.min(
                trailing.progress,
                leading.progress - minimumPoliceProgressGap,
              );
            }
          }
        }

        let pressure = 0;
        for (let index = 0; index < activeCopCount; index++) {
          const cop = cops[index];
          const grip = currentLevel().policeGrip;
          setTrackPosition(
            cop.root.position,
            cop.progress,
            cop.lane,
            0.02,
            levelIndex,
          );
          const copTargetYaw =
            roadAngle(cop.progress, levelIndex) -
            THREE.MathUtils.clamp(
              (cop.targetLane - cop.lane) * 0.05,
              -0.24,
              0.24,
            );
          cop.yaw = dampAngle(cop.yaw, copTargetYaw, 7.5 * grip, dt);
          cop.root.rotation.y = cop.yaw;
          cop.visual.rotation.z = THREE.MathUtils.damp(
            cop.visual.rotation.z,
            cop.impactLean,
            10,
            dt,
          );
          cop.impactLean = THREE.MathUtils.damp(cop.impactLean, 0, 5, dt);
          cop.wheels.forEach(({ steerPivot, spinPivot, front }) => {
            spinPivot.rotation.x = cop.wheelSpin;
            steerPivot.rotation.y = front
              ? THREE.MathUtils.damp(
                  steerPivot.rotation.y,
                  -(cop.targetLane - cop.lane) * 0.09,
                  11,
                  dt,
                )
              : 0;
          });
          const flash = Math.sin(time * 8 + cop.phase) > 0;
          (cop.red.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 6 : 0.35;
          (cop.blue.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 0.35 : 6;
          const distance = progress - cop.progress;
          const lateralGap = Math.abs(cop.lane - lane);
          if (distance < 10.5 && distance > -2 && lateralGap < 5.8) {
            pressure +=
              (1 - Math.max(distance, 0) / 11.5) *
              (1 - lateralGap / 6.2);
            if (distance < 7.2 && lateralGap < 2.2 && cooldown <= 0) {
              lateral += (lane > cop.lane ? 1 : -1) * 4.5;
              speed *= 0.92;
              shake = 0.32;
              cooldown = 0.55;
            }
          }
        }
        bust = THREE.MathUtils.clamp(
          bust +
            (pressure > 0.05
              ? Math.max(0.22, pressure) * (26 + levelIndex * 1.1)
              : -(4.2 - levelIndex * 0.08)) *
              dt,
          0,
          100,
        );
        if (progress >= currentLevel().length) {
          gamePhase = "won";
          completedThrough = Math.max(completedThrough, levelIndex);
          resumeLevel =
            levelIndex < LEVELS.length - 1 ? levelIndex + 1 : 0;
          void persistCloudState().then(() =>
            youtubePlayables.sendScore(campaignScore()),
          );
          setPhase("won");
          speed = 18;
          setTrackPosition(
            effectPosition,
            currentLevel().length,
            0,
            1,
            levelIndex,
          );
          emit(effectPosition, 90, 12, true);
        } else if (bust >= 100) {
          gamePhase = "busted";
          setPhase("busted");
          speed = 0;
        }
      } else if (gamePhase === "won") {
        headingOffset = dampAngle(headingOffset, 0, 4.5, dt);
        lateral = THREE.MathUtils.damp(lateral, 0, 4, dt);
        progress += speed * Math.max(0.9, Math.cos(headingOffset)) * dt;
        speed = Math.max(0, speed - 7 * dt);
      }

      setTrackPosition(playerRoot.position, progress, lane, 0.03, levelIndex);
      const playerX = playerRoot.position.x;
      const playerTargetYaw = roadAngle(progress, levelIndex) - headingOffset;
      playerYaw = dampAngle(playerYaw, playerTargetYaw, 9, dt);
      playerRoot.rotation.y = playerYaw;
      const lateralAcceleration =
        (lateral - previousLateral) / Math.max(dt, 0.001);
      previousLateral = lateral;
      const corneringRoll = THREE.MathUtils.clamp(
        -headingOffset * (0.2 + Math.min(speed / 38, 1) * 0.16) -
          lateralAcceleration * 0.0025,
        -0.105,
        0.105,
      );
      playerVisual.rotation.z = THREE.MathUtils.damp(
        playerVisual.rotation.z,
        corneringRoll,
        8.5,
        dt,
      );
      const ratio = speed / 38;
      const cameraDistance = 11.5 + ratio * 2.5;
      setTrackPosition(
        camPosition,
        progress - cameraDistance,
        lane,
        6.3 + ratio * 1.4,
        levelIndex,
      );
      if (shake > 0.01) {
        camPosition.x += (Math.random() - 0.5) * shake;
        camPosition.y += (Math.random() - 0.5) * shake * 0.5;
        shake *= Math.exp(-8 * dt);
      }
      camera.position.lerp(camPosition, 1 - Math.exp(-7.2 * dt));
      setTrackPosition(
        lookPosition,
        progress + 11 + ratio * 8,
        lane,
        1.05,
        levelIndex,
      );
      smoothedLook.lerp(lookPosition, 1 - Math.exp(-8.5 * dt));
      camera.lookAt(smoothedLook);
      sun.position.set(playerX - 35, 55, -progress + 20);
      sun.target.position.set(playerX, 0, -progress - 10);

      clouds.forEach((cloud) => {
        if (!cloud.root.visible) return;
        cloud.root.position.x =
          cloud.baseX + Math.sin(time * 0.09 + cloud.phase) * 4.5;
      });

      particles.forEach((p) => {
        if (p.life <= 0) return;
        p.life -= dt;
        p.mesh.position.addScaledVector(p.velocity, dt);
        p.velocity.y -= 9 * dt;
        p.mesh.rotation.x += dt * 6;
        p.mesh.rotation.z += dt * 4;
        p.mesh.scale.multiplyScalar(Math.max(0.92, 1 - dt * 0.7));
        if (p.life <= 0) p.mesh.visible = false;
      });
      if (audio && musicBus) {
        const musicLevel =
          gamePhase === "playing"
            ? 1.06
            : gamePhase === "won"
              ? 0.84
              : 0.64;
        musicBus.gain.setTargetAtTime(musicLevel, audio.currentTime, 0.14);
      }
      if (speedRef.current) speedRef.current.textContent = String(Math.round(speed * 6.1));
      if (distanceRef.current) {
        distanceRef.current.textContent = `${Math.max(
          0,
          Math.ceil(currentLevel().length - progress),
        )}m`;
      }
      if (bustRef.current) bustRef.current.style.width = `${bust}%`;
      if (nitroRef.current) nitroRef.current.style.width = `${nitro}%`;
      if (routeRef.current) {
        routeRef.current.style.width = `${Math.min(
          100,
          (progress / currentLevel().length) * 100,
        )}%`;
      }
      renderer.render(scene, camera);
      if (!firstFrameReported) {
        youtubePlayables.firstFrameReady();
        firstFrameReported = true;
      }
      if (!gameReadyReported && loaded >= 2) {
        playButton.disabled = false;
        youtubePlayables.gameReady();
        gameReadyReported = true;
      }
    };
    const startAnimationLoop = () => {
      if (hostPaused || raf !== 0) return;
      clock.getDelta();
      animate();
    };
    const clearInput = () => {
      input.left = false;
      input.right = false;
      input.gas = false;
      input.brake = false;
      input.boost = false;
      input.touch = 0;
      knobRef.current.style.transform = "translateX(0)";
    };
    const applyYouTubeState = (state: YouTubePlayablesState) => {
      const wasPaused = hostPaused;
      if (state.paused && !wasPaused) void persistCloudState();
      hostPaused = state.paused;
      hostAudioEnabled = state.audioEnabled;
      gameShell.inert = hostPaused;
      gameShell.classList.toggle("youtube-paused", hostPaused);
      playButton.disabled = hostPaused || loaded < 2;

      if (hostPaused) {
        cancelAnimationFrame(raf);
        raf = 0;
        clearInput();
        syncAudioPolicy();
        return;
      }

      if (wasPaused) {
        const pendingUpdates = deferredAssetUpdates.splice(
          0,
          deferredAssetUpdates.length,
        );
        pendingUpdates.forEach((update) => update());
        resize();
        clock.getDelta();
      }
      syncAudioPolicy();
      startAnimationLoop();
    };
    const removeYouTubeStateListener =
      youtubePlayables.onStateChange(applyYouTubeState);

    const cleanup = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("resize", resize);
      unbindGas();
      unbindBrake();
      unbindBoost();
      steerPad?.removeEventListener("pointerdown", steerDown);
      steerPad?.removeEventListener("pointermove", steerMove);
      steerPad?.removeEventListener("pointerup", steerUp);
      steerPad?.removeEventListener("pointercancel", steerUp);
      stopMusicScheduler();
      removeYouTubeStateListener();
      youtubePlayables.destroy();
      void audio?.close();
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m?.dispose?.());
      });
      actions.current = null;
    };
    window.addEventListener("beforeunload", cleanup, { once: true });
    setDisplayLevel(levelIndex);
    const playButtonLabel = playButton.querySelector("span");
    if (playButtonLabel && resumeLevel > 0) {
      playButtonLabel.textContent = `CONTINUE LEVEL ${resumeLevel + 1}`;
    }
    setPhase("menu");
    applyYouTubeState(youtubePlayables.getState());
}
