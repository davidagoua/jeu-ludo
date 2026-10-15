/*
 * Plateau de Ludo en 3D (Three.js / WebGL).
 *
 * Le module ne connaît aucune coordonnée de plateau : tout vient de
 * `Ludo.Board.geometry/0`, envoyée par le serveur. Les fonctions de conversion
 * géométrie -> monde 3D sont pures et exportées, ce qui permet de les vérifier
 * hors navigateur (scripts/three_check.mjs), WebGL n'étant pas testable ici.
 *
 * Intégration : `app.js` (script classique) pousse l'état via `window.Ludo3D`,
 * mis en place par ce module. Les deux se synchronisent par l'événement
 * `ludo3dready`, l'ordre de chargement des scripts n'étant pas garanti.
 */

import * as THREE from "./vendor/three.module.min.js";

/* ------------------------------------------------------------------ réglages */

export const BOARD = 15;
const CENTER_CELL = (BOARD - 1) / 2; // 7
const TILE_H = 0.18;
const TOP = TILE_H; // surface supérieure des cases
const TOKEN_R = 0.34;
const STEP_MS = 130; // durée d'un déplacement d'une case
const JUMP_MS = 420; // durée d'un saut (sortie de base, capture)
const HOP = 0.34; // hauteur d'un petit bond

/* ------------------------------------------------------- fonctions pures */

/** Centre (monde) d'une case de la grille. La case 7,7 est à l'origine. */
export function cellToWorld(x, y) {
  return { x: x - CENTER_CELL, z: y - CENTER_CELL };
}

/**
 * Position monde du pion `index` du joueur `color`, à la position logique
 * `position` (`"base"` ou un entier de 0 à `geo.finish`).
 *
 * Reproduit exactement la logique du plateau : anneau, puis colonne d'arrivée,
 * puis centre. Renvoie `null` si la position est inconnue.
 */
export function tokenWorldPosition(geo, color, index, position) {
  if (position === "base") {
    const slot = geo.bases[color][index];
    const p = cellToWorld(slot[0], slot[1]);
    return { x: p.x, z: p.z, y: TOP };
  }

  if (typeof position !== "number") return null;

  if (position <= geo.last_ring_position) {
    const idx = (geo.starts[color] + position) % geo.ring_size;
    const cell = geo.ring[idx];
    const p = cellToWorld(cell[0], cell[1]);
    return { x: p.x, z: p.z, y: TOP };
  }

  if (position < geo.finish) {
    const cell = geo.home_columns[color][position - geo.last_ring_position - 1];
    const p = cellToWorld(cell[0], cell[1]);
    return { x: p.x, z: p.z, y: TOP };
  }

  // arrivée : les quatre pions se rangent dans le triangle de leur couleur
  const entry = geo.center_entries[color];
  const p = cellToWorld(entry[0], entry[1]);
  const offsets = [
    [-0.22, -0.22],
    [0.22, -0.22],
    [-0.22, 0.22],
    [0.22, 0.22]
  ];
  const [ox, oz] = offsets[index] || [0, 0];
  return { x: p.x + ox, z: p.z + oz, y: TOP };
}

/**
 * Étapes logiques traversées entre deux positions d'un pion.
 *
 * Une avance sur l'anneau ou la colonne passe par toutes les cases
 * intermédiaires ; une sortie de base, une capture ou un retour à la base est
 * un saut direct.
 */
export function pathBetween(from, to) {
  if (from === to) return [];

  if (typeof from === "number" && typeof to === "number" && to > from) {
    const steps = [];
    for (let p = from + 1; p <= to; p++) steps.push(p);
    return steps;
  }

  return [to];
}

/**
 * Orientation à donner au dé pour montrer la face `value` vers le haut.
 *
 * Le dé est construit avec 1 en +Y, 6 en -Y, 2 en +Z, 5 en -Z, 3 en +X,
 * 4 en -X ; on renvoie l'angle d'Euler qui amène la bonne face en +Y.
 */
export const DICE_ORIENTATIONS = {
  1: [0, 0, 0],
  6: [Math.PI, 0, 0],
  2: [-Math.PI / 2, 0, 0],
  5: [Math.PI / 2, 0, 0],
  3: [0, 0, Math.PI / 2],
  4: [0, 0, -Math.PI / 2]
};

/** Normale locale de la face portant chaque valeur. */
export const DICE_NORMALS = {
  1: [0, 1, 0],
  6: [0, -1, 0],
  2: [0, 0, 1],
  5: [0, 0, -1],
  3: [1, 0, 0],
  4: [-1, 0, 0]
};

/** Les trois sommets (monde) du triangle de centre d'une couleur. */
export function centerTriangle(geo, color) {
  const entry = geo.center_entries[color];

  // Le carré central couvre 3 cases : ses bords sont à ±1,5 dans le repère
  // monde (la case centrale étant à l'origine), et non à des indices de case.
  const d = 1.5;

  let corners;
  if (entry[0] <= CENTER_CELL - 1) {
    corners = [[-d, -d], [-d, d]]; // bras gauche
  } else if (entry[0] >= CENTER_CELL + 1) {
    corners = [[d, -d], [d, d]]; // bras droit
  } else if (entry[1] <= CENTER_CELL - 1) {
    corners = [[-d, -d], [d, -d]]; // bras haut
  } else {
    corners = [[-d, d], [d, d]]; // bras bas
  }

  return [
    { x: corners[0][0], z: corners[0][1] },
    { x: corners[1][0], z: corners[1][1] },
    { x: 0, z: 0 }
  ];
}

/* ------------------------------------------------------------------ scène */

let renderer = null;
let scene = null;
let camera = null;
let root = null;
let boardGroup = null;
let tokensGroup = null;
let diceGroup = null;
let dicePivot = null;
let highlightGroup = null;

let geo = null;
const tokenNodes = new Map(); // "color:index" -> group
const basePlates = new Map(); // color -> mesh
let animations = [];
let dice = { value: null, rolling: false, target: new THREE.Quaternion() };
let activeBase = { color: null, t: 0 };
let clock = null;
let raycaster = null;
let pointer = new THREE.Vector2();
let orbit = { azimuth: 0, elevation: 0.95, radius: 17.5, targetRadius: 17.5 };
let dragging = false;
let lastPointer = { x: 0, y: 0 };
let handlers = { roll: null, token: null };
let ready = false;

const materials = new Map();

function material(color, options = {}) {
  const key = color + JSON.stringify(options);
  if (!materials.has(key)) {
    materials.set(
      key,
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.55,
        metalness: 0.05,
        ...options
      })
    );
  }
  return materials.get(key);
}

function addTile(parent, x, y, color, height = TILE_H) {
  const p = cellToWorld(x, y);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.96, height, 0.96), material(color));
  mesh.position.set(p.x, height / 2, p.z);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function starShape() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.3 : 0.13;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = r * Math.cos(a);
    const py = r * Math.sin(a);
    if (i === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  }
  shape.closePath();
  return shape;
}

/* --------------------------------------------------------- construction */

function buildBoard() {
  if (boardGroup) root.remove(boardGroup);
  boardGroup = new THREE.Group();
  root.add(boardGroup);

  // socle
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD + 0.7, 0.3, BOARD + 0.7),
    material("#111821", { roughness: 0.85 })
  );
  slab.position.y = -0.16;
  slab.receiveShadow = true;
  boardGroup.add(slab);

  const startOwner = {};
  for (const color of geo.players) startOwner[geo.starts[color]] = color;

  // anneau
  geo.ring.forEach(([x, y], index) => {
    const owner = startOwner[index];
    const safe = geo.safe_indexes.indexOf(index) !== -1;
    const color = owner ? geo.colors[owner] : safe ? "#eef4fa" : "#d9e2ec";
    addTile(boardGroup, x, y, color);

    if (safe) {
      const star = new THREE.Mesh(
        new THREE.ShapeGeometry(starShape()),
        material(owner ? "#ffffff" : "#8494a8")
      );
      const p = cellToWorld(x, y);
      star.rotation.x = -Math.PI / 2;
      star.position.set(p.x, TILE_H + 0.004, p.z);
      boardGroup.add(star);
    }
  });

  // colonnes d'arrivée
  for (const color of geo.players) {
    for (const [x, y] of geo.home_columns[color]) {
      addTile(boardGroup, x, y, geo.colors[color]);
    }
  }

  // bases 6x6 + emplacements
  for (const color of geo.players) {
    const [bx, by] = geo.base_areas[color];
    const p = cellToWorld(bx + 2.5, by + 2.5);
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(5.8, TILE_H * 0.6, 5.8),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(geo.colors[color]),
        roughness: 0.5,
        metalness: 0.05,
        emissive: new THREE.Color(geo.colors[color]),
        emissiveIntensity: 0
      })
    );
    plate.position.set(p.x, TILE_H * 0.3, p.z);
    plate.receiveShadow = true;
    boardGroup.add(plate);
    basePlates.set(color, plate);

    const inner = cellToWorld(bx + 2.5, by + 2.5);
    const well = new THREE.Mesh(
      new THREE.BoxGeometry(4.1, TILE_H * 0.62, 4.1),
      material("#ffffff", { roughness: 0.7, transparent: true, opacity: 0.14 })
    );
    well.position.set(inner.x, TILE_H * 0.31, inner.z);
    boardGroup.add(well);

    for (const [sx, sy] of geo.bases[color]) {
      const c = cellToWorld(sx, sy);
      const slot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.38, 0.38, 0.04, 20),
        material("#000000", { transparent: true, opacity: 0.18 })
      );
      slot.position.set(c.x, TILE_H * 0.6 + 0.02, c.z);
      boardGroup.add(slot);
    }
  }

  // centre : un triangle par couleur
  for (const color of geo.players) {
    const pts = centerTriangle(geo, color);
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        pts.flatMap((p) => [p.x, TILE_H + 0.004, p.z]),
        3
      )
    );
    g.setIndex([0, 1, 2]);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material(geo.colors[color]));
    boardGroup.add(mesh);
  }
}

function buildDice(color = "#f7fafc") {
  diceGroup = new THREE.Group();
  dicePivot = new THREE.Group();
  diceGroup.add(dicePivot);

  const size = 0.78;
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    material(color, { roughness: 0.35, metalness: 0.02 })
  );
  cube.castShadow = true;
  dicePivot.add(cube);

  // points : de petites sphères posées sur chaque face
  const pipMat = material("#1b2330", { roughness: 0.4 });
  const off = size / 2 + 0.005;
  const layout = [
    [1, [[0, 0]], [0, off, 0], [0, 1, 0]],
    [2, [[-0.2, 0.2], [0.2, -0.2]], [0, 0, off], [0, 0, 1]],
    [3, [[-0.22, 0.22], [0, 0], [0.22, -0.22]], [off, 0, 0], [1, 0, 0]],
    [4, [[-0.22, 0.22], [0.22, 0.22], [-0.22, -0.22], [0.22, -0.22]], [-off, 0, 0], [-1, 0, 0]],
    [5, [[-0.22, 0.22], [0.22, 0.22], [0, 0], [-0.22, -0.22], [0.22, -0.22]], [0, 0, -off], [0, 0, -1]],
    [
      6,
      [[-0.22, 0.24], [0.22, 0.24], [-0.22, 0], [0.22, 0], [-0.22, -0.24], [0.22, -0.24]],
      [0, -off, 0],
      [0, -1, 0]
    ]
  ];

  for (const [, pips, normal, face] of layout) {
    for (const [u, v] of pips) {
      const pip = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), pipMat);
      // on place le point dans le plan de sa face
      if (face[0] !== 0) pip.position.set(normal[0], v, -u);
      else if (face[1] !== 0) pip.position.set(u, normal[1], v);
      else pip.position.set(u, v, normal[2]);
      dicePivot.add(pip);
    }
  }

  diceGroup.position.set(0, 1.5, 6.4);
  root.add(diceGroup);
}

function buildTokens() {
  if (tokensGroup) root.remove(tokensGroup);
  tokensGroup = new THREE.Group();
  root.add(tokensGroup);
  tokenNodes.clear();

  for (const color of geo.players) {
    for (let index = 0; index < 4; index++) {
      const group = new THREE.Group();

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(TOKEN_R, TOKEN_R * 1.12, 0.2, 22),
        material(geo.colors[color], { roughness: 0.4 })
      );
      body.position.y = 0.1;
      body.castShadow = true;

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(TOKEN_R * 0.74, 22, 16),
        material(geo.colors[color], { roughness: 0.35 })
      );
      head.position.y = 0.32;
      head.castShadow = true;

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(TOKEN_R * 1.25, 0.045, 8, 26),
        material("#ffffff", { emissive: "#ffffff", emissiveIntensity: 0.6 })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.visible = false;

      group.add(body, head, ring);
      group.userData = { color, index, ring, position: null, path: [], hop: 0 };
      tokensGroup.add(group);
      tokenNodes.set(color + ":" + index, group);
    }
  }
}

/* ------------------------------------------------------------- animation */

function moveNode(node, target, { jump = false, direct = false } = {}) {
  const path = [];
  if (!direct) {
    const steps = pathBetween(node.userData.position, node.userData.pathTo);
    for (const step of steps) {
      const p = tokenWorldPosition(geo, node.userData.color, node.userData.index, step);
      if (p) path.push(p);
    }
  }

  if (!path.length || direct) {
    const p = tokenWorldPosition(geo, node.userData.color, node.userData.index, target);
    if (p) path.push(p);
  }

  animations.push({
    node,
    path,
    step: 0,
    t: 0,
    duration: (jump ? JUMP_MS : STEP_MS) / 1000
  });
}

function stepAnimations(dt) {
  for (let i = animations.length - 1; i >= 0; i--) {
    const anim = animations[i];
    const node = anim.node;
    const from = { x: node.position.x, z: node.position.z };
    const to = anim.path[anim.step];

    anim.t += dt;
    const k = Math.min(1, anim.t / anim.duration);
    const ease = k * k * (3 - 2 * k); // lissage

    node.position.x = from.x + (to.x - from.x) * ease;
    node.position.z = from.z + (to.z - from.z) * ease;
    node.position.y = TOP + Math.sin(k * Math.PI) * HOP;

    if (k >= 1) {
      anim.step++;
      anim.t = 0;
      if (anim.step >= anim.path.length) {
        node.position.set(to.x, to.y ?? TOP, to.z);
        animations.splice(i, 1);
      }
    }
  }
}

/* ------------------------------------------------------------------ rendu */

export function setGeometry(next) {
  geo = next;
  if (!root) return;
  buildBoard();
  buildTokens();
}

/**
 * Applique un état de partie.
 *
 * `myColor` vient de `app.js` (le serveur ne connaît pas le siège du client) :
 * il sert à n'illuminer que les pions réellement jouables par ce joueur.
 */
export function update(state, myColor) {
  if (!root || !geo || !state) return;

  // pions : on anime vers la nouvelle position
  const occupied = new Map();

  for (const player of state.players) {
    player.tokens.forEach((position, index) => {
      const node = tokenNodes.get(player.color + ":" + index);
      if (!node) return;

      const target = tokenWorldPosition(geo, player.color, index, position);
      if (!target) return;

      const key =
        position === "base"
          ? player.color + ":base:" + index
          : target.x.toFixed(2) + ":" + target.z.toFixed(2);
      if (!occupied.has(key)) occupied.set(key, []);
      occupied.get(key).push(node);

      if (node.userData.position !== position) {
        const previous = node.userData.position;
        node.userData.pathTo = position;
        const caught = position === "base" && typeof previous === "number";
        const leaving = previous === "base";
        const direct = previous === null || caught || leaving;
        moveNode(node, position, { jump: direct, direct });
        node.userData.position = position;
      }
    });
  }

  // plusieurs pions sur la même case : on les écarte un peu
  for (const nodes of occupied.values()) {
    if (nodes.length < 2) continue;
    nodes.forEach((node, i) => {
      const a = (Math.PI * 2 * i) / nodes.length + Math.PI / 4;
      node.userData.spread = { x: Math.cos(a) * 0.17, z: Math.sin(a) * 0.17 };
    });
  }

  // pions jouables : anneau lumineux sous les pions que CE joueur peut bouger
  const canPlay = state.status === "playing" && state.turn_color === myColor;
  const playable = new Set(canPlay ? state.legal_moves : []);
  const mine = (myColor || "") + ":";

  for (const [key, node] of tokenNodes) {
    const index = Number(key.split(":")[1]);
    node.userData.ring.visible = key.startsWith(mine) && playable.has(index);
  }

  // zone du joueur dont c'est le tour
  activeBase.color = state.status === "playing" ? state.turn_color : null;

  // dé
  if (state.dice !== null && !dice.rolling) {
    dice.value = state.dice;
    const [rx, ry, rz] = DICE_ORIENTATIONS[state.dice] || [0, 0, 0];
    dice.target.setFromEuler(new THREE.Euler(rx, ry, rz));
  }
}

function render(dt) {
  if (!renderer) return;

  stepAnimations(dt);

  // dé : rotation cible + tremblement pendant le lancer
  if (dicePivot) {
    if (dice.rolling) {
      dicePivot.rotation.x += dt * 9;
      dicePivot.rotation.y += dt * 7;
      dicePivot.rotation.z += dt * 5;
    } else {
      dicePivot.quaternion.slerp(dice.target, Math.min(1, dt * 9));
    }
    diceGroup.position.y = 1.5 + Math.sin(performance.now() / 700) * 0.06;
  }

  // pulsation de la base du joueur dont c'est le tour
  activeBase.t += dt;
  for (const [color, plate] of basePlates) {
    const on = color === activeBase.color;
    const pulse = on ? 0.3 + 0.24 * Math.sin(activeBase.t * 4) : 0;
    plate.material.emissiveIntensity +=
      (pulse - plate.material.emissiveIntensity) * Math.min(1, dt * 8);
  }

  // anneaux des pions jouables
  for (const node of tokenNodes.values()) {
    if (node.userData.ring.visible) {
      const s = 1 + 0.12 * Math.sin(performance.now() / 220);
      node.userData.ring.scale.setScalar(s);
    }
    const spread = node.userData.spread;
    if (spread) {
      node.position.x += spread.x;
      node.position.z += spread.z;
      node.userData.spread = null;
    }
  }

  // caméra orbitale
  const r = orbit.radius;
  camera.position.set(
    r * Math.sin(orbit.azimuth) * Math.cos(orbit.elevation),
    r * Math.sin(orbit.elevation),
    r * Math.cos(orbit.azimuth) * Math.cos(orbit.elevation)
  );
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  render(dt);
}

/* ------------------------------------------------------------------ entrée */

function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const diceHits = raycaster.intersectObject(diceGroup, true);
  if (diceHits.length && handlers.roll) {
    handlers.roll();
    return true;
  }

  const hits = raycaster.intersectObjects([...tokenNodes.values()], true);
  if (hits.length) {
    let node = hits[0].object;
    while (node && !node.userData.color) node = node.parent;
    if (node && node.userData.ring.visible && handlers.token) {
      handlers.token(node.userData.index);
      return true;
    }
  }

  return false;
}

function bindInput(canvas) {
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointerup", (event) => {
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    orbit.azimuth -= (event.clientX - lastPointer.x) * 0.006;
    orbit.elevation = Math.max(
      0.25,
      Math.min(1.45, orbit.elevation + (event.clientY - lastPointer.y) * 0.005)
    );
    lastPointer = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener("click", (event) => {
    pick(event);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      orbit.radius = Math.max(11, Math.min(26, orbit.radius + event.deltaY * 0.01));
    },
    { passive: false }
  );
}

/* -------------------------------------------------------------------- API */

export function init(canvas) {
  if (renderer) return true;

  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (error) {
    return false;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#0f141c");

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  root = new THREE.Group();
  scene.add(root);

  scene.add(new THREE.HemisphereLight("#dbe7f5", "#0b0f14", 1.15));

  const sun = new THREE.DirectionalLight("#ffffff", 1.5);
  sun.position.set(6, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -11;
  sun.shadow.camera.right = 11;
  sun.shadow.camera.top = 11;
  sun.shadow.camera.bottom = -11;
  scene.add(sun);

  const fill = new THREE.DirectionalLight("#8fb4ff", 0.35);
  fill.position.set(-8, 6, -6);
  scene.add(fill);

  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  const resize = () => {
    const size = canvas.clientWidth || 600;
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  bindInput(canvas);
  loop();
  return true;
}

export function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

export function setRolling(value) {
  dice.rolling = value;
}

/* Exposé pour app.js, qui est un script classique. */
window.Ludo3D = {
  init,
  setGeometry,
  update,
  setHandlers,
  setRolling,
  isReady: () => Boolean(renderer)
};

if (typeof window !== "undefined" && window.dispatchEvent) {
  window.dispatchEvent(new Event("ludo3dready"));
}
