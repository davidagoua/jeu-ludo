/*
 * Client Ludo : connexion WebSocket, salon d'accueil et plateau de jeu.
 *
 * Aucune dépendance de build : on utilise le client Phoenix officiel
 * (`phoenix.min.js`, copié depuis la dépendance Hex) et du SVG généré à partir
 * de la géométrie envoyée par le serveur (`Ludo.Board.geometry/0`), qui reste
 * ainsi la seule source de vérité pour la forme du plateau.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- utilitaires

  const $ = (sel, root = document) => root.querySelector(sel);

  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "p-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getPlayerId() {
    let id = null;
    try {
      id = window.localStorage.getItem("ludo.playerId");
    } catch (_) {
      /* navigation privée : on retombe sur une session en mémoire */
    }
    if (!id) {
      id = newId();
      try {
        window.localStorage.setItem("ludo.playerId", id);
      } catch (_) {}
    }
    return id;
  }

  function getName() {
    try {
      return window.localStorage.getItem("ludo.name") || "";
    } catch (_) {
      return "";
    }
  }

  function setName(name) {
    try {
      window.localStorage.setItem("ludo.name", name);
    } catch (_) {}
  }

  let toastTimer = null;
  function toast(message, ok) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("ok", Boolean(ok));
    el.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 4500);
  }

  // ---------------------------------------------------------------- état local

  const playerId = getPlayerId();
  let socket = null;
  let lobby = null;
  let game = null;
  let geometry = null;
  let myColor = null;
  let mySeat = null;
  let lastState = null;
  let tokenEls = new Map();
  let lastDice = null;

  // ---------------------------------------------------------------- socket

  function connect() {
    if (socket) return socket;

    socket = new Phoenix.Socket("/socket", { params: {} });
    socket.onError(() => toast("Connexion perdue… nouvelle tentative en cours."));
    socket.connect();
    return socket;
  }

  function push(channel, event, payload, onOk) {
    channel
      .push(event, payload)
      .receive("ok", onOk)
      .receive("error", (reply) => toast((reply && reply.message) || "Action impossible."))
      .receive("timeout", () => toast("Le serveur ne répond pas."));
  }

  // ---------------------------------------------------------------- accueil

  function initLobby() {
    const pseudo = $("#pseudo");
    pseudo.value = getName();

    const codeInput = $("#code");

    connect();
    lobby = socket.channel("lobby", {});

    lobby.on("games", (payload) => {
      if (payload.games) renderGames(payload.games);
    });

    lobby
      .join()
      .receive("ok", () => {})
      .receive("error", () => toast("Le salon d'accueil est injoignable."));

    $("#create").addEventListener("click", () => {
      const name = pseudo.value.trim();
      if (!name) return toast("Choisissez d'abord un pseudo.");
      setName(name);

      const mode = ($('input[name="mode"]:checked') || {}).value || "vs_ai";
      push(lobby, "create", { name: name, mode: mode, player_id: playerId }, (reply) =>
        goToGame(reply.code)
      );
    });

    $("#join").addEventListener("click", () => {
      const name = pseudo.value.trim();
      if (!name) return toast("Choisissez d'abord un pseudo.");
      const code = codeInput.value.trim().toUpperCase();
      if (code.length !== 4) return toast("Un code de salon comporte 4 caractères.");
      setName(name);
      checkAndGo(code);
    });

    codeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("#join").click();
    });

    $("#quick-join").addEventListener("click", () => {
      const name = pseudo.value.trim();
      if (!name) return toast("Choisissez d'abord un pseudo.");
      setName(name);
      push(lobby, "quick_join", { player_id: playerId }, (reply) => goToGame(reply.code));
    });

    $("#games").addEventListener("click", (event) => {
      const button = event.target.closest(".join-game");
      if (!button) return;
      const name = pseudo.value.trim();
      if (!name) return toast("Choisissez d'abord un pseudo.");
      setName(name);
      checkAndGo(button.dataset.code);
    });
  }

  function checkAndGo(code) {
    push(lobby, "check", { code: code, player_id: playerId }, (reply) => goToGame(reply.code));
  }

  function goToGame(code) {
    window.location.href = "/partie/" + code;
  }

  function renderGames(games) {
    const list = $("#games");
    const empty = $("#games-empty");
    const count = $("#games-count");
    if (!list) return;

    count.textContent = games.length;
    empty.hidden = games.length > 0;
    list.innerHTML = "";

    for (const game of games) {
      const li = document.createElement("li");
      li.className = "game";
      li.dataset.code = game.code;

      li.innerHTML =
        '<span class="game-code"></span>' +
        '<span class="game-mode"></span>' +
        '<span class="game-players"></span>' +
        '<span class="game-host"></span>' +
        '<button class="secondary small join-game" type="button">Rejoindre</button>';

      $(".game-code", li).textContent = game.code;
      $(".game-mode", li).textContent = game.mode_label;
      $(".game-players", li).textContent = game.taken + "/" + game.seats + " joueurs";
      $(".game-host", li).textContent = "hôte : " + game.host;
      $(".join-game", li).dataset.code = game.code;

      list.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- plateau

  function initGame(code) {
    const modal = $("#ask-name");
    const form = $("#ask-name-form");

    if (getName()) {
      joinGame(code, getName());
    } else {
      modal.hidden = false;
      $("#ask-pseudo").focus();
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = $("#ask-pseudo").value.trim();
        if (!name) return toast("Choisissez un pseudo.");
        setName(name);
        modal.hidden = true;
        joinGame(code, name);
      });
    }

    $("#copy-link").addEventListener("click", () => {
      const url = window.location.origin + "/partie/" + code;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(
          () => toast("Lien copié : " + url, true),
          () => toast("Copie impossible. Lien du salon : " + url)
        );
      } else {
        toast("Lien du salon : " + url);
      }
    });
  }

  function joinGame(code, name) {
    connect();

    game = socket.channel("game:" + code, { name: name, player_id: playerId });

    game.on("state", (state) => {
      lastState = state;
      renderState(state);
    });

    game
      .join()
      .receive("ok", (payload) => {
        geometry = payload.geometry;
        mySeat = payload.seat.seat;
        myColor = payload.seat.color;
        lastState = payload.state;

        buildBoard();
        renderState(payload.state);

        if (payload.seat.how === "rejoined") {
          toast("Vous reprenez votre place.", true);
        }
      })
      .receive("error", (reply) => {
        const reason = (reply && reply.reason) || "error";
        let message = "Impossible de rejoindre ce salon.";
        if (reason === "full") message = "Cette partie est complète.";
        else if (reason === "already_started") message = "Cette partie a déjà commencé.";
        else if (reason === "not_found") message = "Cette partie n'existe plus.";
        toast(message);
        window.setTimeout(() => (window.location.href = "/"), 2500);
      })
      .receive("timeout", () => toast("Le serveur ne répond pas."));

    $("#roll").addEventListener("click", () => {
      push(game, "roll", {}, (reply) => {
        lastState = reply.state;
        renderState(reply.state);
      });
    });

    $("#fill-bots").addEventListener("click", () => {
      push(game, "fill_bots", {}, (reply) => {
        lastState = reply.state;
        renderState(reply.state);
      });
    });
  }

  // ---- construction du plateau (une seule fois)

  const FINISH_SPOT = { red: [6, 7], green: [7, 6], yellow: [8, 7], blue: [7, 8] };
  const BASE_AREA = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] };
  const CENTER = [7, 7];
  const NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    return el;
  }

  function starPath(x, y, r) {
    let d = "";
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? r : r / 2.4;
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      d += (i === 0 ? "M" : "L") + px.toFixed(3) + "," + py.toFixed(3);
    }
    return d + "Z";
  }

  function buildBoard() {
    const svg = $("#board");
    if (!svg || !geometry) return;
    svg.innerHTML = "";
    tokenEls = new Map();

    const size = geometry.grid;
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: size, height: size, fill: "#141c26" }));

    // bases
    for (const color in BASE_AREA) {
      const [bx, by] = BASE_AREA[color];
      svg.appendChild(
        svgEl("rect", {
          x: bx, y: by, width: 6, height: 6, rx: 0.3,
          fill: geometry.colors[color], class: "base"
        })
      );
      svg.appendChild(
        svgEl("rect", { x: bx + 1, y: by + 1, width: 4, height: 4, rx: 0.2, class: "base-inner" })
      );
      for (const [sx, sy] of geometry.bases[color]) {
        svg.appendChild(svgEl("circle", { cx: sx + 0.5, cy: sy + 0.5, r: 0.36, class: "base-slot" }));
      }
    }

    // anneau
    geometry.ring.forEach(([x, y], index) => {
      const safe = geometry.safe_indexes.indexOf(index) !== -1;
      svg.appendChild(svgEl("rect", { x: x, y: y, width: 1, height: 1, class: safe ? "cell safe" : "cell" }));
      if (safe) {
        svg.appendChild(svgEl("path", { d: starPath(x + 0.5, y + 0.5, 0.3), fill: "#8494a8" }));
      }
    });

    // colonnes d'arrivée
    for (const color in geometry.home_columns) {
      for (const [x, y] of geometry.home_columns[color]) {
        svg.appendChild(
          svgEl("rect", { x: x, y: y, width: 1, height: 1, fill: geometry.colors[color], class: "base" })
        );
      }
    }

    // centre : quatre triangles qui convergent
    const [cx, cy] = CENTER;
    const left = cx - 1;
    const right = cx + 2;
    const top = cy - 1;
    const bottom = cy + 2;
    const mid = cx + 0.5;
    const middle = cy + 0.5;

    const triangles = [
      { color: "red", points: [[left, top], [left, bottom], [mid, middle]] },
      { color: "green", points: [[left, top], [right, top], [mid, middle]] },
      { color: "yellow", points: [[right, top], [right, bottom], [mid, middle]] },
      { color: "blue", points: [[left, bottom], [right, bottom], [mid, middle]] }
    ];

    for (const tri of triangles) {
      svg.appendChild(
        svgEl("polygon", {
          points: tri.points.map((p) => p.join(",")).join(" "),
          fill: geometry.colors[tri.color],
          class: "center-tri"
        })
      );
    }

    // calque des pions
    svg.appendChild(svgEl("g", { id: "tokens" }));
  }

  // ---- position d'un pion, en unités du plateau

  /*
   * Version pure : la géométrie est passée en argument, ce qui permet de la
   * vérifier hors navigateur depuis scripts/geometry_check.mjs.
   */
  function tokenCellFor(geo, color, index, position) {
    if (position === "base") {
      const [x, y] = geo.bases[color][index];
      return [x + 0.5, y + 0.5];
    }

    if (position < geo.ring_size) {
      const idx = (geo.starts[color] + position) % geo.ring_size;
      const [x, y] = geo.ring[idx];
      return [x + 0.5, y + 0.5];
    }

    if (position < geo.finish) {
      const [x, y] = geo.home_columns[color][position - geo.ring_size];
      return [x + 0.5, y + 0.5];
    }

    const [fx, fy] = FINISH_SPOT[color];
    const offsets = [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]];
    const [ox, oy] = offsets[index] || [0, 0];
    return [fx + 0.5 + ox, fy + 0.5 + oy];
  }

  function tokenCell(color, index, position) {
    return tokenCellFor(geometry, color, index, position);
  }

  // ---- rendu

  function renderState(state) {
    if (!state || !geometry) return;
    renderPlayers(state);
    renderTurn(state);
    renderLog(state);
    renderBanner(state);
    renderTokens(state);
  }

  function renderPlayers(state) {
    const list = $("#players");
    if (!list) return;
    list.innerHTML = "";

    const sorted = state.players.slice().sort((a, b) => a.seat - b.seat);

    for (const player of sorted) {
      const li = document.createElement("li");
      li.className = "player";
      if (player.seat === state.turn && state.status === "playing") li.classList.add("active");
      if (!player.connected) li.classList.add("offline");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = geometry.colors[player.color];

      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.name + (player.color === myColor ? " (vous)" : "");

      const meta = document.createElement("span");
      meta.className = "player-meta";
      meta.textContent = player.finished + "/4";

      li.appendChild(swatch);
      li.appendChild(name);

      if (player.kind === "bot") {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "IA";
        li.appendChild(tag);
      }

      li.appendChild(meta);
      list.appendChild(li);
    }
  }

  function renderTurn(state) {
    const turn = $("#turn");
    const dice = $("#dice");
    const roll = $("#roll");
    const hint = $("#hint");
    const hostActions = $("#host-actions");

    if (state.status === "waiting") {
      turn.textContent = "En attente de joueurs…";
      roll.disabled = true;
      hint.textContent = "La partie démarre dès que tous les sièges sont pris.";
      hostActions.hidden = mySeat !== 0;
      return;
    }

    hostActions.hidden = true;

    if (state.status === "finished") {
      const winner = state.players.find((p) => p.color === state.winner);
      turn.textContent = "Partie terminée";
      roll.disabled = true;
      hint.textContent = winner ? winner.name + " remporte la partie." : "";
      dice.textContent = "–";
      return;
    }

    const mine = state.turn_color === myColor;
    turn.textContent =
      (mine ? "À vous de jouer" : "Au tour de " + state.turn_name) +
      (state.turn_is_bot ? " (IA)" : "");

    dice.textContent = state.dice === null ? "–" : String(state.dice);

    if (state.dice !== null && state.dice !== lastDice) {
      dice.classList.remove("rolling");
      void dice.offsetWidth;
      dice.classList.add("rolling");
    }
    lastDice = state.dice;

    roll.disabled = !(mine && state.dice === null);

    if (!mine) {
      hint.textContent = "";
    } else if (state.dice === null) {
      hint.textContent = "Lancez le dé.";
    } else if (state.legal_moves.length > 0) {
      hint.textContent = "Cliquez sur un pion en surbrillance pour le déplacer.";
    } else {
      hint.textContent = "Aucun coup possible avec ce dé.";
    }
  }

  function renderLog(state) {
    const log = $("#log");
    if (!log) return;
    log.innerHTML = "";

    for (const entry of state.log.slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = entry.text || "";
      if (entry.type === "captured" || entry.type === "won" || entry.type === "triple_six") {
        li.classList.add("strong");
      }
      log.appendChild(li);
    }
  }

  function renderBanner(state) {
    const banner = $("#banner");
    if (!banner) return;

    if (state.status === "waiting") {
      const free = state.seats - state.players.length;
      banner.hidden = false;
      banner.innerHTML = "";

      const strong = document.createElement("div");
      strong.textContent = "Salon ouvert";

      const small = document.createElement("small");
      small.textContent =
        free + " place" + (free > 1 ? "s" : "") + " libre" + (free > 1 ? "s" : "") +
        " — partagez le code " + state.code + ".";

      banner.appendChild(strong);
      banner.appendChild(small);
      return;
    }

    if (state.status === "finished") {
      const winner = state.players.find((p) => p.color === state.winner);
      banner.hidden = false;
      banner.innerHTML = "";

      const strong = document.createElement("div");
      strong.textContent = (winner ? winner.name : "?") + " gagne !";

      const small = document.createElement("small");
      small.textContent = "Créez une nouvelle partie depuis l'accueil pour rejouer.";

      banner.appendChild(strong);
      banner.appendChild(small);
      return;
    }

    banner.hidden = true;
  }

  function renderTokens(state) {
    const layer = $("#tokens");
    if (!layer) return;

    const playable = new Set(
      state.status === "playing" && state.turn_color === myColor ? state.legal_moves : []
    );

    // On regroupe par case pour écarter les pions superposés.
    const groups = new Map();

    for (const player of state.players) {
      player.tokens.forEach((position, index) => {
        const [x, y] = tokenCell(player.color, index, position);
        const key =
          position === "base" ? player.color + ":base:" + index : x.toFixed(2) + ":" + y.toFixed(2);

        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ color: player.color, index, x, y, position });
      });
    }

    const placed = [];
    for (const list of groups.values()) {
      if (list.length === 1) {
        placed.push(list[0]);
      } else {
        list.forEach((entry, i) => {
          const angle = (Math.PI * 2 * i) / list.length;
          placed.push({
            color: entry.color,
            index: entry.index,
            position: entry.position,
            x: entry.x + Math.cos(angle) * 0.17,
            y: entry.y + Math.sin(angle) * 0.17
          });
        });
      }
    }

    for (const entry of placed) {
      const id = entry.color + ":" + entry.index;
      let el = tokenEls.get(id);

      if (!el) {
        el = svgEl("g", { class: "token" });
        el.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 0.36, fill: geometry.colors[entry.color] }));
        el.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 0.3, class: "token-ring" }));
        layer.appendChild(el);
        tokenEls.set(id, el);
      }

      el.style.transform = "translate(" + entry.x + "px," + entry.y + "px)";

      const canPlay = entry.color === myColor && playable.has(entry.index);
      el.classList.toggle("clickable", canPlay);
      el.classList.toggle("highlight", canPlay);

      // Le gestionnaire est posé une seule fois : on lit l'index courant dans
      // le jeu de données, sinon un pion déplacé garderait son ancien index.
      el.dataset.token = String(entry.index);

      if (!el.dataset.bound) {
        el.dataset.bound = "1";
        el.addEventListener("click", (event) => {
          const target = event.currentTarget;
          if (!target.classList.contains("clickable")) return;
          playToken(Number(target.dataset.token));
        });
      }
    }
  }

  function playToken(index) {
    if (!game) return;
    push(game, "move", { token: index }, (reply) => {
      lastState = reply.state;
      renderState(reply.state);
    });
  }

  // ---------------------------------------------------------------- démarrage

  function main() {
    const page = $("[data-page]");
    if (!page) return;

    if (page.dataset.page === "lobby") {
      initLobby();
    } else if (page.dataset.page === "game") {
      initGame(page.dataset.code);
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && socket && !socket.isConnected()) socket.connect();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }

  // Surface de débogage (console du navigateur) et point d'entrée des
  // vérifications hors navigateur : scripts/geometry_check.mjs charge ce
  // fichier avec un DOM factice, injecte une géométrie réelle et rejoue un
  // rendu complet, ce qui permet de tester le client sans navigateur.
  window.LudoClient = {
    state: () => lastState,
    geometry: () => geometry,
    color: () => myColor,
    __test: {
      setGeometry: function (geo) {
        geometry = geo;
      },
      setSeat: function (seat, color) {
        mySeat = seat;
        myColor = color;
      },
      tokenCellFor: tokenCellFor,
      buildBoard: buildBoard,
      renderState: renderState
    }
  };
})();
