/*
 * Vérifie le client sans navigateur.
 *
 * On charge `app.js` (script classique) avec un DOM factice, on lui injecte la
 * géométrie réelle du serveur et on rejoue des états de partie complets. Cela
 * couvre la liste des joueurs, le panneau du dé et la bannière.
 *
 * Le plateau lui-même est en 3D : sa géométrie est vérifiée par
 * scripts/three_check.mjs (fonctions pures du module Three.js), et la structure
 * du plateau côté serveur par test/ludo/board_test.exs.
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' 2>/dev/null | tail -1 > /tmp/geometry.json
 *   node scripts/geometry_check.mjs /tmp/geometry.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const geometryPath = process.argv[2] || "/tmp/geometry.json";
const geo = JSON.parse(readFileSync(geometryPath, "utf8"));

/* ------------------------------------------------------------- DOM factice */

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: tag,
    children: [],
    attributes: {},
    style: {
      setProperty: function (name, value) {
        this[name] = value;
      },
      getPropertyValue: function (name) {
        return this[name] || "";
      }
    },
    dataset: {},
    hidden: false,
    disabled: false,
    offsetWidth: 100,
    // comme dans un navigateur : le texte d'un élément agrège celui de ses enfants
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join("");
      return this._text || "";
    },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    },
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
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    querySelector() {
      return null;
    },
    set innerHTML(_v) {
      this.children = [];
    },
    get innerHTML() {
      return "";
    },
    allDescendants() {
      return this.children.flatMap((c) => [c, ...c.allDescendants()]);
    }
  };
  return el;
}

const elements = new Map();
const elementFor = (selector) => {
  if (!elements.has(selector)) elements.set(selector, makeElement("div"));
  return elements.get(selector);
};

const listeners = {};

globalThis.window = {
  location: { href: "/" },
  addEventListener: (name, fn) => {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  },
  dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event)),
  setTimeout: () => 0,
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
};
globalThis.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};
globalThis.document = {
  readyState: "complete",
  hidden: false,
  querySelector: (selector) => (selector === "[data-page]" ? null : elementFor(selector)),
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  addEventListener: (name, fn) => {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  }
};

(0, eval)(readFileSync(join(here, "..", "priv/static/assets/js/app.js"), "utf8"));

// app.js s'expose sur `window`, qui est ici un objet factice et non globalThis
const api = globalThis.window.LudoClient.__test;

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

/* ------------------------------------------------------------------ états */

function syntheticState(overrides = {}) {
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
      dice: null,
      six_streak: 0,
      version: 1,
      players,
      legal_moves: [],
      log: []
    },
    overrides
  );
}

api.setGeometry(geo);
api.setSeat(0, geo.players[0]);

/* ----------------------------------------------------------- liste joueurs */

section("Liste des joueurs");

api.renderState(syntheticState({ turn: 2, turn_color: geo.players[2] }));

const playersList = elementFor("#players");
const rows = playersList.children;

check("les quatre joueurs sont listés", rows.length === 4, rows.length);
check(
  "chaque ligne porte la couleur de son joueur",
  rows.every((li, i) => {
    const swatch = li.children.find((c) => c.classList.contains("swatch"));
    return swatch && swatch.style.background === geo.colors[geo.players[i]];
  })
);
check(
  "un seul joueur est mis en évidence",
  rows.filter((li) => li.classList.contains("active")).length === 1
);
check(
  "c'est bien le joueur dont c'est le tour",
  rows[2] && rows[2].classList.contains("active")
);
check(
  "le joueur local est signalé",
  rows[0] &&
    rows[0].children.some(
      (c) => c.classList.contains("player-name") && c.textContent.indexOf("(vous)") !== -1
    )
);
check(
  "les IA sont étiquetées",
  rows.filter((li) => li.children.some((c) => c.classList.contains("tag"))).length === 3
);
check(
  "la progression est affichée",
  rows.every((li) =>
    li.children.some((c) => c.classList.contains("player-meta") && c.textContent === "0/4")
  )
);

/* --------------------------------------------------------------------- dé */

section("Le dé");

const dice = elementFor("#dice");
const hint = elementFor("#hint");

api.renderState(syntheticState({ dice: null, turn_color: geo.players[0] }));
check("à son tour, dé non lancé : le dé est actif", dice.disabled === false, dice.disabled);
check("le dé actif invite au clic", dice.classList.contains("ready"));
check(
  "l'indication invite à cliquer sur le dé",
  hint.textContent.indexOf("Cliquez") !== -1 && hint.textContent.indexOf("dé") !== -1,
  hint.textContent
);

api.renderState(syntheticState({ dice: null, turn_color: geo.players[1] }));
check("au tour d'un autre : le dé est inactif", dice.disabled === true, dice.disabled);
check("le dé inactif n'invite pas au clic", !dice.classList.contains("ready"));

api.renderState(syntheticState({ dice: 4, turn_color: geo.players[0] }));
check("dé déjà lancé : le dé est inactif", dice.disabled === true, dice.disabled);

// faces à points : grille 3x3, indices des points allumés
const FACES = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

let facesOk = true;
let pipsOk = true;

for (const value of [1, 2, 3, 4, 5, 6]) {
  api.renderState(syntheticState({ dice: value, turn_color: geo.players[0] }));

  const pips = dice.allDescendants().filter((el) => el.classList.contains("pip"));
  if (pips.length !== 9) pipsOk = false;

  const lit = pips.map((el, i) => (el.classList.contains("on") ? i : -1)).filter((i) => i !== -1);
  if (JSON.stringify(lit) !== JSON.stringify(FACES[value])) {
    facesOk = false;
    console.log("    face " + value + " : " + JSON.stringify(lit));
  }
}

check("le dé affiche une grille de 9 points", pipsOk);
check("chaque face allume exactement les bons points", facesOk);
check(
  "le dé n'affiche aucun texte",
  dice.allDescendants().every((el) => !el.textContent) && !dice.textContent
);

// Le dé garde ensuite la dernière valeur jouée : le seul moment où il est
// réellement vide, c'est avant le début de la partie.
api.renderState(syntheticState({ status: "waiting", dice: null }));
check(
  "avant le premier lancer, aucun point allumé",
  dice.allDescendants().filter((el) => el.classList.contains("on")).length === 0
);

/* ------------------------------------------- le dé garde le numéro joué */

section("Le dé garde le numéro joué");

// Retrouve la face affichée à partir des points allumés.
function shownFace() {
  const pips = dice.allDescendants().filter((el) => el.classList.contains("pip"));
  const lit = pips.map((el, i) => (el.classList.contains("on") ? i : -1)).filter((i) => i !== -1);
  if (lit.length === 0) return null;

  for (const [value, pattern] of Object.entries(FACES)) {
    if (JSON.stringify(pattern) === JSON.stringify(lit)) return Number(value);
  }
  return "inconnue:" + JSON.stringify(lit);
}

api.renderState(syntheticState({ status: "waiting", dice: null }));
check("avant le premier lancer, le dé est vide", shownFace() === null);

// scénario réel : le rouge lance 3, joue son pion, la main passe au bleu
api.renderState(syntheticState({ dice: 3, turn: 0, turn_color: geo.players[0] }));
check("un lancer affiche son numéro", shownFace() === 3, shownFace());

api.renderState(syntheticState({ dice: null, turn: 1, turn_color: geo.players[1] }));
check(
  "après le coup, le numéro reste affiché jusqu'au joueur suivant",
  shownFace() === 3,
  shownFace()
);
check(
  "l'étiquette dit qui a lancé",
  String(dice.attributes["aria-label"]).indexOf("Joueur 0") !== -1,
  dice.attributes["aria-label"]
);
check("le dé porte un liseré de couleur", dice.classList.contains("current"));
check(
  "le liseré prend la couleur du joueur dont c'est le tour, pas du lanceur",
  dice.style["--turn-color"] === geo.colors[geo.players[1]],
  { attendu: geo.colors[geo.players[1]], obtenu: dice.style["--turn-color"] }
);
check(
  "le numéro affiché reste bien celui du lanceur précédent",
  shownFace() === 3,
  shownFace()
);

// le joueur suivant lance à son tour : là seulement le numéro change
api.renderState(syntheticState({ dice: 6, turn: 1, turn_color: geo.players[1] }));
check("un nouveau lancer remplace le précédent", shownFace() === 6, shownFace());
check(
  "le liseré reste celui du joueur en cours",
  dice.style["--turn-color"] === geo.colors[geo.players[1]],
  dice.style["--turn-color"]
);

// la main passe à un troisième joueur : le liseré le suit, le numéro ne bouge pas
api.renderState(syntheticState({ dice: null, turn: 2, turn_color: geo.players[2] }));
check(
  "quand la main passe, le liseré suit le nouveau joueur",
  dice.style["--turn-color"] === geo.colors[geo.players[2]],
  { attendu: geo.colors[geo.players[2]], obtenu: dice.style["--turn-color"] }
);
check("et le numéro affiché ne change pas", shownFace() === 6, shownFace());

// en fin de partie il n'y a plus de tour en cours : plus de liseré
api.renderState(
  syntheticState({ status: "finished", winner: geo.players[1], turn_color: geo.players[1] })
);
check("en fin de partie, plus de liseré", !dice.classList.contains("current"));

// un 6 donne un tour supplémentaire : le numéro ne doit pas disparaître
api.renderState(syntheticState({ dice: null, turn: 1, turn_color: geo.players[1] }));
check(
  "après un 6 et un tour supplémentaire, le 6 reste affiché",
  shownFace() === 6,
  shownFace()
);

// le numéro ne doit jamais changer tout seul : on rejoue le même état
api.renderState(syntheticState({ dice: null, turn: 1, turn_color: geo.players[1], version: 9 }));
api.renderState(syntheticState({ dice: null, turn: 1, turn_color: geo.players[1], version: 10 }));
check(
  "le numéro ne change pas tant que personne ne relance",
  shownFace() === 6,
  shownFace()
);

// et il reste lisible une fois la partie terminée
api.renderState(
  syntheticState({ status: "finished", winner: geo.players[1], turn_color: geo.players[1] })
);
check("le dernier numéro reste affiché en fin de partie", shownFace() === 6, shownFace());

/* -------------------------------------------------------------- bannière */

section("Bannière");

const banner = elementFor("#banner");

api.renderState(syntheticState({ status: "waiting", dice: null }));
check("en attente : la bannière est visible", banner.hidden === false);
check(
  "en attente : elle indique ce qu'on attend",
  typeof banner.textContent === "string" && banner.textContent.length > 0,
  banner.textContent
);

api.renderState(syntheticState({ turn_color: geo.players[1] }));
check("en cours : la bannière est masquée", banner.hidden === true);

api.renderState(
  syntheticState({ status: "finished", winner: geo.players[2], turn_color: geo.players[2] })
);
check("partie terminée : la bannière est visible", banner.hidden === false);
check(
  "partie terminée : le vainqueur est nommé",
  String(banner.textContent).indexOf("Joueur 2") !== -1,
  banner.textContent
);

/* ----------------------------------------------------- robustesse du rendu */

section("Robustesse du rendu");

let error = null;
for (const status of ["waiting", "playing", "finished"]) {
  try {
    api.renderState(syntheticState({ status }));
  } catch (e) {
    error = e;
  }
}
check("renderState ne lève jamais d'exception", error === null, error && error.message);

try {
  api.renderState(null);
  api.renderState(undefined);
  error = null;
} catch (e) {
  error = e;
}
check("un état absent est ignoré sans planter", error === null, error && error.message);

// le dé ne doit rien lancer si ce n'est pas possible
api.renderState(syntheticState({ dice: null, turn_color: geo.players[1] }));
try {
  api.rollDice();
  error = null;
} catch (e) {
  error = e;
}
check("lancer le dé hors de son tour ne fait rien", error === null, error && error.message);

api.renderState(syntheticState({ status: "waiting", dice: null, turn_color: geo.players[0] }));
try {
  api.rollDice();
  error = null;
} catch (e) {
  error = e;
}
check("lancer le dé en attente de joueurs ne fait rien", error === null, error && error.message);

/* ------------------------------------------------------------------ résultat */

console.log("\n== Résultat ==");
if (failures === 0) {
  console.log("Tous les tests passent.");
} else {
  console.log("ÉCHECS : " + failures);
  process.exitCode = 1;
}
console.log(checks + " vérifications");
