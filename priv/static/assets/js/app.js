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
  let lastDice = null;
  // Dernier lancer réellement affiché, et par qui : le serveur remet `dice` à
  // zéro dès que le pion a bougé, or les autres joueurs doivent pouvoir lire le
  // numéro joué. On garde donc la valeur jusqu'au lancer suivant.
  let lastRoll = { value: null, color: null };
  let spinTimer = null;
  // Le plateau est rendu en 3D ; le module s'annonce par l'événement
  // `ludo3dready` (l'ordre de chargement des scripts n'est pas garanti).
  const three = () => window.Ludo3D;

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

        buildBoard3D();
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

    // Le dé du panneau est aussi un bouton : le plateau 3D appelle la même
    // fonction quand on clique sur le dé en 3D.
    const diceButton = $("#dice");

    diceButton.addEventListener("click", () => rollDice());

    // au clavier : Entrée ou Espace sur le dé
    diceButton.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        diceButton.click();
      }
    });

    $("#fill-bots").addEventListener("click", () => {
      push(game, "fill_bots", {}, (reply) => {
        lastState = reply.state;
        renderState(reply.state);
      });
    });
  }

  // ---- plateau 3D (Three.js)
  //
  // Aucune coordonnée n'est écrite ici : le module 3D reçoit la géométrie du
  // serveur et s'occupe de tout (cases, pions, dé, animations). S'il n'est pas
  // encore chargé, l'état est conservé et poussé dès son arrivée.

  function buildBoard3D() {
    const canvas = $("#board3d");
    if (!canvas) return;

    if (!three() || !three().init(canvas)) {
      // WebGL indisponible : on le dit clairement plutôt que d'afficher du vide
      const message = $("#webgl-error");
      if (message) message.hidden = false;
      return;
    }

    three().setGeometry(geometry);
    three().setHandlers({
      roll: () => rollDice(),
      token: (index) => playToken(index)
    });
  }

  // ---- rendu

  function renderState(state) {
    if (!state || !geometry) return;
    renderPlayers(state);
    renderTurn(state);
    renderBanner(state);

    if (three() && three().isReady()) {
      three().update(state, myColor);
    }
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
    const hint = $("#hint");
    const fillBots = $("#fill-bots");

    if (state.status === "waiting") {
      turn.textContent = "En attente de joueurs…";
      dice.disabled = true;
      dice.classList.remove("ready");
      hint.textContent = "La partie démarre dès que tous les sièges sont pris.";
      showDice(null, null, null);
      return;
    }

    fillBots.hidden = true;

    if (state.status === "finished") {
      const winner = state.players.find((p) => p.color === state.winner);
      turn.textContent = "Partie terminée";
      dice.disabled = true;
      dice.classList.remove("ready");
      hint.textContent = winner ? winner.name + " remporte la partie." : "";
      showDice(
        state.dice !== null ? state.dice : lastRoll.value,
        null, // plus de tour en cours : pas de liseré
        rollerName(state)
      );
      return;
    }

    const mine = state.turn_color === myColor;
    turn.textContent =
      (mine ? "À vous de jouer" : "Au tour de " + state.turn_name) +
      (state.turn_is_bot ? " (IA)" : "");

    // Un nouveau lancer remplace le précédent ; sinon on garde la face affichée,
    // même après que le pion a bougé et que le serveur a remis `dice` à zéro.
    if (state.dice !== null) {
      lastRoll = { value: state.dice, color: state.turn_color };
    }

    // Pendant que le joueur lance son propre dé, c'est l'animation qui pilote la
    // face affichée : on ne l'écrase pas avec l'état du serveur.
    if (!spinTimer) {
      showDice(lastRoll.value, state.turn_color, rollerName(state));
    }

    // Le dé est le bouton : actif seulement quand c'est à nous et qu'il n'a pas
    // encore été lancé.
    const canRoll = mine && state.dice === null;
    dice.disabled = !canRoll;
    dice.classList.toggle("ready", canRoll);

    if (!mine) {
      hint.textContent = "";
    } else if (canRoll) {
      hint.textContent = "Cliquez sur le dé pour lancer.";
    } else if (state.legal_moves.length > 0) {
      hint.textContent = "Cliquez sur un pion en surbrillance.";
    } else {
      hint.textContent = "Aucun coup possible avec ce dé.";
    }
  }

  /** Nom du joueur qui a lancé le numéro affiché. */
  function rollerName(state) {
    if (!lastRoll.color || !state) return null;
    const roller = state.players.find((p) => p.color === lastRoll.color);
    return roller && roller.name;
  }

  /**
   * Affiche une face du dé du panneau, avec le liseré du joueur dont c'est le
   * tour.
   *
   * Le numéro affiché reste celui du dernier lancer — les autres joueurs doivent
   * pouvoir le lire — mais la couleur, elle, suit la main en cours : c'est elle
   * qui dit à qui c'est de jouer.
   */
  function showDice(value, turnColor, rollerNameValue) {
    if (spinTimer) return;

    const dice = $("#dice");
    if (!dice) return;

    // face précédente : on évite de rejouer l'animation d'arrivée sans raison
    const changed = value !== lastDice;
    lastDice = value;

    renderDiceFace(value);

    if (turnColor && geometry && geometry.colors[turnColor]) {
      dice.style.setProperty("--turn-color", geometry.colors[turnColor]);
      dice.classList.add("current");
    } else {
      dice.classList.remove("current");
    }

    // les lecteurs d'écran doivent aussi savoir à qui appartient ce numéro
    dice.setAttribute(
      "aria-label",
      value === null
        ? "dé non lancé"
        : "dé : " + value + (rollerNameValue ? ", lancé par " + rollerNameValue : "")
    );

    if (value !== null && changed) {
      dice.classList.remove("settled");
      void dice.offsetWidth;
      dice.classList.add("settled");
    }
  }

  // ---- dé : faces à points et animations

  // Index des points allumés dans une grille 3x3, par valeur de dé.
  const DICE_PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };

  function renderDiceFace(value) {
    const dice = $("#dice");
    if (!dice) return;

    const on = DICE_PIPS[value] || [];
    dice.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "dice-grid";

    for (let i = 0; i < 9; i++) {
      const pip = document.createElement("span");
      pip.className = on.indexOf(i) === -1 ? "pip" : "pip on";
      grid.appendChild(pip);
    }

    dice.appendChild(grid);
    dice.setAttribute("aria-label", value ? "dé : " + value : "dé non lancé");
  }

  // Lancer le dé : appelé par le bouton du panneau comme par le dé en 3D.
  function rollDice() {
    const dice = $("#dice");
    if (dice && dice.disabled) return;
    if (!game || !lastState || lastState.status !== "playing") return;
    if (lastState.turn_color !== myColor) return;
    if (lastState.dice !== null) return;

    startSpin();

    push(game, "roll", {}, (reply) => {
      lastState = reply.state;
      stopSpin(reply.state.dice);
      if (reply.state.dice !== null) {
        lastRoll = { value: reply.state.dice, color: reply.state.turn_color };
      }
      renderState(reply.state);
    });
  }

  function startSpin() {
    const dice = $("#dice");
    if (!dice) return;

    stopSpin();
    dice.classList.add("rolling");
    if (three() && three().isReady()) three().setRolling(true);

    spinTimer = window.setInterval(() => {
      renderDiceFace(1 + Math.floor(Math.random() * 6));
    }, 70);
  }

  function stopSpin(value) {
    if (spinTimer) {
      window.clearInterval(spinTimer);
      spinTimer = null;
    }

    const dice = $("#dice");
    if (!dice) return;

    dice.classList.remove("rolling");
    if (three() && three().isReady()) three().setRolling(false);

    if (value !== null) lastRoll = { value: value, color: myColor };
    showDice(value, value === null ? null : myColor, null);
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

    // Le module 3D se charge en parallèle : dès qu'il est prêt, on lui donne la
    // géométrie et le dernier état connu.
    window.addEventListener("ludo3dready", () => {
      if (page.dataset.page !== "game" || !geometry) return;
      buildBoard3D();
      if (lastState) renderState(lastState);
    });

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
      rollDice: rollDice,
      renderState: renderState
    }
  };
})();
