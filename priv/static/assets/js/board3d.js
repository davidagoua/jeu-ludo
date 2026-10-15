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
// Vue 2D : caméra orthographique pile au-dessus du plateau. Il n'y a donc ni
// perspective ni plongée à régler — le cadre se déduit du plateau et de la
// rangée du dé, ce qui garantit qu'il n'est jamais rogné.
const ZOOM_MIN = 1; // 1 = le plateau remplit le cadre
const ZOOM_MAX = 2.2; // marge d'éloignement offerte à la molette
const FRAME_MARGIN = 0.7; // marge autour du plateau

const STEP_MS = 130; // durée d'un déplacement d'une case
const JUMP_MS = 420; // durée d'un saut (sortie de base, capture)
const HOP = 0.34; // hauteur d'un petit bond
// Le dé est posé sous le plateau. En vue de dessus il paraîtrait minuscule à sa
// taille d'origine : il est dimensionné par rapport au plateau.
const DICE_SIZE = 1.5;
const DICE_X = 0;
const DICE_Y = DICE_SIZE / 2 + 0.03;
const DICE_Z = BOARD / 2 + 0.4 + DICE_SIZE / 2;

// Étendue à couvrir : le plateau, puis la rangée du dé sous le plateau.
const VIEW_TOP = -(BOARD / 2 + FRAME_MARGIN);
const VIEW_BOTTOM = DICE_Z + DICE_SIZE / 2 + 0.45;
const VIEW_HALF = Math.max(VIEW_BOTTOM - VIEW_TOP, BOARD + 2 * FRAME_MARGIN) / 2;
const VIEW_CENTER_Z = (VIEW_TOP + VIEW_BOTTOM) / 2;

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
let lastFrame = 0;
let raycaster = null;
let pointer = new THREE.Vector2();
// Vue 2D : ni rotation ni plongée, seulement un facteur de zoom.
let view = { zoom: 1 };

/** Points qui doivent rester dans le cadre (sert aux vérifications). */
export function framePoints() {
  return [
    [-BOARD / 2, 0, -BOARD / 2],
    [BOARD / 2, 0, -BOARD / 2],
    [-BOARD / 2, 0, BOARD / 2],
    [BOARD / 2, 0, BOARD / 2],
    [DICE_X, 0, VIEW_BOTTOM] // bas de la rangée du dé
  ];
}

/**
 * Place la caméra : orthographique, pile au-dessus, orientée pour que la ligne 0
 * du plateau (z négatif) s'affiche en haut, comme sur le plateau 2D.
 */
function updateCamera() {
  const half = VIEW_HALF * view.zoom;

  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;

  camera.position.set(0, 60, VIEW_CENTER_Z);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, VIEW_CENTER_Z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

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
  // étiquetés pour que les vérifications hors navigateur inspectent la scène
  mesh.userData = { kind: "cell", cell: [x, y], color };
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
      star.userData = { kind: "star", cell: [x, y], color: owner || null };
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
    plate.userData = { kind: "base", color, area: [bx, by] };
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
      slot.userData = { kind: "slot", color, cell: [sx, sy] };
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
    mesh.userData = { kind: "center", color };
    boardGroup.add(mesh);
  }
}

function buildDice(color = "#f7fafc") {
  diceGroup = new THREE.Group();
  dicePivot = new THREE.Group();
  diceGroup.add(dicePivot);

  const size = DICE_SIZE;
  const k = size / 0.78; // les décalages ci-dessous sont donnés pour un dé de 0,78
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    material(color, { roughness: 0.35, metalness: 0.02 })
  );
  cube.castShadow = true;
  cube.userData = { kind: "dice" };
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
      const pip = new THREE.Mesh(new THREE.SphereGeometry(0.062 * k, 12, 10), pipMat);
      // on place le point dans le plan de sa face
      const pu = u * k;
      const pv = v * k;
      if (face[0] !== 0) pip.position.set(normal[0], pv, -pu);
      else if (face[1] !== 0) pip.position.set(pu, normal[1], pv);
      else pip.position.set(pu, pv, normal[2]);
      pip.userData = { kind: "pip" };
      dicePivot.add(pip);
    }
  }

  // devant le plateau : à 6,4 il reposait sur la colonne verte
  diceGroup.position.set(DICE_X, DICE_Y, DICE_Z);
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
      group.userData = { kind: "token", color, index, ring, position: null, path: [], hop: 0 };
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

    // Vue de dessus oblige : monter un pion ne se voit pas. Le bond se lit donc
    // par un grossissement passager, et par l'ombre portée qui s'écarte.
    const bond = Math.sin(k * Math.PI);
    node.position.y = TOP + bond * HOP;
    node.scale.setScalar(1 + bond * 0.3);

    if (k >= 1) {
      anim.step++;
      anim.t = 0;
      if (anim.step >= anim.path.length) {
        node.position.set(to.x, to.y ?? TOP, to.z);
        node.scale.setScalar(1);
        animations.splice(i, 1);
      }
    }
  }
}

/**
 * Termine immédiatement les animations en cours.
 *
 * Sert aux vérifications hors navigateur (il n'y a pas de boucle de rendu) et
 * pourra servir de base à un réglage « mouvement réduit ».
 */
export function settle() {
  for (let guard = 0; guard < 500 && animations.length > 0; guard++) {
    stepAnimations(1);
  }
}

/* ------------------------------------------------------------------ rendu */

export function setGeometry(next) {
  buildScene(next);
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

  // Dé : la face affichée ne change QUE sur un nouveau lancer. Le serveur remet
  // `dice` à zéro dès que le pion a bougé, mais les autres joueurs doivent
  // pouvoir lire le numéro joué : on conserve donc la dernière valeur.
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
    diceGroup.position.y = DICE_Y + Math.sin(performance.now() / 700) * 0.05;
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

  updateCamera();
  renderer.render(scene, camera);
}

function loop() {
  requestAnimationFrame(loop);
  // THREE.Clock est déprécié depuis r186 : on horodate nous-mêmes la frame
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
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
  // Vue de dessus : le plateau ne tourne pas. Un clic vise un pion ou le dé.
  canvas.addEventListener("click", (event) => {
    pick(event);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      // 1 = cadrage au plus près : on ne peut que s'éloigner, jamais rogner
      view.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom + event.deltaY * 0.0015));
      updateCamera();
    },
    { passive: false }
  );
}

/* -------------------------------------------------------------------- API */

/**
 * Construit la scène et son contenu, **sans moteur de rendu**.
 *
 * Séparer la construction du rendu permet de vérifier le graphe de scène dans
 * Node (`scripts/three_check.mjs`) : Three.js construit volontiers des scènes
 * sans contexte WebGL, seul `WebGLRenderer` en a besoin. C'est la seule façon
 * de contrôler ici que le plateau est réellement bâti correctement.
 */
export function buildScene(nextGeo) {
  if (nextGeo) geo = nextGeo;

  if (!scene) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#0f141c");

    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
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
  }

  if (geo) {
    buildBoard();
    buildTokens();
    if (!diceGroup) buildDice();
  }

  return { scene, root, boardGroup, tokensGroup, diceGroup };
}

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

  buildScene();

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

/** Positions monde des pions, pour les vérifications hors navigateur. */
export function tokenPositions() {
  const out = {};
  for (const [key, node] of tokenNodes) {
    out[key] = { x: node.position.x, y: node.position.y, z: node.position.z };
  }
  return out;
}

/**
 * Projette un point du monde dans le repère de la caméra (-1 à 1).
 * Sert à vérifier que le plateau est entièrement cadré.
 */
export function project(point) {
  updateCamera();
  const v = new THREE.Vector3(point.x, point.y || 0, point.z).project(camera);
  return { x: v.x, y: v.y };
}

/** Face actuellement affichée par le dé (`null` avant le premier lancer). */
export function diceValue() {
  return dice.value;
}

/** Déplace la caméra (sert aux vérifications et à un futur bouton de recadrage). */
export function setView(next) {
  Object.assign(view, next);
  updateCamera();
}

/** Rayon de caméra minimal qui ne rogne pas le plateau. */
/** Demi-hauteur du cadre visible, zoom compris. */
export function viewHalf() {
  return VIEW_HALF * view.zoom;
}

/** z sur lequel le cadre est centré (le plateau n'est pas centré : le dé est en dessous). */
export function viewCenterZ() {
  return VIEW_CENTER_Z;
}

/** Bornes offertes au joueur (pour les vérifications). */
export function viewLimits() {
  return { minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX, half: VIEW_HALF };
}

/** Anneaux de surbrillance actuellement visibles, pour les vérifications. */
export function highlightedTokens() {
  const out = [];
  for (const [key, node] of tokenNodes) {
    if (node.userData.ring && node.userData.ring.visible) out.push(key);
  }
  return out.sort();
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
