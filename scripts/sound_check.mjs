/**
 * Vérifications du bruitage, sans navigateur ni haut-parleur.
 *
 * On installe un contexte audio factice qui compte les nœuds créés : c'est la
 * seule façon de vérifier qu'un son produit bien quelque chose, et qu'un son
 * coupé ne produit rien.
 *
 * Usage : node scripts/sound_check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const racine = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(racine, "priv/static/assets/js/sound.js"), "utf8");

let total = 0;
let echecs = 0;
let section = "";

function titre(nom) {
  section = nom;
  console.log("\n== " + nom + " ==");
}

function check(nom, condition, detail) {
  total++;
  if (condition) {
    console.log("  OK   " + nom);
  } else {
    echecs++;
    console.log("  FAIL " + nom + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
}

/** Contexte audio factice : compte les nœuds et retient les paramètres. */
function fauxContexte() {
  const compte = { oscillateurs: 0, bruits: 0, gains: 0, filtres: 0 };
  const journal = [];

  class Param {
    constructor() {
      this.valeurs = [];
    }
    setValueAtTime(v) {
      this.valeurs.push(v);
      return this;
    }
    exponentialRampToValueAtTime(v) {
      this.valeurs.push(v);
      return this;
    }
  }

  class Noeud {
    constructor(type) {
      this.type = type;
      this.frequency = new Param();
      this.gain = new Param();
      this.Q = new Param();
    }
    connect(destination) {
      return destination;
    }
    start() {
      journal.push(this.type);
    }
    stop() {}
  }

  const context = {
    currentTime: 0,
    sampleRate: 44100,
    state: "running",
    destination: {},
    repris: 0,
    createOscillator() {
      compte.oscillateurs++;
      return new Noeud("oscillateur");
    },
    createBufferSource() {
      compte.bruits++;
      return new Noeud("bruit");
    },
    createGain() {
      compte.gains++;
      return new Noeud("gain");
    },
    createBiquadFilter() {
      compte.filtres++;
      return new Noeud("filtre");
    },
    createBuffer(_canaux, frames) {
      return { getChannelData: () => new Float32Array(frames) };
    },
    resume() {
      this.repris++;
      this.state = "running";
    }
  };

  return { context, compte, journal };
}

/** Charge le module dans un bac à sable avec le contexte fourni. */
function charger({ audio = true, stockage = true, memoire = new Map() } = {}) {
  const { context, compte, journal } = fauxContexte();

  const windowFactice = {
    setTimeout: (fn) => {
      fn();
      return 0;
    }
  };

  if (audio) windowFactice.AudioContext = function () {
    return context;
  };

  if (stockage) {
    windowFactice.localStorage = {
      getItem: (cle) => (memoire.has(cle) ? memoire.get(cle) : null),
      setItem: (cle, valeur) => memoire.set(cle, String(valeur))
    };
  }

  const bac = vm.createContext({ window: windowFactice, Math, Object, Float32Array });
  vm.runInContext(source, bac);

  return { son: windowFactice.LudoSound, compte, journal, memoire, context };
}

/* ------------------------------------------------------------------ module */

titre("Module de bruitage");

{
  const { son } = charger();
  check("le module s'installe sur window", Boolean(son));
  check("le navigateur est reconnu", son.isSupported() === true);
  check("huit sons sont proposés", son.names.length === 8, son.names.length);
  check(
    "les sons attendus sont là",
    ["roll", "settle", "move", "capture", "arrive", "win", "stuck", "turn"].every((n) =>
      son.names.includes(n)
    ),
    son.names
  );
}

/* ------------------------------------------------------- production de son */

titre("Chaque son produit bien de l'audio");

for (const nom of ["roll", "settle", "move", "capture", "arrive", "win", "stuck", "turn"]) {
  const { son, compte } = charger();
  const joue = son.play(nom);

  const noeuds = compte.oscillateurs + compte.bruits;
  check(nom + " : joué et audible (" + noeuds + " sources)", joue === true && noeuds > 0, {
    joue,
    noeuds
  });
}

{
  const { son, compte } = charger();
  son.play("win");
  // une fanfare se distingue d'un simple clic
  check(
    "la victoire est plus riche que les autres sons",
    compte.oscillateurs >= 6,
    compte.oscillateurs
  );
}

{
  const { son } = charger();
  check("un son inconnu est ignoré sans erreur", son.play("inexistant") === false);
  check("un nom vide est ignoré", son.play("") === false);
  check("un nom absent est ignoré", son.play() === false);
}

{
  // le roulement du dé est fait de bruit filtré, pas de notes
  const { son, compte } = charger();
  son.play("roll");
  check("le dé roule avec du bruit filtré", compte.bruits >= 4, compte.bruits);
  check("le bruit est filtré", compte.filtres >= 4, compte.filtres);
}

/* ------------------------------------------------------------ sourdine */

titre("Sourdine");

{
  const { son, compte, memoire } = charger();

  check("le son est actif au départ", son.isMuted() === false);
  check("on peut couper", son.setMuted(true) === true);
  check("coupé, plus aucun nœud n'est créé", son.play("roll") === false && compte.oscillateurs === 0);
  check("le réglage est conservé", memoire.get("ludo.muted") === "1");

  check("on peut réactiver", son.toggleMuted() === false);
  check("réactivé, le son repart", son.play("roll") === true);
  check("le réglage est conservé aussi", memoire.get("ludo.muted") === "0");
}

{
  // Le réglage doit survivre à un rechargement : le même stockage, un module
  // rechargé de zéro (comme au chargement de la page suivante).
  const memoire = new Map();
  const stockage = {
    getItem: (cle) => (memoire.has(cle) ? memoire.get(cle) : null),
    setItem: (cle, valeur) => memoire.set(cle, String(valeur))
  };

  const { son: premiere } = charger({ stockage: true, memoire });
  premiere.setMuted(true);

  const { son: seconde } = charger({ stockage: true, memoire });
  check("la sourdine est relue au chargement suivant", seconde.isMuted() === true);

  seconde.setMuted(false);
  const { son: troisieme } = charger({ stockage: true, memoire });
  check("le retour du son est relu aussi", troisieme.isMuted() === false);
}

/* --------------------------------------------------- navigateur sans audio */

titre("Navigateur sans audio");

{
  const { son } = charger({ audio: false });

  check("le manque d'audio est signalé", son.isSupported() === false);
  check("jouer ne plante pas", son.play("roll") === false);
  check("déverrouiller ne plante pas", son.unlock() === false);
}

{
  // ni localStorage (navigation privée)
  const { son } = charger({ stockage: false });

  check("sans stockage, couper fonctionne quand même", son.setMuted(true) === true);
  check("sans stockage, le son reste coupé", son.play("roll") === false);
}

/* -------------------------------------------------- événements -> sons */

titre("Événements du serveur");

{
  const { son } = charger();

  const attendu = {
    started: "turn",
    rolled: "settle",
    moved: "move",
    captured: "capture",
    arrived: "arrive",
    won: "win",
    stuck: "stuck"
  };

  for (const [evenement, nom] of Object.entries(attendu)) {
    check(evenement + " -> " + nom, son.soundFor(evenement) === nom, son.soundFor(evenement));
  }

  check("le troisième six sonne comme un tour perdu", son.soundFor("triple_six") === "stuck");
  check("un événement inconnu ne sonne pas", son.soundFor("autre") === null);
  check("chaque événement connu a un son", Object.keys(attendu).every((e) => son.soundFor(e)));
}

{
  const { son, compte } = charger();
  const joues = son.playEvents(["moved", "captured"]);

  check("deux événements donnent deux sons", joues.length === 2, joues);
  check(
    "un déplacement qui capture sonne double",
    compte.oscillateurs + compte.bruits >= 4,
    compte.oscillateurs + compte.bruits
  );
}

{
  const { son } = charger();

  check("les événements sans son sont ignorés", son.playEvents(["inconnu", "autre"]).length === 0);
  check("la liste vide ne produit rien", son.playEvents([]).length === 0);
  check(
    "au plus trois sons d'affilée",
    son.playEvents(["moved", "captured", "arrived", "won", "stuck"]).length === 3
  );
}

{
  const { son } = charger();
  son.setMuted(true);
  check("coupé, aucun événement ne sonne", son.playEvents(["moved", "won"]).length === 0);
}

/* --------------------------------------------------- journal : nouveautés */

titre("Repérer les événements nouveaux");

{
  const { son } = charger();
  const a = { type: "rolled", color: "red", dice: 6 };
  const b = { type: "moved", color: "red", token: 1 };
  const c = { type: "captured", color: "red", victim: "blue" };
  const d = { type: "won", color: "red" };

  const cas = [
    ["journal vide au départ", [], [a, b], [a, b]],
    ["rien de nouveau", [a, b], [a, b], []],
    ["une entrée de plus", [a, b], [a, b, c], [c]],
    ["les vieilles sortent", [a, b, c], [b, c, d], [d]],
    ["tout a été remplacé", [a, b, c], [d], [d]],
    ["premier état", null, [a], [a]]
  ];

  for (const [nom, avant, apres, attendu] of cas) {
    const obtenu = son.newLogEntries(avant, apres);
    check(
      nom,
      JSON.stringify(obtenu) === JSON.stringify(attendu),
      obtenu
    );
  }
}

{
  // le journal du serveur est borné : à force, tout l'ancien a disparu
  const { son } = charger();
  const ancien = Array.from({ length: 5 }, (_, i) => ({ type: "moved", token: i }));
  const nouveau = Array.from({ length: 5 }, (_, i) => ({ type: "moved", token: i + 5 }));

  const obtenu = son.newLogEntries(ancien, nouveau);
  check(
    "journal entièrement renouvelé : on ne joue pas les anciens",
    obtenu.length === 1 && obtenu[0].token === 9,
    obtenu
  );
}

{
  const { son } = charger();
  check("un journal null ne plante pas", son.newLogEntries(null, null).length === 0);
  check("un journal vide ne plante pas", son.newLogEntries([], []).length === 0);
}

/* ------------------------------------------------------------------ résultat */

console.log("\n== Résultat ==");
if (echecs === 0) {
  console.log("Tous les tests passent.");
} else {
  console.log("ÉCHECS : " + echecs);
}
console.log(total + " vérifications");

process.exit(echecs === 0 ? 0 : 1);
