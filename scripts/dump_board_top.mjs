/*
 * Exporte la scène 3D en vue de dessus, pour pouvoir la regarder sans navigateur.
 *
 * La caméra est orthographique et regarde le plateau d'aplomb : la projection
 * monde -> écran est donc une simple mise à l'échelle, qu'on peut reproduire
 * exactement avec n'importe quel outil de dessin. C'est ce que fait
 * `.tooling/top_view.py` avec ce fichier.
 *
 *   mix run -e 'IO.puts(Jason.encode!(Ludo.Board.geometry()))' 2>/dev/null | tail -1 > /tmp/geometry.json
 *   node scripts/dump_board_top.mjs /tmp/geometry.json /tmp/board_top.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const geometryPath = process.argv[2] || "/tmp/geometry.json";
const outPath = process.argv[3] || "/tmp/board_top.json";

globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, devicePixelRatio: 1 };

const THREE = await import(
  join(here, "..", "priv/static/assets/js/vendor/three.module.min.js")
);
const board = await import(join(here, "..", "priv/static/assets/js/board3d.js"));

const geo = JSON.parse(readFileSync(geometryPath, "utf8"));
const { root } = board.buildScene(geo);

// un état parlant : des pions sortis, une capture, une arrivée
const players = geo.players.map((color, seat) => ({
  color,
  seat,
  tokens:
    seat === 0
      ? [0, 12, 30, "base"]
      : seat === 1
        ? [3, geo.last_ring_position, "base", "base"]
        : seat === 2
          ? [8, 22, 44, geo.finish]
          : ["base", "base", "base", "base"]
}));

board.update(
  {
    status: "playing",
    turn_color: geo.players[0],
    dice: 5,
    legal_moves: [1, 2],
    players
  },
  geo.players[0]
);
board.settle();

const items = [];

root.traverse((o) => {
  const kind = o.userData && o.userData.kind;
  if (!kind) return;

  if (kind === "center") {
    const attr = o.geometry.getAttribute("position");
    const points = [];
    for (let i = 0; i < attr.count; i++) {
      points.push([attr.getX(i), attr.getZ(i)]);
    }

    // La normale est exportée pour que l'aperçu puisse reproduire le back-face
    // culling : une forme plate tournée vers le bas est invisible à l'écran.
    const normale = o.geometry.getAttribute("normal");
    items.push({
      kind,
      color: geo.colors[o.userData.color],
      points,
      normalY: normale ? normale.getY(0) : null
    });
    return;
  }

  if (kind === "token") {
    items.push({
      kind,
      color: geo.colors[o.userData.color],
      index: o.userData.index,
      x: o.position.x,
      z: o.position.z,
      scale: o.scale.x,
      highlight: Boolean(o.userData.ring && o.userData.ring.visible)
    });
    return;
  }

  if (kind === "dice") {
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    items.push({ kind, x: p.x, z: p.z });
    return;
  }

  const material = o.material || (o.children[0] && o.children[0].material);
  const color = material && material.color ? "#" + material.color.getHexString() : null;

  // On prend la couleur réellement appliquée au matériau : pour une case c'est
  // sa teinte, pour une étoile le blanc ou le gris, etc.
  items.push({ kind, color, x: o.position.x, z: o.position.z });
});

const diceNode = items.find((i) => i.kind === "dice");

writeFileSync(
  outPath,
  JSON.stringify(
    {
      board: board.BOARD,
      view: board.viewLimits(),
      centerZ: board.viewCenterZ(),
      dice: {
        x: diceNode ? diceNode.x : 0,
        z: diceNode ? diceNode.z : 0,
        value: board.diceValue()
      },
      items
    },
    null,
    1
  )
);

console.log(
  "écrit " + outPath + " : " + items.length + " éléments, dé sur " + board.diceValue()
);
