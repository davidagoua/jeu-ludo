/*
 * Vérifie le client navigateur sans navigateur.
 *
 * Le fichier est chargé avec un DOM factice minimal, puis :
 *
 *   1. `tokenCellFor` est confronté à la géométrie RÉELLE du serveur : chaque
 *      position de pion doit tomber sur la bonne case de la grille 15×15 ;
 *   2. `buildBoard` doit construire le plateau complet en SVG ;
 *   3. `renderState` doit rendre les quatre états (attente, en cours, pause,
 *      terminé) sans lever d'exception, et placer les 16 pions.
 *
 * La géométrie est produite par Elixir :
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' > /tmp/geometry.json
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
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c))
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
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

/* ------------------------------------------------------------------ test */

if (!client || !api) {
  console.error("Le client n'a pas exposé LudoClient.__test");
  process.exit(1);
}

const geo = JSON.parse(readFileSync(geometryPath, "utf8"));
const grid = geo.grid;

section("Chargement du client");
check("app.js s'exécute et expose LudoClient", Boolean(client));
check("la géométrie du serveur est lisible", geo.ring.length === 56, geo.ring.length);
check("la grille fait 15×15", grid === 15, grid);

/* ------------------------------------------- positionnement des pions */

section("Positionnement des pions");

const cellOf = (pos) => pos;

let allInGrid = true;
let allDistinct = true;
let pathContinuous = true;

for (const color of geo.players) {
  const centres = [];

  // positions 0 à 60 (anneau puis colonne) + arrivée
  for (let pos = 0; pos <= geo.finish; pos++) {
    const [x, y] = api.tokenCellFor(geo, color, 0, pos);

    if (!(x >= 0 && x <= grid && y >= 0 && y <= grid)) {
      allInGrid = false;
      console.log("    hors grille : " + color + " pos " + pos + " -> " + x + "," + y);
    }

    if (pos <= 60) centres.push(x + ":" + y);
  }

  if (new Set(centres).size !== centres.length) {
    allDistinct = false;
    console.log("    positions répétées pour " + color);
  }

  // le parcours doit être une suite de cases adjacentes (distance 1)
  const cells = [];
  for (let pos = 0; pos <= 60; pos++) cells.push(api.tokenCellFor(geo, color, 0, pos));

  for (let i = 1; i < cells.length; i++) {
    const dx = Math.abs(cells[i][0] - cells[i - 1][0]);
    const dy = Math.abs(cells[i][1] - cells[i - 1][1]);
    if (Math.abs(dx - 1) > 1e-9 && Math.abs(dy - 1) > 1e-9) {
      pathContinuous = false;
      console.log(
        "    parcours discontinu : " + color + " " + i + " -> " + JSON.stringify(cells[i - 1]) + " / " + JSON.stringify(cells[i])
      );
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

  // position 55 = entrée de la colonne d'arrivée
  const [ex, ey] = api.tokenCellFor(geo, color, 0, 55);
  const entranceIndex = (geo.starts[color] + 55) % geo.ring_size;
  const entrance = geo.ring[entranceIndex];
  check(
    "position 55 = entrée de la colonne (" + color + ")",
    Math.abs(ex - (entrance[0] + 0.5)) < 1e-9 && Math.abs(ey - (entrance[1] + 0.5)) < 1e-9
  );

  // positions 56 à 60 = colonne d'arrivée
  let columnOk = true;
  for (let k = 0; k < geo.home_length; k++) {
    const [hx, hy] = api.tokenCellFor(geo, color, 0, geo.ring_size + k);
    const cell = geo.home_columns[color][k];
    if (Math.abs(hx - (cell[0] + 0.5)) > 1e-9 || Math.abs(hy - (cell[1] + 0.5)) > 1e-9) columnOk = false;
  }
  check("positions 56-60 = colonne d'arrivée (" + color + ")", columnOk);

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
  const [fx, fy] = api.tokenCellFor(geo, color, 0, geo.finish);
  check(
    "arrivée dans le carré central (" + color + ")",
    fx >= 6 && fx <= 9 && fy >= 6 && fy <= 9,
    [fx, fy]
  );

  void cellOf;
}

check("toutes les positions restent dans la grille", allInGrid);
check("les 61 positions d'un parcours sont distinctes", allDistinct);
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
check("le plateau contient des éléments SVG", board.children.length > 56, board.children.length);
check("le calque des pions existe", board.children.some((c) => c.attributes && c.attributes.id === "tokens"));

/* ------------------------------------------------------------- rendu d'état */

section("Rendu des états");

// sans cette information, le client ne peut pas savoir quels pions sont les
// siens et aucun pion ne serait cliquable.
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
      turn_color: "red",
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
  en_cours_de: syntheticState({ dice: null, legal_moves: [] }),
  en_cours_pions: syntheticState({
    players: geo.players.map((color, seat) => ({
      seat,
      name: "Joueur " + seat,
      color,
      kind: "human",
      connected: seat !== 3,
      tokens:
        seat === 0
          ? [0, 20, 55, 61]
          : seat === 1
            ? [5, 34, 40, "base"]
            : seat === 2
              ? [57, "base", "base", "base"]
              : ["base", "base", "base", "base"],
      finished: seat === 0 ? 1 : 0
    })),
    dice: 6,
    legal_moves: [1]
  }),
  termine: syntheticState({ status: "finished", winner: "green", dice: null, legal_moves: [] })
};

let clickableInPlay = null;
let highlightedInPlay = null;

for (const [name, state] of Object.entries(scenarios)) {
  let error = null;
  try {
    api.renderState(state);
  } catch (e) {
    error = e;
  }
  check("renderState(" + name + ") sans exception", error === null, error && error.message);

  // On mesure pendant que la partie est en cours : la scénario « terminé »,
  // rendue ensuite, désactive logiquement tous les pions.
  if (name === "en_cours_pions") {
    const layer = elementFor("#tokens");
    check("les 16 pions sont rendus", layer.children.length === 16, layer.children.length);

    clickableInPlay = layer.children.filter((t) => t.classList.contains("clickable")).length;
    highlightedInPlay = layer.children.filter((t) => t.classList.contains("highlight")).length;
  }
}

// un seul pion est jouable dans cette scénario (legal_moves = [1] pour rouge)
check("seuls les pions jouables sont cliquables", clickableInPlay === 1, clickableInPlay);
check("les pions jouables sont mis en surbrillance", highlightedInPlay === 1, highlightedInPlay);

section("Résultat");
console.log(failures.length === 0 ? "Tous les tests passent." : "ÉCHECS : " + failures.join(", "));
console.log(checks + " vérifications");
process.exit(failures.length === 0 ? 0 : 1);
