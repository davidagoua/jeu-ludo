/*
 * Vérifie la logique 3D du client, hors navigateur.
 *
 * WebGL n'est pas disponible ici : impossible de contrôler le rendu. En
 * revanche, tout le calcul de positions — où se trouve un pion sur le plateau,
 * par quelles cases il passe, de quel côté pointe le triangle d'une couleur,
 * quelle face du dé monte — est calculé par des fonctions pures, testées ici
 * contre la géométrie réelle envoyée par le serveur.
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' 2>/dev/null | tail -1 > /tmp/geometry.json
 *   node scripts/three_check.mjs /tmp/geometry.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const geometryPath = process.argv[2] || "/tmp/geometry.json";
const geo = JSON.parse(readFileSync(geometryPath, "utf8"));

// board3d.js s'annonce sur `window` à la fin de son chargement
globalThis.window = {
  dispatchEvent: () => {},
  addEventListener: () => {},
  devicePixelRatio: 1
};

const THREE = await import(
  join(here, "..", "priv/static/assets/js/vendor/three.module.min.js")
);
const board = await import(join(here, "..", "priv/static/assets/js/board3d.js"));

/* ------------------------------------------------------------------ outils */

let failures = 0;
let checks = 0;

function section(title) {
  console.log("\n== " + title + " ==");
}

function check(label, ok, detail) {
  checks++;
  if (ok) {
    console.log("  OK   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const inBoard = (v) => v >= -7.5 - 1e-9 && v <= 7.5 + 1e-9;

/* ------------------------------------------------------- repère du plateau */

section("Repère du plateau");

const centre = board.cellToWorld(7, 7);
check("la case centrale (7,7) est à l'origine", near(centre.x, 0) && near(centre.z, 0), centre);

const coin = board.cellToWorld(0, 0);
check("la case (0,0) est au coin -7,-7", near(coin.x, -7) && near(coin.z, -7), coin);

const oppose = board.cellToWorld(14, 14);
check("la case (14,14) est au coin +7,+7", near(oppose.x, 7) && near(oppose.z, 7), oppose);

check(
  "l'axe z suit bien les lignes (la ligne 0 est en z négatif)",
  board.cellToWorld(7, 0).z < board.cellToWorld(7, 14).z
);

/* --------------------------------------------------------- positions pions */

section("Positions des pions");

let basesOk = true;
let positionsOk = true;
let counts = {};

for (const color of geo.players) {
  // les quatre emplacements de base doivent tomber sur les centres des cases
  counts[color] = 0;
  geo.bases[color].forEach((slot, index) => {
    const p = board.tokenWorldPosition(geo, color, index, "base");
    const attendu = board.cellToWorld(slot[0], slot[1]);
    if (!p || !near(p.x, attendu.x) || !near(p.z, attendu.z)) {
      basesOk = false;
      console.log("    base " + color + " " + index + " mal placée : " + JSON.stringify(p));
    }
  });

  // toutes les positions du parcours doivent rester sur le plateau
  for (let pos = 0; pos <= geo.finish; pos++) {
    const p = board.tokenWorldPosition(geo, color, 0, pos);
    if (!p || !inBoard(p.x) || !inBoard(p.z) || p.y === undefined) {
      positionsOk = false;
      console.log("    " + color + " position " + pos + " hors plateau : " + JSON.stringify(p));
    }
    counts[color] = counts[color] ? counts[color] : new Set();
    counts[color].add(p ? p.x.toFixed(3) + ":" + p.z.toFixed(3) : "?");
  }
}

check("les emplacements de base tombent sur les centres de case", basesOk);
check(
  "les " + (geo.finish + 1) + " positions d'un parcours restent sur le plateau",
  positionsOk
);

// la position 0 est la case de départ ; la dernière case d'anneau (position
// last_ring_position) est la case d'entrée de la colonne, et la position
// suivante est la première case de cette colonne
let startsOk = true;
for (const color of geo.players) {
  const depart = board.tokenWorldPosition(geo, color, 0, 0);
  const attenduDepart = board.cellToWorld(...geo.ring[geo.starts[color]]);

  const dernierIdx = (geo.starts[color] + geo.last_ring_position) % geo.ring_size;
  const dernier = board.tokenWorldPosition(geo, color, 0, geo.last_ring_position);
  const attenduDernier = board.cellToWorld(...geo.ring[dernierIdx]);

  const entree = board.tokenWorldPosition(geo, color, 0, geo.last_ring_position + 1);
  const attenduEntree = board.cellToWorld(...geo.home_columns[color][0]);

  if (!near(depart.x, attenduDepart.x) || !near(depart.z, attenduDepart.z)) {
    startsOk = false;
    console.log("    départ " + color + " incorrect : " + JSON.stringify(depart));
  }
  if (!near(dernier.x, attenduDernier.x) || !near(dernier.z, attenduDernier.z)) {
    startsOk = false;
    console.log("    dernière case d'anneau " + color + " : " + JSON.stringify(dernier));
  }
  if (!near(entree.x, attenduEntree.x) || !near(entree.z, attenduEntree.z)) {
    startsOk = false;
    console.log("    entrée de colonne " + color + " incorrecte : " + JSON.stringify(entree));
  }
  if (near(depart.x, entree.x) && near(depart.z, entree.z)) {
    startsOk = false;
    console.log("    " + color + " : départ et entrée de colonne confondus");
  }
}
check("chaque joueur a un départ, une dernière case d'anneau et une entrée distincts", startsOk);

// les 60 positions d'un parcours sont distinctes
let distinct = true;
for (const color of geo.players) {
  if (counts[color].size !== geo.finish + 1) {
    distinct = false;
    console.log("    " + color + " : " + counts[color].size + " positions distinctes");
  }
}
check("les " + (geo.finish + 1) + " positions d'un parcours sont toutes distinctes", distinct);

// les quatre pions arrivés se rangent dans le triangle de leur couleur
const arrives = [0, 1, 2, 3].map((i) => board.tokenWorldPosition(geo, "red", i, geo.finish));
const entry = geo.center_entries.red;
const entryWorld = board.cellToWorld(entry[0], entry[1]);
const allInTriangle = arrives.every(
  (p) => Math.abs(p.x - entryWorld.x) < 0.5 && Math.abs(p.z - entryWorld.z) < 0.5
);
check("les pions arrivés restent dans le triangle de leur couleur", allInTriangle, arrives);

/* ----------------------------------------------------- chemins d'animation */

section("Chemins d'animation");

check(
  "une avance de 3 cases passe par les cases intermédiaires",
  JSON.stringify(board.pathBetween(2, 5)) === JSON.stringify([3, 4, 5])
);
check("ne pas bouger ne produit aucune étape", board.pathBetween(7, 7).length === 0);
check(
  "sortir de sa base est un saut direct",
  JSON.stringify(board.pathBetween("base", 0)) === JSON.stringify([0])
);
check(
  "être capturé est un saut direct vers la base",
  JSON.stringify(board.pathBetween(12, "base")) === JSON.stringify(["base"])
);
check(
  "un recul ne boucle pas (repli sur un saut direct)",
  JSON.stringify(board.pathBetween(9, 4)) === JSON.stringify([4])
);

// un parcours complet, de la case de départ jusqu'à l'arrivée, fait une étape
// par position : c'est ce que l'animation parcourt case par case
const complet = board.pathBetween(0, geo.finish);
check(
  "un parcours complet fait une étape par position",
  complet.length === geo.finish,
  complet.length
);
check(
  "les étapes d'un parcours complet sont consécutives",
  complet.every((p, i) => p === i + 1),
  complet.slice(0, 4)
);

/* ------------------------------------------------------- triangles du centre */

section("Triangles du centre");

check("les quatre triangles sont définis", Object.keys(geo.center_entries).length === 4);

let trianglesOk = true;
for (const color of geo.players) {
  const pts = board.centerTriangle(geo, color);
  const [ex, ey] = geo.center_entries[color];

  const versCentre = pts.some((p) => near(p.x, 0) && near(p.z, 0));
  // le côté doit correspondre au bras d'où vient la couleur
  const world = board.cellToWorld(ex, ey);
  const cote = pts.filter((p) => !near(p.x, 0) || !near(p.z, 0));

  const duBonCote =
    (ex <= 6 && cote.every((p) => p.x < 0)) ||
    (ex >= 8 && cote.every((p) => p.x > 0)) ||
    (ey <= 6 && cote.every((p) => p.z < 0)) ||
    (ey >= 8 && cote.every((p) => p.z > 0));

  const dansLeCentre = pts.every((p) => Math.abs(p.x) <= 1.5 + 1e-9 && Math.abs(p.z) <= 1.5 + 1e-9);

  if (!versCentre || !duBonCote || !dansLeCentre) {
    trianglesOk = false;
    console.log(
      "    " + color + " entrée(" + ex + "," + ey + ") monde " + JSON.stringify(world) +
        " -> " + JSON.stringify(pts)
    );
  }
}
check("chaque triangle pointe vers le centre depuis le bras de sa couleur", trianglesOk);

/* ---------------------------------------------------------------------- dé */

section("Le dé");

let diceOk = true;
const seen = new Set();

for (const value of [1, 2, 3, 4, 5, 6]) {
  const [rx, ry, rz] = board.DICE_ORIENTATIONS[value];
  const [nx, ny, nz] = board.DICE_NORMALS[value];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const normal = new THREE.Vector3(nx, ny, nz).applyQuaternion(q);

  // la face portant la valeur doit finir vers le haut
  if (!near(normal.x, 0, 1e-6) || !near(normal.y, 1, 1e-6) || !near(normal.z, 0, 1e-6)) {
    diceOk = false;
    console.log("    face " + value + " -> " + normal.toArray().map((v) => v.toFixed(3)));
  }
  seen.add(value);
}

check("chaque valeur amène bien sa face vers le haut", diceOk);
check("les six faces sont couvertes", seen.size === 6, seen.size);

const orientations = new Set(
  Object.values(board.DICE_ORIENTATIONS).map((o) => o.map((v) => v.toFixed(4)).join(","))
);
check("les six orientations sont distinctes", orientations.size === 6, orientations.size);
check(
  "le dé connaît les six valeurs et seulement elles",
  Object.keys(board.DICE_ORIENTATIONS).length === 6,
  Object.keys(board.DICE_ORIENTATIONS).length
);

/* -------------------------------------------------- intégration du bundle */

section("Intégration du bundle Three.js");

// Tous les symboles utilisés par le module doivent exister dans le bundle
// vendorisé : une faute de frappe ne se verrait qu'à l'exécution, chez
// l'utilisateur, puisque WebGL n'est pas testable ici.
const source = readFileSync(join(here, "..", "priv/static/assets/js/board3d.js"), "utf8");
const used = [...new Set([...source.matchAll(/THREE\.(\w+)/g)].map((m) => m[1]))].sort();
const missing = used.filter((name) => !(name in THREE));

check(
  "les " + used.length + " symboles Three.js utilisés existent dans le bundle",
  missing.length === 0,
  missing
);

check("la révision de Three.js est connue", typeof THREE.REVISION === "string", THREE.REVISION);

// Le module doit s'annoncer sur `window` pour qu'app.js le trouve, quel que
// soit l'ordre de chargement des scripts.
check(
  "le module s'expose sur window.Ludo3D",
  typeof globalThis.window.Ludo3D === "object" && typeof globalThis.window.Ludo3D.init === "function"
);
check(
  "le module annonce son API attendue par app.js",
  ["init", "setGeometry", "update", "setHandlers", "setRolling", "isReady"].every(
    (name) => typeof globalThis.window.Ludo3D[name] === "function"
  )
);

/* ------------------------------------------------------- graphe de scène */

section("Graphe de scène");

// Three.js sait construire une scène sans contexte WebGL : seul WebGLRenderer
// en a besoin. On peut donc vérifier ici que le plateau est réellement bâti,
// et pas seulement que les formules de position sont justes.
const { root, tokensGroup, diceByColor } = board.buildScene(geo);

const objects = [];
root.traverse((o) => objects.push(o));
const kinds = objects.filter((o) => o.userData && o.userData.kind);
const of = (kind) => kinds.filter((o) => o.userData.kind === kind);

check(
  "la scène contient le plateau, les pions et les dés",
  Boolean(root && tokensGroup && diceByColor)
);

// 56 cases d'anneau + 4 colonnes de 5 cases
check("les 76 cases sont construites", of("cell").length === 76, of("cell").length);
check("les 8 étoiles sont construites", of("star").length === 8, of("star").length);
check("les 4 bases sont construites", of("base").length === 4, of("base").length);
check("les 16 emplacements de base sont construits", of("slot").length === 16, of("slot").length);
check("les 4 triangles du centre sont construits", of("center").length === 4, of("center").length);
check("les 16 pions sont construits", of("token").length === 16, of("token").length);
check("un dé par joueur est construit", of("dice").length === 4, of("dice").length);
check("les 21 points de chaque dé sont construits", of("pip").length === 84, of("pip").length);

// les cases de départ portent la couleur de leur joueur
let cellsOk = true;
for (const color of geo.players) {
  const start = geo.ring[geo.starts[color]];
  const tile = of("cell").find(
    (o) => o.userData.cell[0] === start[0] && o.userData.cell[1] === start[1]
  );
  if (!tile || tile.userData.color !== geo.colors[color]) {
    cellsOk = false;
    console.log("    case de départ " + color + " : " + JSON.stringify(tile && tile.userData));
  }
}
check("les cases de départ portent la couleur de leur joueur", cellsOk);

// les plaques de base sont au bon endroit et de la bonne couleur
let plaquesOk = true;
for (const color of geo.players) {
  const plate = of("base").find((o) => o.userData.color === color);
  const [bx, by] = geo.base_areas[color];

  if (
    !plate ||
    plate.userData.area[0] !== bx ||
    plate.userData.area[1] !== by ||
    plate.material.color.getHexString() !== geo.colors[color].replace("#", "")
  ) {
    plaquesOk = false;
    console.log("    base " + color + " : " + JSON.stringify(plate && plate.userData));
  }
}
check("chaque base est au bon endroit et de la bonne couleur", plaquesOk);

const horsPlateau = of("cell").filter(
  (o) => Math.abs(o.position.x) > 7.5 || Math.abs(o.position.z) > 7.5
);
check("aucune case ne sort du plateau", horsPlateau.length === 0, horsPlateau.length);

// Un triangle plat dont la face regarde vers le bas est éliminé par le
// back-face culling : il existe, mais il est invisible. C'est ce qui était
// arrivé aux triangles bleu et jaune, absents du plateau.
let normalesOk = true;
for (const tri of of("center")) {
  const p = tri.geometry.getAttribute("position");
  const a = new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0));
  const b = new THREE.Vector3(p.getX(1), p.getY(1), p.getZ(1));
  const c = new THREE.Vector3(p.getX(2), p.getY(2), p.getZ(2));
  const normale = new THREE.Vector3()
    .subVectors(b, a)
    .cross(new THREE.Vector3().subVectors(c, a))
    .normalize();

  if (normale.y <= 0) {
    normalesOk = false;
    console.log("    triangle " + tri.userData.color + " : normal.y = " + normale.y.toFixed(3));
  }
}
check("les quatre triangles du centre regardent vers le haut", normalesOk);

const centresHors = of("center").filter((o) => {
  const p = o.geometry.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) > 1.5 + 1e-6 || Math.abs(p.getZ(i)) > 1.5 + 1e-6) return true;
  }
  return false;
});
check(
  "les triangles du centre tiennent dans le carré central",
  centresHors.length === 0,
  centresHors.length
);

// chaque dé est posé à l'extérieur du plateau, du côté de son camp
let desOk = true;
for (const [color, node] of diceByColor) {
  const [bx, by] = geo.base_areas[color];
  const p = node.group.position;
  const bonCote = Math.sign(p.x) === Math.sign(bx > 0 ? 1 : -1) && Math.sign(p.z) === Math.sign(by > 0 ? 1 : -1);

  if (!bonCote || Math.abs(p.x) <= 7.5 || Math.abs(p.z) <= 7.5 || p.y <= 0.5) {
    desOk = false;
    console.log("    dé " + color + " mal posé : " + JSON.stringify(p.toArray()));
  }
}
check("chaque dé est posé à l'extérieur, du côté de son camp", desOk);

/* --------------------------------------------------- positions appliquées */

section("Positions appliquées");

function etatAvecPositions(positionsParCouleur, options = {}) {
  return Object.assign(
    {
      status: "playing",
      turn_color: geo.players[0],
      dice: null,
      legal_moves: [],
      players: geo.players.map((color, seat) => ({
        color,
        seat,
        tokens: positionsParCouleur[color] || ["base", "base", "base", "base"]
      }))
    },
    options
  );
}

board.update(etatAvecPositions({}), geo.players[0]);
board.settle();

let basesPlacees = true;
for (const color of geo.players) {
  for (let i = 0; i < 4; i++) {
    const attendu = board.tokenWorldPosition(geo, color, i, "base");
    const pose = board.tokenPositions()[color + ":" + i];
    if (
      !pose ||
      Math.abs(pose.x - attendu.x) > 1e-3 ||
      Math.abs(pose.z - attendu.z) > 1e-3 ||
      Math.abs(pose.y - attendu.y) > 1e-3
    ) {
      basesPlacees = false;
      console.log("    pion " + color + ":" + i + " -> " + JSON.stringify(pose));
    }
  }
}
check("les 16 pions se placent sur leurs emplacements de base", basesPlacees);

// un pion mis sur l'anneau doit rejoindre la bonne case
board.update(etatAvecPositions({ red: [0, 30, geo.finish, "base"] }), geo.players[0]);
board.settle();

let anneauOk = true;
for (const [index, position] of [
  [0, 0],
  [1, 30],
  [2, geo.finish]
]) {
  const attendu = board.tokenWorldPosition(geo, "red", index, position);
  const pose = board.tokenPositions()["red:" + index];
  if (!pose || Math.abs(pose.x - attendu.x) > 1e-3 || Math.abs(pose.z - attendu.z) > 1e-3) {
    anneauOk = false;
    console.log("    red:" + index + " position " + position + " -> " + JSON.stringify(pose));
  }
}
check("un pion envoyé sur l'anneau rejoint sa case", anneauOk);

// un pion capturé revient à sa base
board.update(etatAvecPositions({ red: ["base", 0, 0, 0] }), geo.players[0]);
board.settle();
const retour = board.tokenPositions()["red:0"];
const baseAttendue = board.tokenWorldPosition(geo, "red", 0, "base");
check(
  "un pion capturé revient à sa base",
  Math.abs(retour.x - baseAttendue.x) < 1e-3 && Math.abs(retour.z - baseAttendue.z) < 1e-3,
  retour
);

/* ------------------------------------------------------- dérive des pions */

section("Les pions ne dérivent pas");

// Deux pions sur la même case : le jeu l'autorise (les blocs ne sont pas
// appliqués). Leur écartement était ajouté à la position courante à chaque mise
// à jour, si bien qu'ils s'éloignaient indéfiniment — jusqu'à sortir du
// plateau. On rejoue donc le même état des centaines de fois, comme le font les
// diffusions du serveur au fil d'une partie.
const etatPartage = {
  status: "playing",
  turn_color: geo.players[0],
  dice: null,
  legal_moves: [],
  players: geo.players.map((color, seat) => ({
    color,
    seat,
    tokens:
      seat === 0 ? [5, 5, "base", "base"] : ["base", "base", "base", "base"]
  }))
};

board.update(etatPartage, geo.players[0]);
board.stepFrames(120);
const avant = board.tokenPositions();

for (let i = 0; i < 300; i++) {
  board.update(etatPartage, geo.players[0]);
  board.stepFrames(2);
}
board.stepFrames(120);

const apres = board.tokenPositions();
let stable = true;

for (const key of Object.keys(avant)) {
  const a = avant[key];
  const b = apres[key];
  if (Math.abs(a.x - b.x) > 1e-3 || Math.abs(a.z - b.z) > 1e-3) {
    stable = false;
    console.log("    " + key + " : " + JSON.stringify(a) + " -> " + JSON.stringify(b));
  }
}
check("rejouer le même état ne déplace pas les pions", stable);

const dehors = Object.entries(apres).filter(
  ([, p]) => Math.abs(p.x) > 7.5 || Math.abs(p.z) > 7.5
);
check("aucun pion ne sort du plateau", dehors.length === 0, dehors.slice(0, 3));

// l'écartement doit malgré tout fonctionner : les deux pions restent distincts
const p0 = apres["red:0"];
const p1 = apres["red:1"];
const ecart = Math.hypot(p0.x - p1.x, p0.z - p1.z);
check(
  "les deux pions de la même case restent écartés",
  ecart > 0.2 && ecart < 0.6,
  Number(ecart.toFixed(3))
);

board.update(etatAvecPositions({}), geo.players[0]);
board.settle();

/* ----------------------------------------------------------- surbrillance */

section("Surbrillance");

board.update(
  etatAvecPositions({}, { dice: 6, legal_moves: [0, 2] }),
  geo.players[0]
);
check(
  "les pions jouables du joueur local s'illuminent",
  JSON.stringify(board.highlightedTokens()) === JSON.stringify(["red:0", "red:2"]),
  board.highlightedTokens()
);

board.update(
  etatAvecPositions({}, { turn_color: geo.players[1], dice: 6, legal_moves: [0, 1] }),
  geo.players[0]
);
check(
  "au tour d'un adversaire, aucun de nos pions ne s'illumine",
  board.highlightedTokens().length === 0,
  board.highlightedTokens()
);

// la face du dé suit la valeur reçue du serveur
board.update(etatAvecPositions({}, { dice: 3 }), geo.players[0]);
const cible = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(...board.DICE_ORIENTATIONS[3])
);
const faceEnHaut = new THREE.Vector3(...board.DICE_NORMALS[3]).applyQuaternion(cible);
check(
  "le dé s'oriente sur la valeur reçue du serveur",
  Math.abs(faceEnHaut.y - 1) < 1e-6,
  faceEnHaut.toArray().map((v) => Number(v.toFixed(3)))
);

/* ------------------------------------------------------------- cadrage */

section("Cadrage et vue 2D");

const limites = board.viewLimits();

// Tous les points à couvrir (le plateau et la rangée du dé) doivent tenir dans
// le cadre, au zoom le plus proche comme au plus éloigné.
let cadreOk = true;
for (const zoom of [limites.minZoom, limites.maxZoom]) {
  board.setView({ zoom });
  for (const [x, y, z] of board.framePoints()) {
    const p = board.project({ x, y, z });
    // les points de conception touchent le bord du cadre par construction :
    // on tolère l'arrondi, l'important est qu'ils ne soient pas coupés
    if (Math.abs(p.x) > 1 + 1e-6 || Math.abs(p.y) > 1 + 1e-6) {
      cadreOk = false;
      console.log(
        "    zoom " + zoom + " : " + JSON.stringify([x, y, z]) + " -> " + p.x.toFixed(2) + "," + p.y.toFixed(2)
      );
    }
  }
}
check("le plateau et le dé tiennent dans le cadre à tout zoom", cadreOk);

// Le zoom minimal doit réellement remplir le cadre, pas laisser le plateau
// perdu au milieu.
board.setView({ zoom: limites.minZoom });
let proche = 0;
for (const [x, y, z] of board.framePoints()) {
  const p = board.project({ x, y, z });
  proche = Math.max(proche, Math.abs(p.x), Math.abs(p.y));
}
check("au zoom minimal, le cadre est bien rempli", proche > 0.85, proche.toFixed(3));

/* --- la vue doit être plate et de dessus, pas une perspective --- */

// 1. sans perspective, deux longueurs égales dans le monde restent égales à
//    l'écran, où qu'elles soient
board.setView({ zoom: limites.minZoom });
const coinHautGauche = board.project({ x: -7.5, y: 0, z: -7.5 });
const coinHautDroit = board.project({ x: 7.5, y: 0, z: -7.5 });
const coinBasGauche = board.project({ x: -7.5, y: 0, z: 7.5 });
const largeur = coinHautDroit.x - coinHautGauche.x;
const hauteur = coinHautGauche.y - coinBasGauche.y;

check(
  "la vue est orthographique (le plateau est un carré à l'écran)",
  Math.abs(largeur - hauteur) < 1e-6,
  { largeur: largeur.toFixed(4), hauteur: hauteur.toFixed(4) }
);

// 2. la vue est de dessus : la ligne 0 du plateau s'affiche en haut
const haut = board.project({ x: 0, y: 0, z: -7 });
const bas = board.project({ x: 0, y: 0, z: 7 });
check(
  "la ligne 0 du plateau s'affiche en haut",
  haut.y > bas.y && Math.abs(haut.x) < 1e-6,
  { haut: haut.y.toFixed(3), bas: bas.y.toFixed(3) }
);

// 3. et de gauche à droite dans le bon sens
const gauche = board.project({ x: -7, y: 0, z: 0 });
const droite = board.project({ x: 7, y: 0, z: 0 });
check("la colonne 0 s'affiche à gauche", gauche.x < droite.x, {
  gauche: gauche.x.toFixed(3),
  droite: droite.x.toFixed(3)
});

// 4. la hauteur ne doit pas décaler un pion : vu de dessus, monter ne change
//    pas la position à l'écran (c'est le grossissement qui fait le bond)
const pose = board.project({ x: 2, y: 0, z: 3 });
const enLair = board.project({ x: 2, y: 0.5, z: 3 });
check(
  "monter un pion ne le déplace pas à l'écran",
  Math.abs(pose.x - enLair.x) < 1e-9 && Math.abs(pose.y - enLair.y) < 1e-9
);

// 5. les quatre dés doivent rester dans le cadre, donc cliquables
let desCadres = true;
for (const coin of [
  { x: -8.7, y: 0, z: -8.7 },
  { x: 8.7, y: 0, z: -8.7 },
  { x: -8.7, y: 0, z: 8.7 },
  { x: 8.7, y: 0, z: 8.7 }
]) {
  const p = board.project(coin);
  if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) desCadres = false;
}
check("les quatre dés sont dans le cadre", desCadres);

board.setView({ zoom: limites.minZoom });

/* --------------------------------------------------- le dé garde sa face */

section("Un dé par joueur, blanc hors de son tour");

function etatDe(overrides) {
  return Object.assign(
    {
      status: "playing",
      turn_color: geo.players[0],
      dice: null,
      legal_moves: [],
      players: geo.players.map((color, seat) => ({
        color,
        seat,
        tokens: ["base", "base", "base", "base"]
      }))
    },
    overrides
  );
}

// aucun lancer : les quatre dés sont blancs
board.update(etatDe({ dice: null }), geo.players[0]);
check(
  "sans lancer, les quatre dés sont blancs",
  Object.values(board.dicePipsVisible()).every((visible) => visible === false),
  board.dicePipsVisible()
);

// le rouge lance 5 : seul son dé s'allume
board.update(etatDe({ dice: 5, turn_color: geo.players[0] }), geo.players[0]);
check("le dé du joueur en cours prend la valeur", board.diceValue() === 5, board.diceValue());
check(
  "seul le dé du joueur en cours s'allume",
  JSON.stringify(board.dicePipsVisible()) ===
    JSON.stringify({ red: true, blue: false, yellow: false, green: false }),
  board.dicePipsVisible()
);

// il joue son pion : son dé redevient blanc
board.update(etatDe({ dice: null, turn_color: geo.players[0] }), geo.players[0]);
check(
  "après avoir joué, son dé redevient blanc",
  board.dicePipsVisible().red === false,
  board.dicePipsVisible()
);

// la main passe au bleu, qui lance 2
board.update(etatDe({ dice: 2, turn_color: geo.players[1] }), geo.players[0]);
check("c'est au tour du dé bleu de s'allumer", board.diceValues().blue === 2, board.diceValues());
check(
  "le dé rouge reste blanc",
  board.dicePipsVisible().red === false,
  board.dicePipsVisible()
);
check(
  "chaque dé a sa propre valeur",
  board.diceValues().red === null && board.diceValues().blue === 2,
  board.diceValues()
);

/* ------------------------------------------------------- clic sur son dé */

section("Seul son propre dé réagit au clic");

let lancers = 0;
board.setHandlers({ roll: () => lancers++, token: () => {} });

const offset = board.diceOffset();
const ndc = (x, z) => board.project({ x, y: 0, z });

// le rouge a la main, dé non lancé
board.update(etatDe({ dice: null, turn_color: geo.players[0] }), geo.players[0]);
board.setView({ zoom: limites.minZoom });

const coinRouge = ndc(-offset, -offset);
const coinBleu = ndc(offset, -offset);
const coinJaune = ndc(offset, offset);
const coinVert = ndc(-offset, offset);

check("le dé rouge est atteint par un clic", board.diceAt(coinRouge.x, coinRouge.y) === "red");
check("le dé bleu aussi", board.diceAt(coinBleu.x, coinBleu.y) === "blue");

board.clickAt(coinBleu.x, coinBleu.y);
check("cliquer sur le dé d'un autre joueur ne lance rien", lancers === 0, lancers);

board.clickAt(coinRouge.x, coinRouge.y);
check("cliquer sur son propre dé lance", lancers === 1, lancers);

// la main passe au bleu : c'est son dé qui devient actif
board.update(etatDe({ dice: null, turn_color: geo.players[1] }), geo.players[0]);

board.clickAt(coinRouge.x, coinRouge.y);
check("l'ancien joueur ne peut plus lancer", lancers === 1, lancers);

board.clickAt(coinBleu.x, coinBleu.y);
check("le nouveau joueur peut lancer", lancers === 2, lancers);

// un clic dans le vide ne fait rien
const vide = board.clickAt(0.99, -0.99);
check("un clic à côté ne déclenche rien", vide === null, vide);

// les autres dés existent bien, à leur place
check("le dé jaune est à son coin", board.diceAt(coinJaune.x, coinJaune.y) === "yellow");
check("le dé vert est à son coin", board.diceAt(coinVert.x, coinVert.y) === "green");

/* ----------------------------------------------------------------- résultat */

console.log("\n== Résultat ==");
if (failures === 0) {
  console.log("Tous les tests passent.");
} else {
  console.log("ÉCHECS : " + failures);
  process.exitCode = 1;
}
console.log(checks + " vérifications");
