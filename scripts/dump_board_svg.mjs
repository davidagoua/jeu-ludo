/*
 * Produit une image du plateau tel que le client le dessine réellement.
 *
 * Le script charge `app.js` avec un DOM factice, appelle `buildBoard()` puis
 * `renderState()` avec un état de partie, et sérialise l'arbre SVG obtenu. On
 * obtient donc exactement le dessin du navigateur, sans navigateur.
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' 2>/dev/null | tail -1 > /tmp/geometry.json
 *   node scripts/dump_board_svg.mjs /tmp/geometry.json /tmp/board.svg
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const geometryPath = process.argv[2] || "/tmp/geometry.json";
const outPath = process.argv[3] || "/tmp/board.svg";

/* ------------------------------------------------------------- DOM factice */

// index des éléments portant un `id`, pour reproduire la recherche du navigateur
const byId = new Map();

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
      // on enregistre les identifiants pour que `querySelector("#tokens")`
      // retrouve un élément *imbriqué* dans le plateau, comme le ferait le
      // navigateur (sinon les pions seraient dessinés hors du SVG).
      if (k === "id") byId.set(v, this);
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
    set innerHTML(_v) {
      this.children = [];
    },
    get innerHTML() {
      return "";
    }
  };
  return el;
}

const elements = new Map();
const elementFor = (selector) => {
  if (!elements.has(selector)) elements.set(selector, makeElement("div"));
  return elements.get(selector);
};

globalThis.window = globalThis;
globalThis.document = {
  readyState: "complete",
  querySelector: (selector) => {
    if (selector === "[data-page]") return null;
    // un `#id` peut désigner un élément imbriqué (le calque des pions)
    if (selector.startsWith("#")) {
      const found = byId.get(selector.slice(1));
      if (found) return found;
    }
    return elementFor(selector);
  },
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  addEventListener() {}
};

(0, eval)(readFileSync(join(here, "..", "priv/static/assets/js/app.js"), "utf8"));

const api = globalThis.LudoClient.__test;
const geo = JSON.parse(readFileSync(geometryPath, "utf8"));

/* --------------------------------------------------------------- sérialisation */

function escape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function serialize(el) {
  const attrs = [];

  for (const key in el.attributes) {
    if (key === "class") continue;
    attrs.push(`${key}="${escape(el.attributes[key])}"`);
  }

  const cls = el.className;
  if (cls) attrs.push(`class="${escape(cls)}"`);

  const style = Object.entries(el.style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
    .join(";");
  if (style) attrs.push(`style="${escape(style)}"`);

  const head = `<${el.tagName}${attrs.length ? " " + attrs.join(" ") : ""}`;
  if (!el.children.length) return head + "/>";

  return head + ">" + el.children.map(serialize).join("") + `</${el.tagName}>`;
}

/* ------------------------------------------------------------------- dessin */

api.setGeometry(geo);
api.setSeat(0, geo.players[0]);
api.buildBoard();

// état de partie : les pions sont dispersés pour que l'image soit parlante
const players = geo.players.map((color, seat) => ({
  seat,
  name: "Joueur " + (seat + 1),
  color,
  kind: seat === 0 ? "human" : "bot",
  connected: true,
  tokens:
    seat === 0
      ? [0, 12, 30, "base"]
      : seat === 1
        ? [3, geo.last_ring_position, "base", "base"]
        : seat === 2
          ? ["base", "base", "base", "base"]
          : [8, 22, 44, geo.finish],
  finished: seat === 3 ? 1 : 0
}));

api.renderState({
  code: "APERCU",
  mode: "p4",
  mode_label: "4 joueurs",
  seats: 4,
  status: "playing",
  winner: null,
  turn: 0,
  turn_color: geo.players[0],
  turn_name: "Joueur 1",
  turn_is_bot: false,
  dice: 5,
  six_streak: 0,
  version: 1,
  players,
  legal_moves: [0, 1],
  log: []
});

const board = elementFor("#board");

// CSS minimal, repris du client, pour que l'image soit fidèle
const css = `
  .cell { fill: #d9e2ec; stroke: #9fb0c4; stroke-width: 0.02; }
  .cell.safe { fill: #eef4fa; }
  .cell.start { stroke: #0d1117; stroke-width: 0.05; }
  .base { stroke: #0d1117; stroke-width: 0.03; }
  .base-inner { fill: #ffffff; opacity: 0.14; }
  .base-slot { fill: #00000022; stroke: #ffffff44; stroke-width: 0.02; }
  .center-tri { stroke: #0d1117; stroke-width: 0.02; }
  .token { stroke: #0b0f14; stroke-width: 0.05; }
  .token-ring { fill: none; stroke: #ffffff; stroke-width: 0.05; }
  .base-turn { stroke: #ffffff; stroke-width: 0.3; }
`;

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geo.grid} ${geo.grid}" ` +
  `width="640" height="640"><style>${css}</style>` +
  serialize(board).replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "") +
  `</svg>`;

writeFileSync(outPath, svg);
console.log("écrit " + outPath + " (" + svg.length + " octets)");
console.log("cases de départ : " + geo.players.map((c) => c + "=" + geo.ring[geo.starts[c]]).join(" "));
console.log("zones illuminées : " + elementFor("#board") ? "1 (Joueur 1)" : "?");
