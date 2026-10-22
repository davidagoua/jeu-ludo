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
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parent = null;
      return child;
    },
    remove() {
      if (this.parent) this.parent.removeChild(this);
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

// Rappels différés : on les retient au lieu de les exécuter, ce qui permet de
// vérifier les délais (l'affichage d'une réaction dure deux secondes).
const timers = [];

function flushTimers() {
  const attente = timers.splice(0, timers.length);
  for (const timer of attente) timer.fn();
  return attente;
}

globalThis.window = {
  location: { href: "/" },
  addEventListener: (name, fn) => {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  },
  dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event)),
  setTimeout: (fn, delay) => {
    timers.push({ fn, delay });
    return timers.length;
  },
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

/* ------------------------------------------------------------- bruitage --
 * On charge le vrai module de son avec un contexte audio factice : chaque son
 * produit des nœuds, qu'on compte et dont on relève la fréquence. C'est la
 * seule façon de vérifier sans haut-parleur qu'un son a bien été joué.
 */

const sonsJoues = [];

const contexteAudio = {
  currentTime: 0,
  sampleRate: 44100,
  state: "running",
  destination: {},
  createOscillator() {
    const noeud = {
      type: "sine",
      frequency: {
        valeur: null,
        setValueAtTime(v) {
          this.valeur = v;
          return this;
        },
        exponentialRampToValueAtTime(v) {
          this.rampe = v;
          return this;
        }
      },
      connect: (d) => d,
      start: () => sonsJoues.push({ genre: "note", frequence: noeud.frequency.valeur, rampe: noeud.frequency.rampe }),
      stop: () => {}
    };
    return noeud;
  },
  createBufferSource() {
    return {
      connect: (d) => d,
      start: () => sonsJoues.push({ genre: "bruit" }),
      stop: () => {}
    };
  },
  createGain() {
    return {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (d) => d
    };
  },
  createBiquadFilter() {
    return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect: (d) => d };
  },
  createBuffer: (_c, n) => ({ getChannelData: () => new Float32Array(n) }),
  resume() {}
};

globalThis.window.AudioContext = function () {
  return contexteAudio;
};

(0, eval)(
  readFileSync(join(here, "..", "priv/static/assets/js/sound.js"), "utf8")
);

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

/* --------------------------------- le dé n'affiche que pendant le tour */

section("Le dé n'affiche sa valeur que pendant le tour");

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
check("avant le premier lancer, le dé est blanc", shownFace() === null);

// le rouge lance 3 : son dé l'affiche
api.renderState(syntheticState({ dice: 3, turn: 0, turn_color: geo.players[0] }));
check("un lancer affiche son numéro", shownFace() === 3, shownFace());
check("le dé porte un liseré de couleur", dice.classList.contains("current"));
check(
  "le liseré prend la couleur du joueur dont c'est le tour",
  dice.style["--turn-color"] === geo.colors[geo.players[0]],
  dice.style["--turn-color"]
);

// il joue son pion : le serveur remet `dice` à zéro et le dé redevient blanc
api.renderState(syntheticState({ dice: null, turn: 0, turn_color: geo.players[0] }));
check(
  "une fois le pion joué, le dé redevient blanc",
  shownFace() === null,
  shownFace()
);

// un 6 donne un tour supplémentaire : le dé est blanc jusqu'au lancer suivant
api.renderState(syntheticState({ dice: 6, turn: 0, turn_color: geo.players[0] }));
check("le tour supplémentaire permet de relancer", shownFace() === 6, shownFace());

api.renderState(syntheticState({ dice: null, turn: 0, turn_color: geo.players[0] }));
check("et le dé redevient blanc après le coup", shownFace() === null, shownFace());

// la main passe au bleu, qui n'a pas encore lancé : blanc aussi
api.renderState(syntheticState({ dice: null, turn: 1, turn_color: geo.players[1] }));
check(
  "le joueur suivant commence avec un dé blanc",
  shownFace() === null,
  shownFace()
);

api.renderState(syntheticState({ dice: 2, turn: 1, turn_color: geo.players[1] }));
check("et affiche son propre numéro", shownFace() === 2, shownFace());

// en fin de partie, plus de tour : plus de liseré
api.renderState(
  syntheticState({ status: "finished", winner: geo.players[1], turn_color: geo.players[1] })
);
check("en fin de partie, plus de liseré", !dice.classList.contains("current"));
check("et le dé est blanc", shownFace() === null, shownFace());

/* ------------------------------------------------------- choix du camp */

section("Choix du camp");

const camps = elementFor("#camps");
const campsRow = elementFor("#camps-row");

// en attente : le sélecteur est visible, un bouton par siège
api.renderState(
  syntheticState({
    status: "waiting",
    seats: 4,
    players: [
      { seat: 0, name: "Alice", color: geo.players[0], kind: "human", connected: true, tokens: ["base", "base", "base", "base"], finished: 0 },
      { seat: 2, name: "Bob", color: geo.players[2], kind: "human", connected: true, tokens: ["base", "base", "base", "base"], finished: 0 }
    ]
  })
);

check("en attente, le sélecteur de camp est visible", camps.hidden === false);

const boutons = campsRow.children;
check("un bouton par camp", boutons.length === 4, boutons.length);

check(
  "chaque bouton porte la couleur de son siège",
  boutons.every((b, i) => {
    const point = b.children.find((c) => c.classList.contains("camp-dot"));
    const couleur = (geo.seat_colors || geo.players)[i];
    return point && point.style.background === geo.colors[couleur];
  })
);

check(
  "mon camp est marqué",
  boutons[0] && boutons[0].classList.contains("mine")
);

check(
  "les camps pris par d'autres sont désactivés",
  boutons[2] && boutons[2].disabled === true
);

check(
  "les camps libres sont cliquables",
  boutons[1] && boutons[1].disabled === false && boutons[3].disabled === false
);

check(
  "un camp libre est annoncé comme tel",
  boutons[1] &&
    boutons[1].children.some((c) => c.classList.contains("camp-label") && c.textContent === "libre")
);

check(
  "mon camp affiche « vous »",
  boutons[0] &&
    boutons[0].children.some((c) => c.classList.contains("camp-label") && c.textContent === "vous")
);

// en jeu, le sélecteur disparaît
api.renderState(syntheticState({ status: "playing" }));
check("en cours de partie, le sélecteur est masqué", camps.hidden === true);

// cliquer sur un camp libre envoie le choix
api.renderState(
  syntheticState({
    status: "waiting",
    seats: 4,
    players: [
      { seat: 0, name: "Alice", color: geo.players[0], kind: "human", connected: true, tokens: ["base", "base", "base", "base"], finished: 0 }
    ]
  })
);

let erreur = null;
try {
  api.chooseSeat(2);
} catch (e) {
  erreur = e;
}
check("choisir un camp ne lève pas d'exception", erreur === null, erreur && erreur.message);

// sans partie en cours, le choix est ignoré sans planter
let erreurHors = null;
try {
  api.chooseSeat(1);
} catch (e) {
  erreurHors = e;
}
check("choisir un camp hors partie ne plante pas", erreurHors === null, erreurHors && erreurHors.message);

/* ------------------------------------------------------------ réactions */

section("Réactions emoji");

{
  const MODAL = "#emoji-modal";
  const GRID = "#emoji-grid";
  const OVERLAY = "#reactions";

  const liste = ["👍", "😂", "🎉", "🔥", "😭"];
  api.setupReactions(liste);

  const grid = elementFor(GRID);
  check("la grille a un bouton par réaction", grid.children.length === liste.length, grid.children.length);
  check(
    "chaque bouton porte son emoji",
    grid.children.every((b, i) => b.textContent === liste[i]),
    grid.children.map((b) => b.textContent)
  );
  check(
    "chaque bouton est décrit pour les lecteurs d'écran",
    grid.children.every((b) => (b.getAttribute("aria-label") || "").includes("Réagir")),
    grid.children.map((b) => b.getAttribute("aria-label"))
  );
  check("la liste reçue est retenue", api.reactionsList().length === liste.length);

  const modal = elementFor(MODAL);
  // dans la page, la modale porte l'attribut `hidden` (vérifié côté Phoenix)
  modal.hidden = true;
  check("la modale est fermée au départ", modal.hidden === true);

  api.openEmoji();
  check("le bouton ouvre la modale", modal.hidden === false);

  // cliquer un emoji referme la modale
  api.sendReaction("👍");
  check("choisir une réaction referme la modale", modal.hidden === true);

  // hors partie, l'envoi ne fait rien mais ne plante pas
  let plantage = null;
  try {
    api.sendReaction("😂");
  } catch (e) {
    plantage = e;
  }
  check("envoyer hors partie ne plante pas", plantage === null, plantage && plantage.message);

  // un emoji inconnu est ignoré
  let inconnu = null;
  try {
    api.sendReaction("🚀");
  } catch (e) {
    inconnu = e;
  }
  check("un emoji hors liste est ignoré", inconnu === null, inconnu && inconnu.message);

  /* -------------------------------------------------------- affichage */

  const overlay = elementFor(OVERLAY);

  // on remet un état connu pour que le nom du joueur soit retrouvé
  api.renderState(syntheticState({}));

  timers.length = 0;
  api.showReaction({ color: "red", name: "Camille", emoji: "🎉" });

  check("une réaction s'affiche sur le plateau", overlay.children.length === 1, overlay.children.length);
  check(
    "elle porte l'emoji reçu",
    overlay.children[0] && overlay.children[0].textContent === "🎉",
    overlay.children[0] && overlay.children[0].textContent
  );
  check(
    "elle est placée dans le coin du joueur",
    overlay.children[0] && overlay.children[0].classList.contains("red"),
    overlay.children[0] && overlay.children[0].className
  );
  check(
    "elle nomme le joueur qui réagit",
    overlay.children[0] && (overlay.children[0].getAttribute("title") || "").includes("Camille"),
    overlay.children[0] && overlay.children[0].getAttribute("title")
  );

  const duree = timers.map((t) => t.delay);
  check(
    "elle est retirée au bout de deux secondes",
    duree.includes(2000) && duree.includes(api.reactionDuration()),
    duree
  );

  flushTimers();
  check("après le délai, plus rien n'est affiché", overlay.children.length === 0, overlay.children.length);

  // deux joueurs peuvent réagir en même temps
  timers.length = 0;
  api.showReaction({ color: "blue", emoji: "😂" });
  api.showReaction({ color: "green", emoji: "🔥" });
  check("deux réactions simultanées s'affichent ensemble", overlay.children.length === 2, overlay.children.length);
  check(
    "chacune reste dans son coin",
    overlay.children[0].classList.contains("blue") && overlay.children[1].classList.contains("green"),
    overlay.children.map((c) => c.className)
  );

  flushTimers();
  check("elles disparaissent ensemble", overlay.children.length === 0, overlay.children.length);

  // une réaction malformée est ignorée
  api.showReaction({});
  api.showReaction(null);
  check("une réaction vide est ignorée", overlay.children.length === 0, overlay.children.length);
}

/* ------------------------------------------------------------ bruitage */

section("Bruitage du jeu");

{
  const bruit = globalThis.window.LudoSound;

  check("le module de son est chargé", Boolean(bruit), typeof bruit);
  check("le contexte audio est prêt", bruit.isSupported() === true);

  function jouer(etat) {
    sonsJoues.length = 0;
    api.renderState(etat);
    return sonsJoues.slice();
  }

  // premier état : rien à sonner
  const base = syntheticState({ log: [] });
  check("aucun son sans événement", jouer(base).length === 0, jouer(base).length);

  // le dé roule : c'est le dé qui s'arrête, pas un roulement (celui-ci est joué
  // au clic, pour la réactivité)
  const de = jouer(syntheticState({ log: [{ type: "rolled", color: "red", dice: 6 }] }));
  check("le dé qui s'arrête sonne", de.length > 0, de.length);

  const deplacement = jouer(syntheticState({ log: [{ type: "moved", color: "red", token: 1 }] }));
  check(
    "un déplacement joue le son d'avancée",
    deplacement.some((s) => s.genre === "note" && s.frequence === 700),
    deplacement
  );

  const capture = jouer(
    syntheticState({ log: [{ type: "captured", color: "red", victim: "blue" }] })
  );
  check(
    "une capture joue un son descendant",
    capture.some((s) => s.genre === "note" && s.frequence === 620 && s.rampe === 150),
    capture
  );

  const arrivee = jouer(syntheticState({ log: [{ type: "arrived", color: "red" }] }));
  check("une arrivée joue un son montant", arrivee.length >= 1, arrivee);

  const victoire = jouer(syntheticState({ log: [{ type: "won", color: "red" }] }));
  check(
    "la victoire joue une fanfare",
    victoire.filter((s) => s.genre === "note").length >= 5,
    victoire.length
  );

  // le même état ne doit pas sonner deux fois
  const etat = syntheticState({ log: [{ type: "moved", color: "red", token: 2 }] });
  jouer(etat);
  const rejoue = jouer(etat);
  check("le même état ne resonne pas", rejoue.length === 0, rejoue.length);

  // un nouvel événement s'ajoute au journal existant
  const suite = jouer(
    syntheticState({
      log: [
        { type: "moved", color: "red", token: 2 },
        { type: "captured", color: "red", victim: "blue" }
      ]
    })
  );
  check(
    "seul le nouvel événement sonne",
    suite.some((s) => s.frequence === 620) && !suite.some((s) => s.frequence === 700),
    suite
  );

  // coupé, plus rien
  bruit.setMuted(true);
  const coupe = jouer(syntheticState({ log: [{ type: "won", color: "red" }] }));
  check("coupé, aucun son ne sort", coupe.length === 0, coupe.length);
  bruit.setMuted(false);

  const tourPerdu = jouer(syntheticState({ log: [{ type: "stuck", color: "red" }] }));
  check("un tour perdu sonne", tourPerdu.length > 0, tourPerdu.length);

  // C'est à moi de jouer : un repère, une seule fois par tour.
  api.setSeat(0, geo.players[0]);

  // il faut un vrai changement de tour : les états précédents étaient déjà au
  // mien, et le repère ne doit pas se répéter
  jouer(syntheticState({ status: "playing", turn_color: geo.players[1] }));

  const monTour = jouer(syntheticState({ status: "playing", turn_color: geo.players[0] }));
  check(
    "mon tour est annoncé par un repère sonore",
    monTour.some((s) => s.frequence === 880),
    monTour
  );

  const memeTour = jouer(syntheticState({ status: "playing", turn_color: geo.players[0] }));
  check("le repère ne se répète pas à chaque état", memeTour.length === 0, memeTour.length);

  const autreTour = jouer(syntheticState({ status: "playing", turn_color: geo.players[1] }));
  check("le tour d'un autre ne sonne pas chez moi", autreTour.length === 0, autreTour.length);

  const retour = jouer(syntheticState({ status: "playing", turn_color: geo.players[0] }));
  check(
    "mon tour suivant resonne",
    retour.some((s) => s.frequence === 880),
    retour
  );
}

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
