"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type Phase = "menu" | "playing" | "won" | "busted";
type Wheel = { node: THREE.Object3D; front: boolean };
type Cop = {
  root: THREE.Group;
  visual: THREE.Group;
  wheels: Wheel[];
  progress: number;
  lane: number;
  phase: number;
  red: THREE.Mesh;
  blue: THREE.Mesh;
};
type Obstacle = {
  root: THREE.Object3D;
  progress: number;
  lane: number;
  radius: number;
  kind: "cone" | "crate" | "barrier" | "oil";
  hit: boolean;
};
type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
};

const FINISH = 860;
const ROAD_EDGE = 14;

function roadCenter(p: number) {
  return (
    Math.sin(p * 0.011) * 13 +
    Math.sin(p * 0.027 + 0.7) * 5 +
    Math.sin(p * 0.004) * 8
  );
}

function roadAngle(p: number) {
  const d = 0.5;
  return Math.atan2(roadCenter(p + d) - roadCenter(p - d), -d * 2);
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
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const name = mesh.name.toLowerCase();
    if (!name.includes("wheel")) return;
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    mesh.geometry.boundingBox?.getCenter(center);
    mesh.geometry.translate(-center.x, -center.y, -center.z);
    mesh.position.add(center);
    wheels.push({
      node: mesh,
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

export default function PursuitGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const distanceRef = useRef<HTMLSpanElement>(null);
  const bustRef = useRef<HTMLDivElement>(null);
  const nitroRef = useRef<HTMLDivElement>(null);
  const routeRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const actions = useRef<{ start: () => void; sound: () => void } | null>(null);
  const [phase, setPhase] = useState<Phase>("menu");
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x76c9f4);
    scene.fog = new THREE.Fog(0x9bd7ec, 70, 195);
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 650);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xc9efff, 0x6b915a, 2.2);
    const sun = new THREE.DirectionalLight(0xfff1cf, 3.15);
    sun.position.set(-35, 55, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -38;
    sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -22;
    sun.shadow.camera.far = 120;
    scene.add(hemi, sun, sun.target);
    const world = new THREE.Group();
    scene.add(world);

    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1600),
      new THREE.MeshStandardMaterial({ color: 0x50b6d0, roughness: 0.55, metalness: 0.06 }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(0, -0.62, -450);
    world.add(ocean);
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 980),
      new THREE.MeshStandardMaterial({ color: 0x79c66a, roughness: 1 }),
    );
    island.rotation.x = -Math.PI / 2;
    island.position.set(0, -0.5, -450);
    island.receiveShadow = true;
    world.add(island);

    const roadMat = new THREE.MeshStandardMaterial({ color: 0x313b46, roughness: 0.9 });
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0xb8a57c, roughness: 1 });
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0xfff0a1,
      emissive: 0x514714,
      emissiveIntensity: 0.2,
    });
    for (let p = -16; p <= FINISH + 24; p += 8) {
      const rp = Math.max(0, p);
      const x = roadCenter(rp);
      const angle = roadAngle(rp);
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
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 3.7), lineMat);
        line.position.set(x, 0.02, -p);
        line.rotation.y = angle;
        world.add(line);
      }
    }

    const trunkInstances = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.25, 0.4, 2.3, 6),
      new THREE.MeshStandardMaterial({ color: 0x75513a, roughness: 1 }),
      76,
    );
    const crownInstances = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.45, 3.5, 7),
      new THREE.MeshStandardMaterial({ color: 0x278b5c, roughness: 1 }),
      76,
    );
    trunkInstances.castShadow = true;
    crownInstances.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 76; i++) {
      const p = 14 + i * 11.5;
      const side = i % 2 ? -1 : 1;
      const scale = 0.75 + (i % 5) * 0.09;
      const x = roadCenter(p) + side * (23 + (i % 4) * 4);
      dummy.position.set(x, 0.65, -p);
      dummy.scale.setScalar(scale);
      dummy.rotation.y = i * 1.7;
      dummy.updateMatrix();
      trunkInstances.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 3;
      dummy.updateMatrix();
      crownInstances.setMatrixAt(i, dummy.matrix);
    }
    world.add(trunkInstances, crownInstances);

    const buildingColors = [0xff906d, 0xffcb62, 0x9c8cf1, 0x62c6b5];
    for (let i = 0; i < 22; i++) {
      const p = 92 + i * 35;
      const h = 5 + (i % 4) * 1.8;
      const building = new THREE.Mesh(
        new THREE.BoxGeometry(7 + (i % 3) * 2, h, 7),
        new THREE.MeshStandardMaterial({ color: buildingColors[i % 4], roughness: 0.92 }),
      );
      building.position.set(
        roadCenter(p) + (i % 2 ? -1 : 1) * (35 + (i % 3) * 4),
        h / 2 - 0.2,
        -p,
      );
      building.rotation.y = (i % 3) * 0.18;
      building.castShadow = true;
      building.receiveShadow = true;
      world.add(building);
    }
    const directionSign = billboard("KEEP MOVING  ››");
    directionSign.position.set(roadCenter(120) - 18, 4.2, -120);
    directionSign.rotation.y = roadAngle(120);
    world.add(directionSign);

    const finish = new THREE.Group();
    finish.position.set(roadCenter(FINISH), 0, -FINISH);
    finish.rotation.y = roadAngle(FINISH);
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
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.8 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xfff1d1, roughness: 0.75 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0xa66537, roughness: 1 });
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0xf1efe4, roughness: 0.78 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xef3e52, roughness: 0.7 });

    const addObstacle = (
      kind: Obstacle["kind"],
      progress: number,
      lane: number,
      radius: number,
    ) => {
      const root = new THREE.Group();
      if (kind === "cone") {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.45, 8), coneMat);
        cone.position.y = 0.72;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.43, 0.2, 8), whiteMat);
        band.position.y = 0.66;
        root.add(cone, band);
      } else if (kind === "crate") {
        const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), crateMat);
        box.position.y = 1.1;
        root.add(box);
      } else if (kind === "oil") {
        const oil = new THREE.Mesh(
          new THREE.CircleGeometry(2.2, 18),
          new THREE.MeshStandardMaterial({ color: 0x111923, roughness: 0.18, metalness: 0.35 }),
        );
        oil.rotation.x = -Math.PI / 2;
        oil.position.y = 0.04;
        root.add(oil);
      } else {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.05, 0.55), barrierMat);
        rail.position.y = 1.15;
        root.add(rail);
        for (const x of [-1.4, 0, 1.4]) {
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.08, 0.58), redMat);
          stripe.position.set(x, 1.15, -0.02);
          stripe.rotation.z = -0.45;
          root.add(stripe);
        }
        for (const x of [-1.9, 1.9]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.4, 0.3), postMat);
          leg.position.set(x, 0.55, 0);
          root.add(leg);
        }
      }
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = true;
      });
      root.position.set(roadCenter(progress) + lane, 0, -progress);
      root.rotation.y = roadAngle(progress);
      world.add(root);
      obstacles.push({ root, progress, lane, radius, kind, hit: false });
    };
    const obstaclePlan: Array<[Obstacle["kind"], number, number, number]> = [
      ["cone", 72, -4, 1.2], ["cone", 76, 0, 1.2], ["cone", 80, 4, 1.2],
      ["crate", 142, -5, 1.8], ["crate", 142, 4, 1.8], ["oil", 205, 2, 2.4],
      ["barrier", 264, -6, 3.4], ["cone", 268, 5, 1.2],
      ["crate", 338, -2, 1.8], ["crate", 342, 4, 1.8], ["oil", 410, -5, 2.4],
      ["barrier", 472, 5, 3.4], ["barrier", 538, -5, 3.4],
      ["cone", 592, -5, 1.2], ["cone", 596, -1, 1.2], ["cone", 600, 3, 1.2],
      ["crate", 658, 0, 1.8], ["oil", 716, 5, 2.4],
      ["barrier", 774, -5, 3.4], ["crate", 808, 4, 1.8],
    ];
    obstaclePlan.forEach((item) => addObstacle(...item));

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
    for (let i = 0; i < 3; i++) {
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
        lane: i === 0 ? -3.5 : i === 1 ? 4 : 0,
        phase: i * 2.1,
        ...lights,
      });
    }

    let loaded = 0;
    const assetLoaded = () => {
      loaded++;
      if (loaded >= 2 && statusRef.current) statusRef.current.textContent = "READY TO RUN";
    };
    const loader = new GLTFLoader();
    loader.load(
      "/models/player-car.glb",
      (gltf) => {
        playerVisual.clear();
        const car = gltf.scene;
        car.scale.setScalar(0.009);
        car.position.y = 0.02;
        playerVisual.add(car);
        playerWheels = rigWheels(car);
        assetLoaded();
      },
      undefined,
      assetLoaded,
    );
    loader.load(
      "/models/police-car.glb",
      (gltf) => {
        cops.forEach((cop) => {
          cop.visual.clear();
          const car = gltf.scene.clone(true);
          car.scale.setScalar(1.25);
          car.position.y = 0.03;
          cop.visual.add(car);
          cop.wheels = rigWheels(car);
        });
        assetLoaded();
      },
      undefined,
      assetLoaded,
    );

    const particles: Particle[] = [];
    const particleGeo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
    const particleColors = [0xffd85a, 0xff6b35, 0xe8edf0, 0x74d38a, 0x55b7ff];
    for (let i = 0; i < 96; i++) {
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
    let speed = 0;
    let steer = 0;
    let bust = 0;
    let nitro = 100;
    let shake = 0;
    let cooldown = 0;
    let spin = 0;
    let time = 0;
    let audio: AudioContext | null = null;
    let master: GainNode | null = null;
    let engine: OscillatorNode | null = null;
    let engineGain: GainNode | null = null;
    let siren: OscillatorNode | null = null;
    let sirenGain: GainNode | null = null;
    let muted = false;

    const setupAudio = () => {
      if (audio) {
        void audio.resume();
        return;
      }
      audio = new AudioContext();
      master = audio.createGain();
      master.gain.value = muted ? 0 : 0.12;
      master.connect(audio.destination);
      engine = audio.createOscillator();
      engineGain = audio.createGain();
      engine.type = "sawtooth";
      engine.frequency.value = 55;
      engineGain.gain.value = 0.025;
      engine.connect(engineGain).connect(master);
      engine.start();
      siren = audio.createOscillator();
      sirenGain = audio.createGain();
      siren.type = "square";
      sirenGain.gain.value = 0;
      siren.connect(sirenGain).connect(master);
      siren.start();
    };
    const impactSound = () => {
      if (!audio || !master || muted) return;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(115, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(38, audio.currentTime + 0.16);
      gain.gain.setValueAtTime(0.26, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
      osc.connect(gain).connect(master);
      osc.start();
      osc.stop(audio.currentTime + 0.2);
    };
    const reset = () => {
      progress = 0;
      lane = 0;
      lateral = 0;
      speed = 0;
      steer = 0;
      bust = 0;
      nitro = 100;
      shake = 0;
      time = 0;
      obstacles.forEach((o) => {
        o.hit = false;
        o.root.visible = true;
        o.root.rotation.x = 0;
        o.root.rotation.z = 0;
        o.root.position.set(roadCenter(o.progress) + o.lane, 0, -o.progress);
      });
      cops.forEach((cop, i) => {
        cop.progress = -24 - i * 12;
        cop.lane = i === 0 ? -3.5 : i === 1 ? 4 : 0;
      });
    };
    actions.current = {
      start: () => {
        reset();
        gamePhase = "playing";
        setPhase("playing");
        setupAudio();
      },
      sound: () => {
        muted = !muted;
        setSoundOn(!muted);
        if (audio && master) master.gain.setTargetAtTime(muted ? 0 : 0.12, audio.currentTime, 0.03);
      },
    };

    const onKey = (event: KeyboardEvent, down: boolean) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === "ArrowLeft" || event.code === "KeyA") input.left = down;
      if (event.code === "ArrowRight" || event.code === "KeyD") input.right = down;
      if (event.code === "ArrowUp" || event.code === "KeyW") input.gas = down;
      if (event.code === "ArrowDown" || event.code === "KeyS" || event.code === "Space") input.brake = down;
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") input.boost = down;
      if (down && event.code === "Enter" && gamePhase !== "playing") actions.current?.start();
    };
    const keyDown = (e: KeyboardEvent) => onKey(e, true);
    const keyUp = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", keyDown, { passive: false });
    window.addEventListener("keyup", keyUp);

    const bindHold = (id: string, field: "gas" | "brake" | "boost") => {
      const el = document.getElementById(id);
      const down = (e: PointerEvent) => {
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
      if (!steerPad) return;
      const rect = steerPad.getBoundingClientRect();
      input.touch = THREE.MathUtils.clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
      if (knobRef.current) knobRef.current.style.transform = `translateX(${input.touch * 38}px)`;
    };
    const steerDown = (e: PointerEvent) => {
      e.preventDefault();
      steerPad?.setPointerCapture(e.pointerId);
      updateSteer(e);
    };
    const steerMove = (e: PointerEvent) => {
      if (steerPad?.hasPointerCapture(e.pointerId)) updateSteer(e);
    };
    const steerUp = () => {
      input.touch = 0;
      if (knobRef.current) knobRef.current.style.transform = "translateX(0)";
    };
    steerPad?.addEventListener("pointerdown", steerDown);
    steerPad?.addEventListener("pointermove", steerMove);
    steerPad?.addEventListener("pointerup", steerUp);
    steerPad?.addEventListener("pointercancel", steerUp);

    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    };
    window.addEventListener("resize", resize);
    resize();

    const clock = new THREE.Clock();
    const camPosition = new THREE.Vector3();
    const lookPosition = new THREE.Vector3();
    const effectPosition = new THREE.Vector3();
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.035);
      time += dt;
      cooldown = Math.max(0, cooldown - dt);

      if (gamePhase === "playing") {
        const keys = (input.left ? -1 : 0) + (input.right ? 1 : 0);
        const targetSteer = Math.abs(input.touch) > 0.03 ? input.touch : keys;
        steer = THREE.MathUtils.damp(steer, targetSteer, 8, dt);
        const boosting = input.boost && nitro > 0.5 && speed > 8;
        const autoGas = window.matchMedia("(pointer: coarse)").matches && !input.brake;
        if (input.gas || autoGas) speed += (boosting ? 20 : 13.5) * dt;
        else speed -= 4.5 * dt;
        if (input.brake) speed -= 28 * dt;
        speed = THREE.MathUtils.clamp(speed, 0, boosting ? 48 : 38);
        if (boosting) {
          nitro = Math.max(0, nitro - 22 * dt);
          if (Math.random() < 0.65) {
            effectPosition.set(roadCenter(progress) + lane, 0.35, -progress + 2.4);
            emit(effectPosition, 1, 2.2);
          }
        } else {
          nitro = Math.min(100, nitro + 5.5 * dt);
        }
        lateral += steer * (17 + speed * 0.38) * dt;
        lateral *= Math.exp(-3.7 * dt);
        lane = THREE.MathUtils.clamp(lane + lateral * dt, -18, 18);
        if (Math.abs(lane) > ROAD_EDGE - 1.4) {
          speed = Math.max(0, speed - 15 * dt);
          if (Math.random() < 0.3) {
            effectPosition.set(roadCenter(progress) + lane, 0.1, -progress + 2);
            emit(effectPosition, 1, 1.2);
          }
        }
        progress += speed * dt;
        spin -= speed * dt * 1.55;
        playerWheels.forEach(({ node, front }) => {
          node.rotation.x = spin;
          if (front) node.rotation.y = -steer * 0.32;
        });
        if (Math.abs(steer) > 0.58 && speed > 20 && Math.random() < 0.38) {
          effectPosition.set(roadCenter(progress) + lane - steer * 0.8, 0.15, -progress + 1.7);
          emit(effectPosition, 1, 1.6);
        }

        for (const obstacle of obstacles) {
          if (obstacle.hit) {
            obstacle.root.rotation.x += dt * 3.8;
            obstacle.root.rotation.z += dt * 2.4;
            obstacle.root.position.y -= dt * 0.65;
            continue;
          }
          const playerX = roadCenter(progress) + lane;
          const obstacleX = roadCenter(obstacle.progress) + obstacle.lane;
          if (
            Math.abs(progress - obstacle.progress) < 2.7 &&
            Math.abs(playerX - obstacleX) < obstacle.radius + 1.15
          ) {
            obstacle.hit = true;
            speed *= obstacle.kind === "oil" ? 0.72 : 0.5;
            lateral += (playerX > obstacleX ? 1 : -1) * 9;
            shake = 0.85;
            impactSound();
            effectPosition.set(obstacleX, 0.8, -obstacle.progress);
            emit(effectPosition, obstacle.kind === "oil" ? 8 : 18, 7);
          }
        }

        let pressure = 0;
        cops.forEach((cop, index) => {
          const distance = progress - cop.progress;
          const catchup = distance > 32 ? 10 : distance > 16 ? 5 : distance < 7 ? -3 : 1.2;
          const copSpeed =
            speed < 5
              ? Math.max(0, speed * 0.75)
              : THREE.MathUtils.clamp(speed + catchup + index * 0.35, 7, 42);
          cop.progress = Math.min(cop.progress + copSpeed * dt, progress - 5.2);
          const desired = THREE.MathUtils.clamp(
            lane + Math.sin(time * (0.7 + index * 0.08) + cop.phase) * 2.2,
            -10.5,
            10.5,
          );
          cop.lane = THREE.MathUtils.damp(cop.lane, desired, 1.25, dt);
          const copX = roadCenter(cop.progress) + cop.lane;
          cop.root.position.set(copX, 0.02, -cop.progress);
          cop.root.rotation.y =
            roadAngle(cop.progress) - THREE.MathUtils.clamp((desired - cop.lane) * 0.05, -0.22, 0.22);
          cop.wheels.forEach(({ node, front }) => {
            node.rotation.x = spin * 1.07;
            if (front) node.rotation.y = -(desired - cop.lane) * 0.08;
          });
          const flash = Math.sin(time * 8 + cop.phase) > 0;
          (cop.red.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 6 : 0.35;
          (cop.blue.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 0.35 : 6;
          const lateralGap = Math.abs(copX - (roadCenter(progress) + lane));
          if (distance < 7.2 && distance > -2 && lateralGap < 4.5) {
            pressure += (1 - Math.max(distance, 0) / 9) * (1 - lateralGap / 5);
            if (lateralGap < 2.2 && cooldown <= 0) {
              lateral += (roadCenter(progress) + lane > copX ? 1 : -1) * 4.5;
              speed *= 0.92;
              shake = 0.32;
              cooldown = 0.55;
            }
          }
        });
        bust = THREE.MathUtils.clamp(bust + (pressure > 0.05 ? pressure * 12 : -6.5) * dt, 0, 100);
        if (progress >= FINISH) {
          gamePhase = "won";
          setPhase("won");
          speed = 18;
          effectPosition.set(roadCenter(FINISH), 1, -FINISH);
          emit(effectPosition, 90, 12, true);
        } else if (bust >= 100) {
          gamePhase = "busted";
          setPhase("busted");
          speed = 0;
        }
      } else if (gamePhase === "won") {
        progress += speed * dt;
        speed = Math.max(0, speed - 7 * dt);
      }

      const playerX = roadCenter(progress) + lane;
      playerRoot.position.set(playerX, 0.03, -progress);
      playerRoot.rotation.y = roadAngle(progress) - steer * 0.18 - lateral * 0.012;
      playerVisual.rotation.z = THREE.MathUtils.damp(
        playerVisual.rotation.z,
        -steer * Math.min(speed / 38, 1) * 0.07,
        7,
        dt,
      );
      const ratio = speed / 38;
      camPosition.set(playerX - steer * 0.7, 6.3 + ratio * 1.4, -progress + 11.5 + ratio * 2.5);
      if (shake > 0.01) {
        camPosition.x += (Math.random() - 0.5) * shake;
        camPosition.y += (Math.random() - 0.5) * shake * 0.5;
        shake *= Math.exp(-8 * dt);
      }
      camera.position.lerp(camPosition, 1 - Math.exp(-5.5 * dt));
      lookPosition.set(playerX, 1.05, -progress - 11 - ratio * 8);
      camera.lookAt(lookPosition);
      sun.position.set(playerX - 35, 55, -progress + 20);
      sun.target.position.set(playerX, 0, -progress - 10);

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
      if (audio && engine && engineGain && siren && sirenGain) {
        engine.frequency.setTargetAtTime(48 + speed * 4.2, audio.currentTime, 0.06);
        engineGain.gain.setTargetAtTime(gamePhase === "playing" ? 0.018 + speed * 0.001 : 0.008, audio.currentTime, 0.08);
        siren.frequency.setTargetAtTime(560 + Math.sin(time * 5) * 145, audio.currentTime, 0.02);
        sirenGain.gain.setTargetAtTime(gamePhase === "playing" ? 0.018 + bust * 0.00022 : 0, audio.currentTime, 0.08);
      }
      if (speedRef.current) speedRef.current.textContent = String(Math.round(speed * 6.1));
      if (distanceRef.current) distanceRef.current.textContent = `${Math.max(0, Math.ceil(FINISH - progress))}m`;
      if (bustRef.current) bustRef.current.style.width = `${bust}%`;
      if (nitroRef.current) nitroRef.current.style.width = `${nitro}%`;
      if (routeRef.current) routeRef.current.style.width = `${Math.min(100, (progress / FINISH) * 100)}%`;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
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
  }, []);

  return (
    <main className="game-shell">
      <div className="game-canvas" ref={mountRef} aria-label="3D pursuit game viewport" />
      <div className={`game-hud ${phase === "playing" ? "is-active" : ""}`}>
        <div className="top-bar">
          <section className="speed-card" aria-label="Current speed">
            <span className="hud-kicker">SPEED</span>
            <strong ref={speedRef}>0</strong>
            <small>KM/H</small>
          </section>
          <section className="mission-card">
            <span className="hud-kicker">EXTRACTION</span>
            <strong ref={distanceRef}>860m</strong>
            <div className="distance-track"><span ref={routeRef} /></div>
          </section>
          <button
            className="sound-button"
            type="button"
            aria-label={soundOn ? "Mute game audio" : "Turn on game audio"}
            onClick={() => actions.current?.sound()}
          >
            {soundOn ? "SOUND ON" : "MUTED"}
          </button>
        </div>
        <div className="danger-meter">
          <div className="danger-label"><span>CHASE PRESSURE</span><span>DON&apos;T GET BOXED IN</span></div>
          <div className="danger-track"><div ref={bustRef} /></div>
        </div>
        <div className="mobile-controls">
          <div
            className="steer-control"
            id="steer-control"
            role="slider"
            aria-label="Steering"
            aria-valuemin={-1}
            aria-valuemax={1}
            aria-valuenow={0}
          >
            <span className="steer-arrow">‹</span>
            <div className="steer-knob" ref={knobRef}><span /></div>
            <span className="steer-arrow">›</span>
          </div>
          <div className="pedal-stack">
            <button className="nitro-button" id="boost-control" type="button">
              <span>NITRO</span><i><b ref={nitroRef} /></i>
            </button>
            <div className="pedal-row">
              <button className="pedal brake" id="brake-control" type="button">BRAKE</button>
              <button className="pedal gas" id="gas-control" type="button">GAS</button>
            </div>
          </div>
        </div>
        <div className="desktop-hint">
          <span>WASD / ARROWS</span><b>STEER</b><span>SHIFT</span><b>NITRO</b><span>SPACE</span><b>BRAKE</b>
        </div>
      </div>

      {phase === "menu" && (
        <section className="start-screen">
          <div className="brand-lockup">
            <span className="eyebrow">ZYNTH ARCADE PRESENTS</span>
            <h1>HEATLINE<em>PURSUIT</em></h1>
            <p>Break the blockade. Lose the cops. Hit the extraction gate.</p>
            <div className="mission-pills"><span>3 UNITS ON YOUR TAIL</span><span>860M TO FREEDOM</span></div>
            <button className="play-button" type="button" onClick={() => actions.current?.start()}>
              <span>START ESCAPE</span><b>›</b>
            </button>
            <div className="asset-status"><i /><span ref={statusRef}>LOADING VEHICLES…</span></div>
          </div>
          <div className="start-tip">
            <span>DRIVER TIP</span>
            <p>Feather the steering at top speed. Nitro is strongest on straightaways.</p>
          </div>
        </section>
      )}

      {(phase === "won" || phase === "busted") && (
        <section className={`result-screen ${phase}`}>
          <div className="result-card">
            <span className="result-stamp">{phase === "won" ? "ESCAPED" : "PURSUIT ENDED"}</span>
            <h2>{phase === "won" ? "CLEAN GETAWAY!" : "BUSTED"}</h2>
            <p>
              {phase === "won"
                ? "You broke the perimeter and left the units in your dust."
                : "The units boxed you in. Keep moving and use the whole road."}
            </p>
            <button type="button" onClick={() => actions.current?.start()}>
              {phase === "won" ? "RUN IT AGAIN" : "RETRY ESCAPE"}
            </button>
            <small>PRESS ENTER TO RESTART</small>
          </div>
        </section>
      )}
    </main>
  );
}
