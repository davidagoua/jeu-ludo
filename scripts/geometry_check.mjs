/*
 * Vérifie le client navigateur sans navigateur.
 *
 * Le fichier est chargé avec un DOM factice minimal, puis :
 *
 *   1. `tokenCellFor` est confronté à la géométrie RÉELLE du serveur : chaque
 *      position de pion doit tomber sur la bonne case de la grille 15×15 ;
 *   2. `buildBoard` doit construire le plateau complet en SVG, avec les cases
 *      de départ colorées à la couleur de leur joueur ;
 *   3. `renderState` doit rendre les quatre états sans lever d'exception,
 *      placer les 16 pions, n'activer que les pions jouables et n'illuminer que
 *      la base du joueur dont c'est le tour ;
 *   4. le dé doit afficher des points (et non un chiffre), avec la bonne face.
 *
 * Le script ne code aucune constante du plateau : tout est lu dans la géométrie.
 *
 * La géométrie est produite par Elixir :
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' 2>/dev/null | tail -1 > /tmp/geometry.json
 *   node scripts/geometry_check.mjs /tmp/geometry.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const geometryPath = process.argv[2] || "/tmp/geometry.json";

const failures = [];
let checks = 0;

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log("  OK   " + label);
  } else {
    failures.push(label);
    console.log("  FAIL " + label + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
}

function section(title) {
  console.log("\n== " + title + " ==");
}

/* ------------------------------------------------------------- DOM factice */

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    textContent: "",
    offsetWidth: 100,
    // `className` et `classList` doivent rester cohérents : le client utilise
    // les deux selon les endroits.
    get className() {
      return Array.from(classes).join(" ");
    },
    set className(value) {
      classes.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) =>
        on === undefined
          ? classes.has(c)
            ? classes.delete(c)
            : classes.add(c)
          : on
            ? classes.add(c)
            : classes.delete(c)
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === "class") classes.add(v);
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    querySelector() {
      return null;
    },
    set innerHTML(_value) {
      this.children = [];
    },
    get innerHTML() {
      return "";
    },
    allDescendants() {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
  };
  return el;
}

const elements = new Map();

function elementFor(selector) {
  if (!elements.has(selector)) elements.set(selector, makeElement("div"));
  return elements.get(selector);
}

globalThis.window = globalThis;
globalThis.document = {
  readyState: "complete",
  // `[data-page]` reste introuvable : `main()` sort immédiatement et on pilote
  // le rendu à la main.
  querySelector: (selector) => (selector === "[data-page]" ? null : elementFor(selector)),
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  addEventListener() {}
};

const clientCode = readFileSync(join(here, "..", "priv/static/assets/js/app.js"), "utf8");
(0, eval)(clientCode);

const client = globalThis.LudoClient;
const api = client && client.__test;

if (!client || !api) {
  console.error("Le client n'a pas exposé LudoClient.__test");
  process.exit(1);
}

const geo = JSON.parse(readFileSync(geometryPath, "utf8"));
const grid = geo.grid;
const lastRing = geo.last_ring_position;
const finish = geo.finish;

section("Chargement du client");
check("app.js s'exécute et expose LudoClient", Boolean(client));
check("la géométrie du serveur est lisible", geo.ring.length === geo.ring_size, geo.ring.length);
check("la grille fait 15×15", grid === 15, grid);
check("l'anneau s'arrête avant l'arrivée", lastRing < finish, { lastRing, finish });

/* ------------------------------------------- positionnement des pions */

section("Positionnement des pions");

let allInGrid = true;
let allDistinct = true;
let pathContinuous = true;

for (const color of geo.players) {
  // positions de l'anneau et de la colonne d'arrivée : 0 à finish-1
  const centres = [];

  for (let pos = 0; pos < finish; pos++) {
    const [x, y] = api.tokenCellFor(geo, color, 0, pos);

    if (!(x >= 0 && x <= grid && y >= 0 && y <= grid)) {
      allInGrid = false;
      console.log("    hors grille : " + color + " pos " + pos + " -> " + x + "," + y);
    }

    centres.push(x + ":" + y);
  }

  if (new Set(centres).size !== centres.length) {
    allDistinct = false;
    console.log("    positions répétées pour " + color);
  }

  // le parcours doit être une suite de cases adjacentes
  const cells = [];
  for (let pos = 0; pos < finish; pos++) cells.push(api.tokenCellFor(geo, color, 0, pos));

  for (let i = 1; i < cells.length; i++) {
    const dx = Math.abs(cells[i][0] - cells[i - 1][0]);
    const dy = Math.abs(cells[i][1] - cells[i - 1][1]);
    if (Math.abs(dx - 1) > 1e-9 && Math.abs(dy - 1) > 1e-9) {
      pathContinuous = false;
      console.log("    parcours discontinu : " + color + " en " + i);
      break;
    }
  }

  // position 0 = case de départ du joueur
  const [sx, sy] = api.tokenCellFor(geo, color, 0, 0);
  const startCell = geo.ring[geo.starts[color]];
  check(
    "position 0 = case de départ (" + color + ")",
    Math.abs(sx - (startCell[0] + 0.5)) < 1e-9 && Math.abs(sy - (startCell[1] + 0.5)) < 1e-9,
    { got: [sx, sy], expected: [startCell[0] + 0.5, startCell[1] + 0.5] }
  );

  // dernière position d'anneau = entrée de la colonne d'arrivée
  const [ex, ey] = api.tokenCellFor(geo, color, 0, lastRing);
  const entrance = geo.ring[(geo.starts[color] + lastRing) % geo.ring_size];
  check(
    "position " + lastRing + " = entrée de la colonne (" + color + ")",
    Math.abs(ex - (entrance[0] + 0.5)) < 1e-9 && Math.abs(ey - (entrance[1] + 0.5)) < 1e-9,
    { got: [ex, ey], expected: [entrance[0] + 0.5, entrance[1] + 0.5] }
  );

  // colonne d'arrivée
  let columnOk = true;
  for (let k = 0; k < geo.home_length; k++) {
    const [hx, hy] = api.tokenCellFor(geo, color, 0, lastRing + 1 + k);
    const cell = geo.home_columns[color][k];
    if (Math.abs(hx - (cell[0] + 0.5)) > 1e-9 || Math.abs(hy - (cell[1] + 0.5)) > 1e-9) columnOk = false;
  }
  check(
    "positions " + (lastRing + 1) + "-" + (finish - 1) + " = colonne d'arrivée (" + color + ")",
    columnOk
  );

  // base : chaque pion a son emplacement
  let baseOk = true;
  const basePositions = [];
  for (let index = 0; index < 4; index++) {
    const [bx, by] = api.tokenCellFor(geo, color, index, "base");
    const slot = geo.bases[color][index];
    basePositions.push(bx + ":" + by);
    if (Math.abs(bx - (slot[0] + 0.5)) > 1e-9 || Math.abs(by - (slot[1] + 0.5)) > 1e-9) baseOk = false;
  }
  check("emplacements de base distincts (" + color + ")", new Set(basePositions).size === 4);
  check("emplacements de base conformes (" + color + ")", baseOk);

  // arrivée : le pion se range dans le triangle de sa couleur, au centre
  const [fx, fy] = api.tokenCellFor(geo, color, 0, finish);
  check(
    "arrivée dans le carré central (" + color + ")",
    fx >= 6 && fx <= 9 && fy >= 6 && fy <= 9,
    [fx, fy]
  );
}

check("toutes les positions restent dans la grille", allInGrid);
check("les " + finish + " positions d'un parcours sont distinctes", allDistinct);
check("le parcours est une suite de cases adjacentes", pathContinuous);

/* --------------------------------------------------- construction du plateau */

section("Construction du plateau");
api.setGeometry(geo);

let buildError = null;
try {
  api.buildBoard();
} catch (error) {
  buildError = error;
}
check("buildBoard() ne lève pas d'exception", buildError === null, buildError && buildError.message);

const board = elementFor("#board");
const boardParts = board.allDescendants();
check("le plateau contient des éléments SVG", boardParts.length > geo.ring_size, boardParts.length);
check(
  "le calque des pions existe",
  boardParts.some((c) => c.attributes && c.attributes.id === "tokens")
);

// les cases de départ sont colorées de la couleur de leur joueur
let startsColoured = true;
for (const color of geo.players) {
  const cell = geo.ring[geo.starts[color]];
  const found = boardParts.find(
    (el) =>
      el.tagName === "rect" &&
      el.attributes.x === cell[0] &&
      el.attributes.y === cell[1] &&
      el.attributes.width === 1
  );
  if (!found || found.attributes.fill !== geo.colors[color]) {
    startsColoured = false;
    console.log("    case de départ non colorée : " + color);
  }
}
check("les cases de départ portent la couleur de leur joueur", startsColoured);

// une étoile est dessinée sur chacune des 8 cases sûres
const stars = boardParts.filter((el) => el.tagName === "path").length;
check("les 8 cases sûres portent une étoile", stars === geo.safe_indexes.length, stars);

/* ------------------------------------------------------------- rendu d'état */

section("Rendu des états");

// sans cette information, le client ne sait pas quels pions sont les siens et
// aucun pion ne serait cliquable.
api.setSeat(0, "red");

function syntheticState(overrides) {
  const players = geo.players.map((color, seat) => ({
    seat,
    name: "Joueur " + seat,
    color,
    kind: seat === 0 ? "human" : "bot",
    connected: true,
    tokens: ["base", "base", "base", "base"],
    finished: 0
  }));

  return Object.assign(
    {
      code: "TEST",
      mode: "p4",
      mode_label: "4 joueurs",
      seats: 4,
      status: "playing",
      winner: null,
      turn: 0,
      turn_color: geo.players[0],
      turn_name: "Joueur 0",
      turn_is_bot: false,
      dice: 3,
      six_streak: 0,
      version: 1,
      players,
      legal_moves: [0, 1],
      log: [{ type: "rolled", text: "Joueur 0 lance un 3." }]
    },
    overrides
  );
}

const scenarios = {
  attente: syntheticState({ status: "waiting", dice: null, legal_moves: [] }),
  sans_de: syntheticState({ dice: null, legal_moves: [] }),
  en_cours: syntheticState({
    players: geo.players.map((color, seat) => ({
      seat,
      name: "Joueur " + seat,
      color,
      kind: "human",
      connected: seat !== 3,
      tokens:
        seat === 0
          ? [0, 20, lastRing, finish]
          : seat === 1
            ? [5, 34, 40, "base"]
            : seat === 2
              ? [lastRing + 1, "base", "base", "base"]
              : ["base", "base", "base", "base"],
      finished: seat === 0 ? 1 : 0
    })),
    dice: 6,
    legal_moves: [1]
  }),
  termine: syntheticState({ status: "finished", winner: geo.players[1], dice: null, legal_moves: [] })
};

let clickableInPlay = null;
let highlightedInPlay = null;
let activeBasesInPlay = null;

for (const [name, state] of Object.entries(scenarios)) {
  let error = null;
  try {
    api.renderState(state);
  } catch (e) {
    error = e;
  }
  check("renderState(" + name + ") sans exception", error === null, error && error.message);

  if (name === "en_cours") {
    const layer = elementFor("#tokens");
    check("les 16 pions sont rendus", layer.children.length === 16, layer.children.length);

    clickableInPlay = layer.children.filter((t) => t.classList.contains("clickable")).length;
    highlightedInPlay = layer.children.filter((t) => t.classList.contains("highlight")).length;

    // seule la base du joueur dont c'est le tour doit être illuminée
    activeBasesInPlay = boardParts.filter((el) => el.classList.contains("base-turn")).length;
  }
}

// un seul pion est jouable dans cette scénario (legal_moves = [1] pour le siège 0)
check("seuls les pions jouables sont cliquables", clickableInPlay === 1, clickableInPlay);
check("les pions jouables sont mis en surbrillance", highlightedInPlay === 1, highlightedInPlay);
check("une seule zone de joueur est illuminée", activeBasesInPlay === 1, activeBasesInPlay);

/* ------------------------------------------------------------------- le dé */

section("Le dé");

const dice = elementFor("#dice");
api.renderState(syntheticState({ dice: 5, legal_moves: [0] }));

// Les points sont dans l'ordre 0..8 d'une grille 3x3 : un 5 allume les quatre
// coins et le centre.
const pipEls = dice.allDescendants().filter((el) => el.classList.contains("pip"));
const litIndexes = pipEls
  .map((el, i) => (el.classList.contains("on") ? i : -1))
  .filter((i) => i !== -1);

check("le dé affiche 9 emplacements de points", pipEls.length === 9, pipEls.length);
check(
  "un 5 allume les quatre coins et le centre",
  JSON.stringify(litIndexes) === JSON.stringify([0, 2, 4, 6, 8]),
  litIndexes
);
check("le dé n'affiche aucun texte", dice.textContent === "", JSON.stringify(dice.textContent));

// chaque face allume le bon nombre de points
const expectedPips = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
let facesOk = true;
for (const [value, count] of Object.entries(expectedPips)) {
  api.renderState(syntheticState({ dice: Number(value), legal_moves: [] }));
  const on = elementFor("#dice")
    .allDescendants()
    .filter((el) => el.classList.contains("pip") && el.classList.contains("on")).length;
  if (on !== count) {
    facesOk = false;
    console.log("    face " + value + " : " + on + " points au lieu de " + count);
  }
}
check("chaque face allume le bon nombre de points", facesOk);

api.renderState(syntheticState({ status: "waiting", dice: null, legal_moves: [] }));
const noneLit = elementFor("#dice")
  .allDescendants()
  .filter((el) => el.classList.contains("pip") && el.classList.contains("on")).length;
check("aucun dé lancé : aucun point allumé", noneLit === 0, noneLit);

section("Résultat");
console.log(failures.length === 0 ? "Tous les tests passent." : "ÉCHECS : " + failures.join(", "));
console.log(checks + " vérifications");
process.exit(failures.length === 0 ? 0 : 1);
