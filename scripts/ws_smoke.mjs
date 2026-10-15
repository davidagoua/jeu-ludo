/*
 * Test de bout en bout du serveur Ludo, sans navigateur.
 *
 * Il parle le protocole des canaux Phoenix par WebSocket (le même que
 * `phoenix.min.js`) et vérifie un parcours complet :
 *
 *   - salon d'accueil : réception de la liste et des modes
 *   - création d'une partie à 2
 *   - connexion de deux joueurs (sièges rouge puis bleu)
 *   - coup illégal refusé, puis partie jouée jusqu'à un vainqueur
 *   - diffusion de l'état aux deux clients
 *
 * Usage : node scripts/ws_smoke.mjs [url]
 *   url par défaut : http://localhost:4000
 *
 * Node 22+ fournit `WebSocket` en global ; aucune dépendance n'est requise.
 */

const base = process.argv[2] || "http://localhost:4000";
const wsUrl = base.replace(/^http/, "ws") + "/socket/websocket?vsn=2.0.0";

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ client */

class ChannelClient {
  constructor(topic, params) {
    this.topic = topic;
    this.params = params;
    this.ref = 0;
    this.joinRef = null;
    this.pending = new Map();
    this.handlers = new Map();
    this.messages = [];
  }

  async connect() {
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("connexion WebSocket refusée")), {
        once: true
      });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
    return this;
  }

  onMessage([joinRef, ref, topic, event, payload]) {
    if (topic !== this.topic) return;

    if (ref !== null && this.pending.has(ref)) {
      const { resolve, reject } = this.pending.get(ref);
      this.pending.delete(ref);
      if (event === "phx_reply") {
        if (payload.status === "ok") resolve(payload.response);
        else reject(Object.assign(new Error("erreur canal"), { response: payload.response }));
      }
      return;
    }

    this.messages.push({ event, payload, joinRef });
    const list = this.handlers.get(event) || [];
    for (const handler of list) handler(payload);
    void joinRef;
  }

  send(event, payload) {
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify([this.joinRef, ref, this.topic, event, payload]));
    return ref;
  }

  push(event, payload, timeout = 5000) {
    const ref = this.send(event, payload);
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(ref)) {
          this.pending.delete(ref);
          reject(new Error("délai dépassé pour " + event));
        }
      }, timeout);
    });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  /**
   * Attend un message d'un événement donné.
   *
   * On regarde d'abord les messages déjà arrivés : le serveur pousse « games »
   * juste après la connexion, donc le message peut précéder l'appel.
   */
  next(event, timeout = 5000) {
    const index = this.messages.findIndex((m) => m.event === event);
    if (index !== -1) {
      const [already] = this.messages.splice(index, 1);
      return Promise.resolve(already.payload);
    }

    return new Promise((resolve, reject) => {
      const handler = (payload) => {
        clearTimeout(timer);
        const list = this.handlers.get(event) || [];
        this.handlers.set(
          event,
          list.filter((h) => h !== handler)
        );
        resolve(payload);
      };
      this.on(event, handler);
      const timer = setTimeout(() => reject(new Error("aucun « " + event + " » reçu")), timeout);
    });
  }

  join(timeout = 5000) {
    const ref = String(++this.ref);
    this.joinRef = ref;
    this.ws.send(JSON.stringify([ref, ref, this.topic, "phx_join", this.params]));
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(ref)) {
          this.pending.delete(ref);
          reject(new Error("délai dépassé à la connexion de " + this.topic));
        }
      }, timeout);
    });
  }

  close() {
    if (this.ws && this.ws.readyState <= 1) this.ws.close();
  }
}

const playerId = (suffix) => "smoke-test-player-" + suffix + "-" + "x".repeat(12);

/* -------------------------------------------------------------------- test */

async function main() {
  console.log("Cible : " + wsUrl);

  // ---------------------------------------------------------- salon d'accueil
  section("Salon d'accueil");
  const lobby = new ChannelClient("lobby", {});
  await lobby.connect();
  const lobbyJoin = await lobby.join();
  void lobbyJoin;

  const games = await lobby.next("games");
  check("les modes de jeu sont annoncés", games.modes.length === 4, games.modes.length);
  check(
    "les modes sont dans l'ordre attendu",
    JSON.stringify(games.modes.map((m) => m.key)) === JSON.stringify(["vs_ai", "p2", "p3", "p4"]),
    games.modes.map((m) => m.key)
  );
  check(
    "chaque mode annonce ses sièges",
    JSON.stringify(games.modes.map((m) => m.seats)) === JSON.stringify([4, 2, 3, 4])
  );

  // ---------------------------------------------------------------- création
  section("Création d'une partie à 2");
  const created = await lobby.push("create", {
    name: "Alice",
    mode: "p2",
    player_id: playerId("alice")
  });
  const code = created.code;
  check("un code de salon est renvoyé", /^[A-Z2-9]{4}$/.test(code), code);

  const badMode = await lobby
    .push("create", { name: "Triche", mode: "red", player_id: playerId("triche") })
    .then(() => null)
    .catch((error) => error.response);
  check("un mode invalide est refusé", badMode && badMode.reason === "unknown_mode", badMode);

  // ------------------------------------------------------- joueurs et sièges
  section("Connexion des joueurs");
  const alice = new ChannelClient("game:" + code, {
    name: "Alice",
    player_id: playerId("alice")
  });
  await alice.connect();
  const aliceJoin = await alice.join();

  check("l'hôte récupère le siège rouge", aliceJoin.seat.color === "red", aliceJoin.seat);
  check("la géométrie du plateau est fournie", aliceJoin.geometry.ring.length === 56);
  check("l'état initial attend des joueurs", aliceJoin.state.status === "waiting");

  const bob = new ChannelClient("game:" + code, { name: "Bob", player_id: playerId("bob") });
  await bob.connect();
  const bobJoin = await bob.join();

  // l'ordre des couleurs suit les sièges : rouge puis bleu
  check("le second joueur prend le siège bleu", bobJoin.seat.color === "blue", bobJoin.seat);
  check("la partie démarre automatiquement", bobJoin.state.status === "playing", bobJoin.state.status);
  check("deux joueurs sont installés", bobJoin.state.players.length === 2);

  const badJoin = await new ChannelClient("game:" + code, {
    name: "Intrus",
    player_id: playerId("intrus")
  })
    .connect()
    .then((c) => c.join().then(() => null).catch((e) => e.response));

  check(
    "un troisième joueur est refusé",
    badJoin !== null && ["full", "already_started"].includes(badJoin.reason),
    badJoin
  );

  // --------------------------------------------------- refus d'un coup illégal
  section("Refus des coups illégaux");
  const badMove = await bob
    .push("move", { token: 0 })
    .then(() => null)
    .catch((error) => error.response);
  check("déplacer sans lancer le dé est refusé", badMove !== null, badMove);

  const notYourTurn = await bob
    .push("roll", {})
    .then(() => null)
    .catch((error) => error.response);
  check("jouer hors de son tour est refusé", notYourTurn.reason === "not_your_turn", notYourTurn);

  // ----------------------------------------------------- diffusion de l'état
  section("Diffusion temps réel");
  // Un simple `state` est une lecture : il faut une action qui change l'état
  // pour déclencher une diffusion.
  const bobSees = bob.next("state");
  const rollReply = await alice.push("roll", {});
  const pushed = await bobSees;
  check("Bob reçoit les mises à jour d'Alice", pushed.code === code);
  check("l'état diffusé ne contient aucun identifiant", !JSON.stringify(pushed).includes("smoke-test-player"));
  check("la version diffusée correspond à la réponse", pushed.version === rollReply.state.version, {
    pushed: pushed.version,
    reply: rollReply.state.version
  });

  // ------------------------------------------------------ partie jusqu'au bout
  section("Partie jouée jusqu'à un vainqueur");
  let state = pushed;

  // on associe chaque client à SON siège, sans présumer des couleurs
  const clients = {};
  clients[aliceJoin.seat.color] = alice;
  clients[bobJoin.seat.color] = bob;
  let turns = 0;

  while (state.status === "playing" && turns < 400) {
    turns++;
    const color = state.turn_color;
    const client = clients[color];
    if (!client) throw new Error("aucun client pour la couleur " + color);

    if (state.dice === null) {
      const reply = await client.push("roll", {});
      state = reply.state;
    } else if (state.legal_moves.length > 0) {
      const reply = await client.push("move", { token: state.legal_moves[0] });
      state = reply.state;
    } else {
      await delay(20);
      state = await refresh(client, state);
    }
  }

  check("la partie s'est terminée", state.status === "finished", state.status);
  check("un vainqueur est désigné", Object.keys(clients).includes(state.winner), state.winner);
  const winner = state.players.find((p) => p.color === state.winner);
  check("le vainqueur a rentré ses quatre pions", winner && winner.finished === 4, winner && winner.finished);
  check("la partie a duré un nombre plausible de tours", turns > 5 && turns < 400, turns);

  // -------------------------------------------------------------- reconnexion
  section("Reconnexion");
  const aliceAgain = new ChannelClient("game:" + code, {
    name: "Alice",
    player_id: playerId("alice")
  });
  await aliceAgain.connect();
  const rejoin = await aliceAgain.join();
  check("le joueur retrouve son siège", rejoin.seat.color === "red", rejoin.seat);
  check("le siège est signalé comme repris", rejoin.seat.how === "rejoined", rejoin.seat.how);

  alice.close();
  bob.close();
  aliceAgain.close();

  // ---------------------------------------------------------------- mode IA
  section("Mode solo contre l'IA");
  const soloCode = (
    await lobby.push("create", { name: "Solo", mode: "vs_ai", player_id: playerId("solo") })
  ).code;

  const solo = new ChannelClient("game:" + soloCode, {
    name: "Solo",
    player_id: playerId("solo")
  });
  await solo.connect();
  const soloJoin = await solo.join();

  check("la partie solo démarre aussitôt", soloJoin.state.status === "playing", soloJoin.state.status);
  check(
    "trois IA sont installées",
    soloJoin.state.players.filter((p) => p.kind === "bot").length === 3
  );
  check("c'est au joueur de commencer", soloJoin.state.turn_is_bot === false);

  // Le joueur joue son tour, puis on ne touche plus à rien : le serveur doit
  // continuer seul, ce qui valide les minuteurs du GameServer dans l'image.
  let soloState = soloJoin.state;
  let guard = 0;

  while (!soloState.turn_is_bot && soloState.status === "playing" && guard++ < 60) {
    if (soloState.dice === null) {
      soloState = (await solo.push("roll", {})).state;
    } else if (soloState.legal_moves.length > 0) {
      soloState = (await solo.push("move", { token: soloState.legal_moves[0] })).state;
    } else {
      await delay(40);
      soloState = (await solo.push("state", {})).state;
    }
  }

  check("la main finit par passer à une IA", soloState.turn_is_bot === true, soloState.turn_color);

  const beforeBot = soloState.version;

  const botPlayed = await waitFor(async () => {
    const current = (await solo.push("state", {})).state;
    return current.version > beforeBot ? current : null;
  }, 8000);

  check("une IA a joué toute seule côté serveur", botPlayed !== null);
  check(
    "le journal mentionne les coups des IA",
    botPlayed !== null && Array.isArray(botPlayed.log) && botPlayed.log.length > 0
  );

  solo.close();
  lobby.close();
}

/** Répète `attempt` jusqu'à obtenir une valeur non nulle, ou abandonne. */
async function waitFor(attempt, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value) return value;
    await delay(80);
  }
  return null;
}

async function refresh(client, fallback) {
  try {
    const reply = await client.push("state", {});
    return reply.state;
  } catch (_) {
    return fallback;
  }
}

main()
  .then(() => {
    console.log(
      "\n" + (failures.length === 0 ? "Tous les tests passent." : "ÉCHECS : " + failures.join(", "))
    );
    console.log(checks + " vérifications");
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("\nErreur fatale :", error.message);
    process.exit(1);
  });
