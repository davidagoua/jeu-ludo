/**
 * Bruitage du jeu — synthèse Web Audio, sans aucun fichier son.
 *
 * Tout est fabriqué à la volée par des oscillateurs et du bruit filtré : rien à
 * héberger, rien à licencier, et quelques kilo-octets au lieu de plusieurs
 * mégaoctets d'échantillons.
 *
 * Les navigateurs interdisent de produire du son avant une interaction : le
 * contexte est donc créé au premier geste de l'utilisateur (`unlock`), et
 * l'interface peut se contenter de demander la lecture.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "ludo.muted";

  var ctx = null;
  var muted = readMuted();

  /* ------------------------------------------------------------ préférence */

  function readMuted() {
    try {
      return global.localStorage && global.localStorage.getItem(STORAGE_KEY) === "1";
    } catch (_error) {
      return false;
    }
  }

  function saveMuted(value) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
      }
    } catch (_error) {
      /* mode privé : on garde le réglage en mémoire seulement */
    }
  }

  function isMuted() {
    return muted;
  }

  function setMuted(value) {
    muted = Boolean(value);
    saveMuted(muted);
    return muted;
  }

  function toggleMuted() {
    return setMuted(!muted);
  }

  /* --------------------------------------------------------------- contexte */

  /** Prépare le contexte audio. À appeler depuis un geste de l'utilisateur. */
  function unlock() {
    var context = audio();
    if (context && context.state === "suspended" && context.resume) context.resume();
    return Boolean(context);
  }

  function audio() {
    if (ctx) return ctx;

    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null;

    try {
      ctx = new Ctor();
    } catch (_error) {
      ctx = null;
    }

    return ctx;
  }

  /* --------------------------------------------------------------- fabrique */

  function tone(options) {
    var context = audio();
    if (!context) return;

    var start = context.currentTime + (options.delay || 0);
    var duration = options.duration || 0.15;
    var peak = options.gain === undefined ? 0.2 : options.gain;

    var osc = context.createOscillator();
    var amp = context.createGain();

    osc.type = options.type || "sine";
    osc.frequency.setValueAtTime(options.frequency || 440, start);

    if (options.to) {
      osc.frequency.exponentialRampToValueAtTime(options.to, start + duration);
    }

    // Une enveloppe courte évite les clics de début et de fin.
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(amp);
    amp.connect(context.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function noise(options) {
    var context = audio();
    if (!context) return;

    var start = context.currentTime + (options.delay || 0);
    var duration = options.duration || 0.08;
    var peak = options.gain === undefined ? 0.18 : options.gain;

    var frames = Math.max(1, Math.floor(context.sampleRate * duration));
    var buffer = context.createBuffer(1, frames, context.sampleRate);
    var data = buffer.getChannelData(0);

    for (var i = 0; i < frames; i++) {
      // décroissance : le bruit s'éteint au lieu de couper net
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    var source = context.createBufferSource();
    source.buffer = buffer;

    var filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = options.frequency || 1600;
    filter.Q.value = options.quality || 1.1;

    var amp = context.createGain();
    amp.gain.setValueAtTime(peak, start);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(amp);
    amp.connect(context.destination);
    source.start(start);
  }

  /* ------------------------------------------------------------------- sons */

  var SOUNDS = {
    /** Le dé roule : une série de chocs brefs, puis un posé plus grave. */
    roll: function () {
      for (var i = 0; i < 5; i++) {
        noise({
          delay: i * 0.07,
          duration: 0.06,
          frequency: 1500 + Math.random() * 1400,
          gain: 0.13
        });
      }
      tone({ delay: 0.36, frequency: 190, to: 120, duration: 0.16, type: "triangle", gain: 0.16 });
    },

    /** Le dé s'arrête sur une face. */
    settle: function () {
      noise({ duration: 0.05, frequency: 2400, gain: 0.16 });
      tone({ frequency: 320, to: 240, duration: 0.09, type: "triangle", gain: 0.12, delay: 0.01 });
    },

    /** Un pion avance. */
    move: function () {
      tone({ frequency: 700, to: 520, duration: 0.07, type: "triangle", gain: 0.16 });
      noise({ duration: 0.03, frequency: 3000, gain: 0.07, delay: 0.005 });
    },

    /** Un pion est renvoyé à sa base : le son descend, c'est une mauvaise nouvelle. */
    capture: function () {
      tone({ frequency: 620, to: 150, duration: 0.32, type: "sawtooth", gain: 0.15 });
      noise({ delay: 0.02, duration: 0.22, frequency: 900, gain: 0.1 });
    },

    /** Un pion arrive au centre. */
    arrive: function () {
      var notes = [660, 880, 1174];
      for (var i = 0; i < notes.length; i++) {
        tone({
          delay: i * 0.09,
          frequency: notes[i],
          duration: 0.22,
          type: "sine",
          gain: 0.18
        });
      }
    },

    /** Victoire. */
    win: function () {
      var notes = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < notes.length; i++) {
        tone({
          delay: i * 0.13,
          frequency: notes[i],
          duration: 0.34,
          type: "triangle",
          gain: 0.2
        });
      }
      tone({ delay: 0.65, frequency: 523, duration: 0.6, type: "sine", gain: 0.14 });
      tone({ delay: 0.65, frequency: 784, duration: 0.6, type: "sine", gain: 0.12 });
    },

    /** Rien à jouer : le tour passe. */
    stuck: function () {
      tone({ frequency: 180, to: 120, duration: 0.22, type: "square", gain: 0.1 });
    },

    /** C'est à vous de jouer. */
    turn: function () {
      tone({ frequency: 880, duration: 0.28, type: "sine", gain: 0.14 });
      tone({ frequency: 1320, duration: 0.22, type: "sine", gain: 0.07, delay: 0.02 });
    }
  };

  /** Événement du journal du serveur -> son. */
  var EVENTS = {
    started: "turn",
    rolled: "settle",
    moved: "move",
    captured: "capture",
    arrived: "arrive",
    won: "win",
    stuck: "stuck",
    triple_six: "stuck"
  };

  var NAMES = Object.keys(SOUNDS);

  /**
   * Son correspondant à un événement du serveur, ou `null`.
   *
   * Le troisième six est une pénalité : il sonne comme un tour perdu.
   */
  function soundFor(type) {
    return EVENTS[type] || null;
  }

  /** Joue un son par son nom. Les noms inconnus sont ignorés. */
  function play(name) {
    if (muted || !name) return false;
    if (!audio()) return false;

    var sound = SOUNDS[name];
    if (!sound) return false;

    sound();
    return true;
  }

  /**
   * Joue les sons des événements du journal, décalés pour rester lisibles.
   *
   * Un même état peut porter plusieurs événements (un déplacement qui capture,
   * puis une arrivée) : on les enchaîne au lieu de les superposer.
   */
  function playEvents(types) {
    if (muted) return [];

    var joues = [];
    var rang = 0;

    for (var i = 0; i < types.length; i++) {
      var name = soundFor(types[i]);
      if (!name) continue;

      // au plus trois sons d'affilée, sinon l'état complet au chargement
      // déclencherait une salve
      if (rang >= 3) break;

      (function (nom, delai) {
        if (delai === 0) {
          play(nom);
        } else if (global.setTimeout) {
          global.setTimeout(function () {
            play(nom);
          }, delai);
        }
      })(name, rang * 150);

      joues.push(name);
      rang++;
    }

    return joues;
  }

  /**
   * Entrées du journal apparues depuis le dernier état connu.
   *
   * Le journal du serveur est borné : on le compare donc par contenu, en
   * cherchant le plus long recouvrement entre la fin de l'ancien et le début du
   * nouveau.
   */
  function newLogEntries(previous, current) {
    if (!current || current.length === 0) return [];
    if (!previous || previous.length === 0) return current;

    var max = Math.min(previous.length, current.length);

    for (var n = max; n > 0; n--) {
      var same = true;

      for (var i = 0; i < n; i++) {
        if (entryKey(previous[previous.length - n + i]) !== entryKey(current[i])) {
          same = false;
          break;
        }
      }

      if (same) return current.slice(n);
    }

    return current.slice(-1);
  }

  function entryKey(entry) {
    if (!entry) return "";
    return [
      entry.type,
      entry.color,
      entry.dice,
      entry.token,
      entry.from,
      entry.to,
      entry.victim,
      entry.turn
    ].join("|");
  }

  global.LudoSound = {
    play: play,
    playEvents: playEvents,
    soundFor: soundFor,
    newLogEntries: newLogEntries,
    names: NAMES,
    unlock: unlock,
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMuted: toggleMuted,

    /** Vrai si le navigateur sait produire du son. */
    isSupported: function () {
      return Boolean(global.AudioContext || global.webkitAudioContext);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
