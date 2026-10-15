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
const SPREAD = 0.17; // écartement de plusieurs pions sur une même case

// Rayon de la zone de touche d'un pion. Un doigt couvre environ 9 mm : à
// l'échelle du plateau (15 cases pour un téléphone d'environ 360 px), il faut
// viser large pour que le pion soit attrapable.
const HIT_R = 0.85;

// Tolérance de visée, en coordonnées écran (-1 à 1). Un doigt couvre environ
// 9 mm : sur un téléphone de 360 px de large, il faut 40 px de cible, soit une
// tolérance de 0,11. On prend un peu plus.
const SNAP_NDC = 0.12;

// Déplacement en pixels au-delà duquel un appui n'est plus considéré comme un
// tap (le doigt tremble toujours un peu).
const TAP_TOLERANCE = 14;
// Le dé est posé sous le plateau. En vue de dessus il paraîtrait minuscule à sa
// taille d'origine : il est dimensionné par rapport au plateau.
// Un dé par joueur, posé en diagonale à l'extérieur de son camp. Le dé d'un
// joueur qui n'a pas la main — ou qui a fini de jouer — reste blanc, sans point.
const DICE_SIZE = 1.9;
const DICE_Y = DICE_SIZE / 2 + 0.03;
const DICE_OFFSET = BOARD / 2 + 0.35 + DICE_SIZE / 2;

// Étendue à couvrir : le plateau et les quatre dés.
const VIEW_TOP = -(DICE_OFFSET + DICE_SIZE / 2 + 0.45);
const VIEW_BOTTOM = -VIEW_TOP;
const VIEW_HALF = (VIEW_BOTTOM - VIEW_TOP) / 2;
const VIEW_CENTER_Z = 0;

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

  const a = { x: corners[0][0], z: corners[0][1] };
  const b = { x: corners[1][0], z: corners[1][1] };
  const centre = { x: 0, z: 0 };

  // Sens de rotation garanti : la face doit regarder vers le haut. Dans le cas
  // contraire le back-face culling élimine le triangle, qui disparaît
  // purement et simplement du plateau.
  const cross = (b.x - a.x) * (centre.z - a.z) - (b.z - a.z) * (centre.x - a.x);

  return cross > 0 ? [a, centre, b] : [a, b, centre];
}

/* ------------------------------------------------------------------ scène */

let renderer = null;
let scene = null;
let camera = null;
let root = null;
let boardGroup = null;
let tokensGroup = null;
const diceByColor = new Map(); // couleur -> { group, pivot, pips, target, value, rolling }
let highlightGroup = null;

let geo = null;
const tokenNodes = new Map(); // "color:index" -> group
const basePlates = new Map(); // color -> mesh
let animations = [];
// pas de dé unique : chaque joueur a le sien (voir `diceByColor`)
let activeDice = { color: null };
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
    // les quatre dés, posés aux quatre coins
    [-DICE_OFFSET, 0, -DICE_OFFSET],
    [DICE_OFFSET, 0, -DICE_OFFSET],
    [-DICE_OFFSET, 0, DICE_OFFSET],
    [DICE_OFFSET, 0, DICE_OFFSET]
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
        material(owner ? "#ffffff" : "#8494a8", { side: THREE.DoubleSide })
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
    const mesh = new THREE.Mesh(g, material(geo.colors[color], { side: THREE.DoubleSide }));
    mesh.userData = { kind: "center", color };
    boardGroup.add(mesh);
  }
}

/**
 * Construit le dé d'un joueur et le pose à l'extérieur de son camp, en
 * diagonale. Les points sont conservés pour pouvoir les masquer : c'est ainsi
 * qu'un dé « en blanc » est représenté.
 */
function buildDiceFor(color) {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);

  const size = DICE_SIZE;
  const k = size / 0.78; // les décalages ci-dessous sont donnés pour un dé de 0,78
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    material("#f7fafc", { roughness: 0.35, metalness: 0.02 })
  );
  cube.castShadow = true;
  cube.userData = { kind: "dice", color };
  pivot.add(cube);

  // points : de petites sphères posées sur chaque face
  const pipMat = material("#1b2330", { roughness: 0.4 });
  const off = size / 2 + 0.005;
  const layout = [
    [1, [[0, 0]], [0, off, 0], [0, 1, 0]],
    [2, [[-0.2, 0.2], [0.2, -0.2]], [0, 0, off], [0, 0, 1]],
    [3, [[-0.22, 0.22], [0, 0], [0.22, -0.22]], [off, 0, 0], [1, 0, 0]],
    [4, [[-0.22, 0.22], [0.22, 0.22], [-0.22, -0.22], [0.22, -0.22]], [-off, 0, 0], [-1, 0, 0]],
    [
      5,
      [[-0.22, 0.22], [0.22, 0.22], [0, 0], [-0.22, -0.22], [0.22, -0.22]],
      [0, 0, -off],
      [0, 0, -1]
    ],
    [
      6,
      [[-0.22, 0.24], [0.22, 0.24], [-0.22, 0], [0.22, 0], [-0.22, -0.24], [0.22, -0.24]],
      [0, -off, 0],
      [0, -1, 0]
    ]
  ];

  const pips = [];

  for (const [value, spots, normal, face] of layout) {
    for (const [u, v] of spots) {
      const pip = new THREE.Mesh(new THREE.SphereGeometry(0.078 * k, 12, 10), pipMat);
      const pu = u * k;
      const pv = v * k;

      if (face[0] !== 0) pip.position.set(normal[0], pv, -pu);
      else if (face[1] !== 0) pip.position.set(pu, normal[1], pv);
      else pip.position.set(pu, pv, normal[2]);

      // la face est étiquetée : le test vérifie ainsi que le dessus du dé
      // montre bien le nombre de points attendu
      pip.userData = { kind: "pip", color, face: value };
      pip.visible = false; // blanc tant que le joueur n'a rien lancé
      pips.push(pip);
      pivot.add(pip);
    }
  }

  // halo coloré : le dé du joueur en cours se repère d'un coup d'œil
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(size * 0.62, size * 0.8, 40),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(geo.colors[color]),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  halo.visible = false;
  halo.userData = { kind: "dice-halo", color };
  group.add(halo);

  // chaque camp est dans un coin : le dé se pose en diagonale, à l'extérieur
  const [bx, by] = geo.base_areas[color];
  const signX = bx > 0 ? 1 : -1;
  const signZ = by > 0 ? 1 : -1;
  group.position.set(signX * DICE_OFFSET, DICE_Y, signZ * DICE_OFFSET);

  root.add(group);

  return {
    color,
    group,
    pivot,
    pips,
    halo,
    target: new THREE.Quaternion(),
    value: null,
    rolling: false
  };
}

function buildDice() {
  for (const color of geo.players) {
    diceByColor.set(color, buildDiceFor(color));
  }
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

      // Zone de touche élargie : sur un téléphone un pion ne fait qu'une
      // douzaine de pixels, bien en dessous de ce qu'un doigt peut viser. Ce
      // disque invisible sert uniquement au raycast.
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(HIT_R, HIT_R, 0.9, 16),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
      );
      hit.position.y = 0.45;
      hit.userData = { kind: "hit" };

      group.add(body, head, ring, hit);
      group.userData = {
        kind: "token",
        color,
        index,
        ring,
        hit,
        position: null,
        path: [],
        hop: 0
      };
      tokensGroup.add(group);
      tokenNodes.set(color + ":" + index, group);
    }
  }
}

/* ------------------------------------------------------------- animation */

/**
 * Anime un pion jusqu'à `destination` (écartement compris).
 *
 * `position` est la position logique visée, qui sert à déduire les cases
 * intermédiaires quand le pion avance sur l'anneau ou dans sa colonne.
 */
function moveNode(node, position, destination, { jump = false, direct = false } = {}) {
  const path = [];

  if (!direct) {
    for (const step of pathBetween(node.userData.position, position)) {
      const p = tokenWorldPosition(geo, node.userData.color, node.userData.index, step);
      if (p) path.push(p);
    }
  }

  // la destination exacte est toujours la dernière étape : c'est elle qui fixe
  // la position finale, sans dérive possible
  path.push(destination);

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

  // 1. Où chaque pion doit aller, et lesquels se retrouvent sur la même case.
  const placed = new Map(); // pion -> { target, position }
  const occupied = new Map(); // case -> [pions]

  for (const player of state.players) {
    player.tokens.forEach((position, index) => {
      const node = tokenNodes.get(player.color + ":" + index);
      if (!node) return;

      const target = tokenWorldPosition(geo, player.color, index, position);
      if (!target) return;

      placed.set(node, { target, position });

      const key =
        position === "base"
          ? "base:" + player.color + ":" + index
          : target.x.toFixed(2) + ":" + target.z.toFixed(2);
      if (!occupied.has(key)) occupied.set(key, []);
      occupied.get(key).push(node);
    });
  }

  // 2. Plusieurs pions sur une même case : on les écarte. C'est un décalage
  //    ajouté à la DESTINATION et recalculé à chaque mise à jour — ajouté à la
  //    position courante, il s'accumulait et finissait par sortir du plateau.
  const spreadOf = new Map();
  for (const nodes of occupied.values()) {
    if (nodes.length < 2) continue;

    nodes.forEach((node, i) => {
      const angle = (Math.PI * 2 * i) / nodes.length + Math.PI / 4;
      spreadOf.set(node, { x: Math.cos(angle) * SPREAD, z: Math.sin(angle) * SPREAD });
    });
  }

  // 3. On anime un vrai déplacement, sinon on se contente de rejoindre la place.
  for (const [node, entry] of placed) {
    const spread = spreadOf.get(node) || { x: 0, z: 0 };
    const destination = {
      x: entry.target.x + spread.x,
      y: entry.target.y,
      z: entry.target.z + spread.z
    };

    const moved = node.userData.position !== entry.position;
    const running = animations.some((a) => a.node === node);
    const offTarget =
      Math.abs(node.position.x - destination.x) > 1e-4 ||
      Math.abs(node.position.z - destination.z) > 1e-4;

    if (moved) {
      const previous = node.userData.position;
      const direct =
        previous === null ||
        (entry.position === "base" && typeof previous === "number") ||
        previous === "base";

      moveNode(node, entry.position, destination, { jump: direct, direct });
      node.userData.position = entry.position;
    } else if (!running && offTarget) {
      // même case, mais l'écartement a changé : on rejoint la nouvelle place
      moveNode(node, entry.position, destination, { jump: true, direct: true });
    }
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

  // Dés : celui du joueur en cours montre sa valeur tant qu'il n'a pas joué son
  // pion ; dès qu'il a fini — et pour tous les autres joueurs — il reste blanc.
  for (const color of geo.players) {
    const node = diceByColor.get(color);
    if (!node) continue;

    const value = state.turn_color === color && state.dice !== null ? state.dice : null;

    if (value !== null) {
      if (node.value !== value) {
        node.value = value;
        const [rx, ry, rz] = DICE_ORIENTATIONS[value] || [0, 0, 0];
        node.target.setFromEuler(new THREE.Euler(rx, ry, rz));
      }
    } else {
      node.value = null;
    }

    // « en blanc » : le cube reste, mais sans aucun point
    for (const pip of node.pips) pip.visible = value !== null;
  }

  activeDice.color = state.status === "playing" ? state.turn_color : null;

  // halo uniquement sous le dé du joueur en cours
  for (const [color, node] of diceByColor) {
    node.halo.visible = color === activeDice.color;
  }
}

/**
 * Fait avancer la simulation d'une frame : animations, écartement des pions,
 * dé, pulsations. Séparé du dessin pour rester vérifiable sans WebGL.
 */
function updateSimulation(dt) {
  stepAnimations(dt);

  // dés : rotation vers la face tirée, et tremblement pendant un lancer
  for (const node of diceByColor.values()) {
    if (node.rolling) {
      node.pivot.rotation.x += dt * 9;
      node.pivot.rotation.y += dt * 7;
      node.pivot.rotation.z += dt * 5;
    } else {
      node.pivot.quaternion.slerp(node.target, Math.min(1, dt * 9));
    }

    // le dé du joueur en cours respire, et son halo pulse
    const actif = node.color === activeDice.color;
    const temps = performance.now();

    node.group.position.y = DICE_Y + (actif ? Math.sin(temps / 700) * 0.06 + 0.05 : 0);

    if (node.halo.visible) {
      const battement = 1 + 0.08 * Math.sin(temps / 320);
      node.halo.scale.setScalar(battement);
    }
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
  }
}

function render(dt) {
  updateSimulation(dt);
  if (!renderer) return;

  updateCamera();
  renderer.render(scene, camera);
}

/** Avance la simulation de `frames` frames (vérifications hors navigateur). */
export function stepFrames(frames = 1, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) updateSimulation(dt);
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

/**
 * Traite un clic aux coordonnées normalisées de l'écran (-1 à 1).
 *
 * Chaque joueur a son dé : seul celui du joueur en cours déclenche un lancer.
 * Renvoie ce qui a été touché, ce qui rend le comportement vérifiable.
 */
/**
 * Pion jouable le plus proche d'un point de l'écran, dans la limite de la
 * tolérance de visée.
 *
 * Au doigt, exiger que le rayon touche exactement le pion est trop sévère : on
 * accepte donc un pion jouable proche du point touché. Seuls les pions
 * réellement jouables sont candidats, ce qui évite tout coup involontaire.
 */
function nearestPlayableToken(ndcX, ndcY) {
  let meilleur = null;
  let distance = SNAP_NDC;
  const point = new THREE.Vector3();

  for (const node of tokenNodes.values()) {
    if (!node.userData.ring.visible) continue;

    node.getWorldPosition(point).project(camera);
    const d = Math.hypot(point.x - ndcX, point.y - ndcY);

    if (d < distance) {
      distance = d;
      meilleur = node;
    }
  }

  return meilleur;
}

function activate(ndcX, ndcY) {
  // Les matrices monde sont normalement à jour grâce au rendu de la frame
  // précédente : on s'en assure, sans quoi un clic arrivé avant le premier
  // rendu toucherait des objets restés à l'origine.
  root.updateMatrixWorld(true);

  pointer.set(ndcX, ndcY);
  raycaster.setFromCamera(pointer, camera);

  const color = diceAt(ndcX, ndcY);
  if (color) {
    if (color === activeDice.color && handlers.roll) handlers.roll();
    return "dice:" + color;
  }

  const hits = raycaster.intersectObjects([...tokenNodes.values()], true);

  // Tous les pions touchés, sans doublon : les zones de touche se chevauchent
  // quand deux pions partagent une case.
  const touches = [];

  for (const hit of hits) {
    let node = hit.object;
    while (node && !node.userData.color) node = node.parent;
    if (node && !touches.includes(node)) touches.push(node);
  }

  // Un pion jouable passe avant tout autre : sans cela, la zone élargie d'un
  // pion immobile intercepterait le geste destiné à son voisin.
  let node = touches.find((n) => n.userData.ring.visible) || null;

  // à défaut, le pion jouable le plus proche du point touché
  if (!node) node = nearestPlayableToken(ndcX, ndcY);

  if (node && node.userData.ring.visible && handlers.token) {
    handlers.token(node.userData.index);
    return "token:" + node.userData.color + ":" + node.userData.index;
  }

  return null;
}

function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return activate(x, y);
}

/** Dé touché par un clic aux coordonnées écran, ou `null`. */
export function diceAt(ndcX, ndcY) {
  root.updateMatrixWorld(true);
  pointer.set(ndcX, ndcY);
  raycaster.setFromCamera(pointer, camera);

  for (const [color, node] of diceByColor) {
    if (raycaster.intersectObject(node.group, true).length) return color;
  }

  return null;
}

/** Simule un clic (vérifications hors navigateur). */
export function clickAt(ndcX, ndcY) {
  return activate(ndcX, ndcY);
}

/** Rayon de la zone de touche d'un pion (vérifications). */
export function hitRadius() {
  return HIT_R;
}

/** Tolérance de visée au doigt, en coordonnées écran (vérifications). */
export function snapTolerance() {
  return SNAP_NDC;
}

/** Distance d'un dé au centre du plateau. */
export function diceOffset() {
  return DICE_OFFSET;
}

function bindInput(canvas) {
  // Vue de dessus : le plateau ne tourne pas. On repère un TAP plutôt qu'un
  // `click` : sur mobile, le clic arrive avec un retard et se perd si le doigt
  // bouge un peu. Un glissement n'est pas un tap.
  let depart = null;

  canvas.addEventListener("pointerdown", (event) => {
    depart = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener("pointerup", (event) => {
    const origine = depart;
    depart = null;

    canvas.releasePointerCapture?.(event.pointerId);
    if (!origine) return;

    const glissement = Math.hypot(event.clientX - origine.x, event.clientY - origine.y);
    if (glissement > TAP_TOLERANCE) return; // c'était un glissement

    pick(event);
  });

  canvas.addEventListener("pointercancel", () => {
    depart = null;
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
    if (diceByColor.size === 0) buildDice();
  }

  return { scene, root, boardGroup, tokensGroup, diceByColor };
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
  const node = diceByColor.get(activeDice.color);
  return node ? node.value : null;
}

/**
 * Points situés sur le dessus du dé, pour une couleur donnée.
 *
 * Sert à vérifier que le dé montre bien le nombre attendu quand on le regarde
 * d'au-dessus — c'est tout l'intérêt d'un dé vu de dessus.
 */
export function diceTopPips(color) {
  const node = diceByColor.get(color);
  if (!node) return [];

  root.updateMatrixWorld(true);
  const point = new THREE.Vector3();

  const places = node.pips
    .filter((pip) => pip.visible)
    .map((pip) => ({ pip, y: pip.getWorldPosition(point).y }));

  if (places.length === 0) return [];

  const sommet = Math.max(...places.map((entry) => entry.y));

  // seuls les points posés sur la face du dessus : ils sont tous à la même
  // hauteur, au sommet du cube
  return places
    .filter((entry) => entry.y > sommet - 0.05)
    .map((entry) => entry.pip.userData.face);
}

/** Vrai si le halo du dé de cette couleur est visible. */
export function diceHighlighted(color) {
  const node = diceByColor.get(color);
  return Boolean(node && node.halo.visible);
}

/** Valeur affichée par chaque dé, couleur par couleur (vérifications). */
export function diceValues() {
  const out = {};
  for (const [color, node] of diceByColor) out[color] = node.value;
  return out;
}

/** Points visibles de chaque dé (`false` = dé en blanc). */
export function dicePipsVisible() {
  const out = {};
  for (const [color, node] of diceByColor) {
    out[color] = node.pips.some((pip) => pip.visible);
  }
  return out;
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
  for (const node of diceByColor.values()) {
    node.rolling = Boolean(value) && node.color === activeDice.color;
  }
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
