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

    // Nombre d'IA : le sélecteur n'apparaît que pour un mode qui en prévoit, et
    // le texte récapitule la partie (le joueur et ses adversaires).
    const botsBox = $("#bots");
    const botsHint = $("#bots-hint");

    function syncBots() {
      const modeInput = $('input[name="mode"]:checked');
      const choix = ((modeInput && modeInput.dataset.botChoices) || "")
        .split(",")
        .filter(Boolean);

      botsBox.hidden = choix.length === 0;
      if (botsBox.hidden) return;

      const choisi = Number(($('input[name="bots"]:checked') || {}).value || choix[choix.length - 1]);
      botsHint.textContent =
        "1 joueur + " + choisi + " IA · " + (choisi + 1) + " camps";
    }

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener("change", syncBots);
    }

    for (const radio of document.querySelectorAll('input[name="bots"]')) {
      radio.addEventListener("change", syncBots);
    }

    syncBots();

    $("#create").addEventListener("click", () => {
      const name = pseudo.value.trim();
      if (!name) return toast("Choisissez d'abord un pseudo.");
      setName(name);

      const mode = ($('input[name="mode"]:checked') || {}).value || "vs_ai";
      const payload = { name: name, mode: mode, player_id: playerId };

      // on n'envoie le nombre d'IA que s'il a un sens pour ce mode
      if (!botsBox.hidden) {
        payload.bots = Number(($('input[name="bots"]:checked') || {}).value || 3);
      }

      push(lobby, "create", payload, (reply) => goToGame(reply.code));
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
    setupSound();

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

    // Une réaction n'est pas un état : elle ne fait que s'afficher un instant.
    game.on("reaction", (reaction) => showReaction(reaction));

    game
      .join()
      .receive("ok", (payload) => {
        geometry = payload.geometry;
        mySeat = payload.seat.seat;
        myColor = payload.seat.color;
        lastState = payload.state;

        setupReactions(payload.reactions);

        // on ne rejoue pas l'historique du journal à l'arrivée
        if (sound()) soundedLog = payload.state.log || [];
        lastTurnColor = null;

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
    renderCamps(state);
    renderTurn(state);
    renderBanner(state);
    playStateSounds(state);

    if (three() && three().isReady()) {
      three().update(state, myColor);
    }
  }

  /* ------------------------------------------------------------- réactions */

  // Durée d'affichage d'une réaction, en millisecondes.
  const REACTION_MS = 2000;

  let reactions = [];

  /** Construit la grille d'emojis à partir de la liste du serveur. */
  function setupReactions(liste) {
    reactions = liste || [];

    const grid = $("#emoji-grid");
    if (grid) {
      grid.innerHTML = "";

      for (const emoji of reactions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "emoji";
        button.textContent = emoji;
        button.setAttribute("aria-label", "Réagir avec " + emoji);
        button.addEventListener("click", () => sendReaction(emoji));
        grid.appendChild(button);
      }
    }

    const modal = $("#emoji-modal");

    const ouvrir = () => {
      if (!modal) return;
      modal.hidden = false;
      const premier = grid && grid.children[0];
      if (premier && premier.focus) premier.focus();
    };

    const fermer = () => {
      if (modal) modal.hidden = true;
    };

    const bouton = $("#emoji-open");
    if (bouton) bouton.addEventListener("click", ouvrir);

    const close = $("#emoji-close");
    if (close) close.addEventListener("click", fermer);

    // un clic sur le fond sombre ferme aussi
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) fermer();
      });
    }

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.hidden) fermer();
    });
  }

  /** Envoie une réaction. La modale se referme tout de suite. */
  function sendReaction(emoji) {
    const modal = $("#emoji-modal");
    if (modal) modal.hidden = true;

    if (!game || !reactions.includes(emoji)) return;

    push(game, "react", { emoji: emoji }, (reply) => {
      if (reply && reply.reason) toast(reply.message || "Réaction refusée.");
    });
  }

  /**
   * Affiche une réaction pendant deux secondes, dans le coin du joueur.
   *
   * La couche n'est jamais reconstruite : un changement d'état ne peut donc pas
   * effacer une réaction en cours.
   */
  function showReaction(reaction) {
    const overlay = $("#reactions");
    if (!overlay || !reaction || !reaction.emoji) return;

    const bulle = document.createElement("span");
    bulle.className = "reaction " + reaction.color;
    bulle.textContent = reaction.emoji;

    // Le nom vient du serveur ; à défaut, on retombe sur l'état connu.
    const joueur = (lastState && lastState.players ? lastState.players : []).find(
      (p) => p.color === reaction.color
    );
    const nom = reaction.name || (joueur ? joueur.name : reaction.color);

    bulle.setAttribute("title", nom + " réagit");
    bulle.setAttribute("aria-label", nom + " : " + reaction.emoji);

    overlay.appendChild(bulle);

    window.setTimeout(() => {
      if (bulle.remove) bulle.remove();
      else if (bulle.parentNode) bulle.parentNode.removeChild(bulle);
    }, REACTION_MS);
  }

  /* ------------------------------------------------------------- bruitage */

  // Journal déjà sonné, et tour précédent : ils servent à ne jouer chaque
  // événement qu'une fois.
  let soundedLog = [];
  let lastTurnColor = null;

  function sound() {
    return window.LudoSound || null;
  }

  /**
   * Joue les sons des événements nouveaux.
   *
   * Le son suit le journal du serveur plutôt que les clics : tout le monde
   * entend donc la même chose, y compris les coups des adversaires et de l'IA.
   */
  function playStateSounds(state) {
    const sounder = sound();
    if (!sounder) return;

    const entrees = sounder.newLogEntries(soundedLog, state.log || []);
    soundedLog = state.log || [];

    sounder.playEvents(entrees.map((entry) => entry.type));

    // Mon tour commence : un repère discret, une seule fois par tour.
    if (
      state.status === "playing" &&
      state.turn_color === myColor &&
      state.turn_color !== lastTurnColor
    ) {
      sounder.play("turn");
    }

    lastTurnColor = state.turn_color;
  }

  /** Coupe ou remet le son, et met le bouton à jour. */
  function setupSound() {
    const sounder = sound();
    const button = $("#sound");
    if (!sounder) return;

    // Les navigateurs exigent un geste avant de produire du son.
    const unlock = () => {
      sounder.unlock();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };

    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    if (!button) return;

    const sync = () => {
      const muted = sounder.isMuted();
      button.textContent = muted ? "Son coupé" : "Son activé";
      button.setAttribute("aria-pressed", muted ? "false" : "true");
    };

    button.addEventListener("click", () => {
      sounder.unlock();
      sounder.toggleMuted();
      sync();
      // un repère sonore confirme le retour du son
      if (!sounder.isMuted()) sounder.play("move");
    });

    sync();
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

  /**
   * Sélecteur de camp, affiché tant que la partie n'a pas démarré.
   *
   * Chaque siège a sa couleur ; le siège 0 joue en premier. Un camp déjà occupé
   * ne peut pas être pris, le sien est marqué.
   */
  function renderCamps(state) {
    const box = $("#camps");
    const row = $("#camps-row");
    if (!box || !row) return;

    const waiting = state.status === "waiting";
    box.hidden = !waiting;
    if (!waiting) return;

    const couleurs = (geometry && geometry.seat_colors) || geometry.players;

    row.innerHTML = "";

    for (let seat = 0; seat < state.seats; seat++) {
      const occupant = state.players.find((p) => p.seat === seat);
      const mien = occupant && occupant.color === myColor;
      const bouton = document.createElement("button");

      bouton.type = "button";
      bouton.className = "camp" + (mien ? " mine" : "");
      bouton.disabled = Boolean(occupant) && !mien;

      if (occupant) {
        bouton.title =
          (occupant.kind === "bot" ? "IA " : "") + occupant.name + (mien ? " (vous)" : "");
      } else {
        bouton.title = "Camp libre — cliquez pour le prendre";
      }

      const point = document.createElement("span");
      point.className = "camp-dot";
      point.style.background = geometry.colors[couleurs[seat]];

      const label = document.createElement("span");
      label.className = "camp-label";
      label.textContent = occupant ? (mien ? "vous" : occupant.name) : "libre";

      bouton.appendChild(point);
      bouton.appendChild(label);

      if (!occupant) {
        bouton.addEventListener("click", () => choisirCamp(seat));
      }

      row.appendChild(bouton);
    }
  }

  function choisirCamp(seat) {
    if (!game) return;

    push(game, "choose_seat", { seat: seat }, (reply) => {
      lastState = reply.state;
      renderState(reply.state);
    });
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
      // la partie est finie : plus de tour, donc plus de dé
      showDice(null, null, null);
      return;
    }

    const mine = state.turn_color === myColor;
    turn.textContent =
      (mine ? "À vous de jouer" : "Au tour de " + state.turn_name) +
      (state.turn_is_bot ? " (IA)" : "");

    // Le dé n'affiche sa valeur que pendant le tour de celui qui l'a lancée :
    // dès que le pion est joué, le serveur remet `dice` à zéro et le dé
    // redevient blanc. Chaque joueur a le sien sur le plateau.
    // Pendant que le joueur lance son propre dé, c'est l'animation qui pilote la
    // face affichée : on ne l'écrase pas avec l'état du serveur.
    if (!spinTimer) {
      showDice(state.dice, state.turn_color, state.turn_name);
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

  /**
   * Affiche une face du dé du panneau, avec le liseré du joueur dont c'est le
   * tour.
   *
   * `value` vaut `null` dès que le pion a été joué : le dé est alors blanc, comme
   * sur le plateau. Le liseré, lui, suit la main en cours.
   */
  function showDice(value, turnColor, turnName) {
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
        : "dé : " + value + (turnName ? ", lancé par " + turnName : "")
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
    if (sound()) sound().play("roll");

    push(game, "roll", {}, (reply) => {
      lastState = reply.state;
      stopSpin(reply.state.dice);
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
      setupReactions: function (list) {
        setupReactions(list);
      },
      reactionsList: function () {
        return reactions;
      },
      sendReaction: function (emoji) {
        sendReaction(emoji);
      },
      showReaction: function (reaction) {
        showReaction(reaction);
      },
      reactionDuration: function () {
        return REACTION_MS;
      },
      openEmoji: function () {
        const modal = $("#emoji-modal");
        if (modal) modal.hidden = false;
      },
      setSeat: function (seat, color) {
        mySeat = seat;
        myColor = color;
      },
      rollDice: rollDice,
      chooseSeat: choisirCamp,
      renderState: renderState
    }
  };
})();
