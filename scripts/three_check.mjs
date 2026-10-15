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

/* ----------------------------------------------------------------- résultat */

console.log("\n== Résultat ==");
if (failures === 0) {
  console.log("Tous les tests passent.");
} else {
  console.log("ÉCHECS : " + failures);
  process.exitCode = 1;
}
console.log(checks + " vérifications");
