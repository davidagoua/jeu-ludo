defmodule Ludo.Game do
  @moduledoc """
  État et règles du Ludo.

  Ce module est **pur** : toutes les fonctions renvoient un nouvel état au lieu
  de le modifier. La seule source d'impureté est le dé, qui peut être injecté
  (`roll/3`) pour rendre les tests déterministes.

  ## Représentation

  Un pion est soit `:base`, soit un entier de `0` à `61` :

    * `0..55` — cases de l'anneau, relatives au départ du joueur ;
    * `56..60` — colonne d'arrivée, de l'extérieur vers le centre ;
    * `61` — arrivé (`Ludo.Board.finish/0`).

  ## Règles appliquées

    * un 6 est nécessaire pour sortir un pion de sa base ;
    * trois 6 consécutifs annulent le tour ;
    * atterrir sur un pion adverse le renvoie à sa base, sauf sur une case sûre ;
    * un 6, une capture ou un pion arrivé donnent un tour supplémentaire ;
    * il faut le compte exact pour atteindre l'arrivée (sinon le coup est refusé) ;
    * le premier joueur à rentrer ses 4 pions gagne.

  ## Règles volontairement écartées

  Les blocs (deux pions empilés bloquant le passage) ne sont pas impliqués :
  plusieurs pions d'un même joueur peuvent partager une case, et les adversaires
  peuvent passer par-dessus. C'est la variante la plus courante en ligne et elle
  évite les blocages définitifs.
  """

  alias Ludo.Board

  @type position :: :base | 0..61

  @modes %{
    vs_ai: %{
      seats: 4,
      bots: 3,
      label: "Solo contre l'IA",
      hint: "1 joueur + 3 IA",
      bot_choices: [1, 2, 3]
    },
    p2: %{seats: 2, bots: 0, label: "2 joueurs", hint: "2 joueurs humains"},
    p3: %{seats: 3, bots: 0, label: "3 joueurs", hint: "3 joueurs humains"},
    p4: %{seats: 4, bots: 0, label: "4 joueurs", hint: "4 joueurs humains"}
  }

  # Ordre d'affichage des modes (une map n'a pas d'ordre stable).
  @mode_order [:vs_ai, :p2, :p3, :p4]

  @max_log 40

  @color_labels %{red: "Rouge", green: "Vert", yellow: "Jaune", blue: "Bleu"}

  defstruct code: nil,
            mode: :p2,
            seats: 2,
            # nombre d'IA installées à la création, choisi par l'hôte
            initial_bots: 0,
            status: :waiting,
            players: [],
            tokens: %{},
            turn: 0,
            dice: nil,
            six_streak: 0,
            winner: nil,
            log: [],
            version: 0

  @type t :: %__MODULE__{}

  # ---------------------------------------------------------------------------
  # Modes et libellés
  # ---------------------------------------------------------------------------

  @doc "Les modes de jeu proposés, dans l'ordre d'affichage."
  def modes, do: @modes

  @doc "Liste des modes sérialisable en JSON, pour le formulaire d'accueil."
  def modes_list do
    # L'ordre d'itération d'une map n'est pas garanti : on impose l'ordre
    # d'affichage à partir de @mode_order.
    for key <- @mode_order, mode <- [Map.fetch!(@modes, key)] do
      %{
        key: to_string(key),
        seats: mode.seats,
        bots: mode.bots,
        label: mode.label,
        hint: mode.hint,
        # vide pour les modes sans IA
        bot_choices: Map.get(mode, :bot_choices, [])
      }
    end
  end

  @doc "Nombre de sièges d'un mode."
  def seats_for(mode), do: mode |> fetch_mode() |> Map.fetch!(:seats)

  @doc "Nombre d'IA à installer d'emblée pour un mode."
  def bots_for(mode), do: mode |> fetch_mode() |> Map.fetch!(:bots)

  @doc """
  Nombres d'IA proposés pour un mode (vide s'il n'en prévoit pas).
  """
  def bot_choices(mode), do: mode |> fetch_mode() |> Map.get(:bot_choices, [])

  @doc """
  Nombre d'IA retenu, et sièges correspondants.

  Un mode sans IA ignore le choix. Un mode avec IA accepte de 1 à 3 adversaires,
  ce qui donne 2 à 4 sièges : le joueur, plus ses adversaires.
  """
  def seats_and_bots(mode, nil), do: {seats_for(mode), bots_for(mode)}

  def seats_and_bots(mode, wanted) when is_integer(wanted) do
    case bot_choices(mode) do
      [] ->
        {seats_for(mode), bots_for(mode)}

      choices ->
        bots = wanted |> max(Enum.min(choices)) |> min(Enum.max(choices))
        {bots + 1, bots}
    end
  end

  def seats_and_bots(mode, _autre), do: {seats_for(mode), bots_for(mode)}

  @doc "Libellé lisible d'un mode."
  def mode_label(mode), do: mode |> fetch_mode() |> Map.fetch!(:label)

  @doc "Libellé français d'une couleur."
  def color_label(color), do: Map.fetch!(@color_labels, color)

  defp fetch_mode(mode) when is_atom(mode), do: Map.fetch!(@modes, mode)

  defp fetch_mode(mode) when is_binary(mode) do
    Map.fetch!(@modes, String.to_existing_atom(mode))
  end

  @doc """
  Convertit une valeur en mode connu.

  Renvoie `{:ok, mode}` ou `{:error, :unknown_mode}` : jamais un `:error` nu,
  pour que les `with` des appelants restent totalement couverts.
  """
  def parse_mode(mode) when is_atom(mode) do
    if Map.has_key?(@modes, mode), do: {:ok, mode}, else: {:error, :unknown_mode}
  end

  # On compare les chaînes aux modes connus au lieu de convertir en atome :
  # `String.to_existing_atom/1` accepterait n'importe quel atome déjà présent
  # dans la VM (« red », « ok »…), ce qui ferait planter le lobby juste après.
  def parse_mode(mode) when is_binary(mode) do
    case Enum.find(@modes, fn {key, _} -> Atom.to_string(key) == mode end) do
      {key, _} -> {:ok, key}
      nil -> {:error, :unknown_mode}
    end
  end

  def parse_mode(_), do: {:error, :unknown_mode}

  # ---------------------------------------------------------------------------
  # Création et remplissage
  # ---------------------------------------------------------------------------

  @doc """
  Crée une partie en attente de joueurs. L'hôte occupe le siège 0.
  """
  def new(code, mode, host_name, host_id, options \\ []) when is_binary(code) do
    {seats, bots} = seats_and_bots(mode, options[:bots])

    game = %__MODULE__{
      code: code,
      mode: mode,
      seats: seats,
      initial_bots: bots,
      status: :waiting,
      players: [],
      tokens: %{}
    }

    {:ok, game, _player, :joined} = add_player(game, host_name, host_id)
    game = add_initial_bots(game)

    # Le mode solo remplit tous les sièges d'emblée : la partie démarre aussitôt.
    if length(game.players) >= game.seats do
      {:ok, started} = start(game)
      started
    else
      game
    end
  end

  defp add_initial_bots(game) do
    Enum.reduce(1..max(game.initial_bots, 0)//1, game, fn _, acc ->
      case add_bot(acc) do
        {:ok, acc} -> acc
        {:error, _} -> acc
      end
    end)
  end

  @doc """
  Ajoute un joueur humain.

  Si `id` correspond à un joueur déjà installé, il reprend simplement son siège
  (c'est le mécanisme de reconnexion : l'identifiant est conservé par le
  navigateur, aucun compte n'est nécessaire).
  """
  def add_player(%__MODULE__{} = game, name, id) do
    cond do
      existing = Enum.find(game.players, &(&1.id == id and not is_nil(id))) ->
        players = replace_player(game.players, existing, %{existing | connected: true})
        {:ok, %{game | players: players}, existing, :rejoined}

      game.status != :waiting ->
        {:error, :already_started}

      length(game.players) >= game.seats ->
        {:error, :full}

      true ->
        seat = next_free_seat(game)
        color = Board.seat_color(seat)

        player = %{
          id: id,
          name: clean_name(name),
          seat: seat,
          color: color,
          kind: :human,
          connected: true
        }

        game = %{
          game
          | players: Enum.sort_by(game.players ++ [player], & &1.seat),
            tokens: Map.put_new(game.tokens, color, List.duplicate(:base, 4)),
            version: game.version + 1
        }

        {:ok, game, player, :joined}
    end
  end

  @doc """
  Installe un joueur sur un camp de son choix, tant que la partie n'a pas démarré.

  Les camps sont libres : le premier arrivé prend celui qu'il veut, et le siège 0
  (le rouge) joue en premier. Un siège déjà occupé est refusé, sauf s'il est déjà
  le sien.
  """
  @spec choose_seat(t(), term(), integer()) :: {:ok, t(), list()} | {:error, atom()}
  def choose_seat(%__MODULE__{status: :waiting} = game, player_id, seat) do
    player = Enum.find(game.players, &(&1.id == player_id))

    cond do
      player == nil ->
        {:error, :not_in_game}

      not is_integer(seat) or seat < 0 or seat >= game.seats ->
        {:error, :unknown_seat}

      player.seat == seat ->
        {:ok, game, []}

      Enum.any?(game.players, &(&1.seat == seat)) ->
        {:error, :seat_taken}

      true ->
        color = Board.seat_color(seat)
        previous = player.color

        players =
          game.players
          |> Enum.map(fn p ->
            if p.id == player_id, do: %{p | seat: seat, color: color}, else: p
          end)
          |> Enum.sort_by(& &1.seat)

        # les pions suivent le joueur : ils passent dans sa nouvelle couleur
        tokens =
          game.tokens
          |> Map.delete(previous)
          |> Map.put(color, Map.get(game.tokens, previous, List.duplicate(:base, 4)))

        game = %{game | players: players, tokens: tokens, version: game.version + 1}

        {:ok, game, []}
    end
  end

  def choose_seat(%__MODULE__{}, _player_id, _seat), do: {:error, :already_started}

  @doc "Ajoute un pion-joueur automatisé sur le premier siège libre."
  def add_bot(%__MODULE__{} = game) do
    cond do
      length(game.players) >= game.seats ->
        {:error, :full}

      true ->
        seat = next_free_seat(game)
        color = Board.seat_color(seat)

        player = %{
          id: nil,
          name: "IA #{color_label(color)}",
          seat: seat,
          color: color,
          kind: :bot,
          connected: true
        }

        game = %{
          game
          | players: Enum.sort_by(game.players ++ [player], & &1.seat),
            tokens: Map.put_new(game.tokens, color, List.duplicate(:base, 4)),
            version: game.version + 1
        }

        {:ok, game}
    end
  end

  @doc "Complète les sièges libres avec des IA."
  def fill_with_bots(%__MODULE__{} = game) do
    Enum.reduce_while(1..game.seats, game, fn _, acc ->
      if length(acc.players) >= acc.seats do
        {:halt, acc}
      else
        case add_bot(acc) do
          {:ok, acc} -> {:cont, acc}
          {:error, _} -> {:halt, acc}
        end
      end
    end)
  end

  @doc """
  Démarre la partie. Tous les sièges doivent être pourvus ; utilisez
  `fill_with_bots/1` au préalable pour compléter avec des IA.
  """
  def start(%__MODULE__{status: :waiting} = game) do
    if length(game.players) < game.seats do
      {:error, :not_enough_players}
    else
      game =
        game
        |> Map.put(:status, :playing)
        |> Map.put(:turn, 0)
        |> Map.put(:dice, nil)
        |> Map.put(:six_streak, 0)
        |> Map.put(:version, game.version + 1)
        |> log_event(%{
          type: :started,
          text: "La partie commence. #{color_label(:red)} joue en premier."
        })

      {:ok, game}
    end
  end

  def start(%__MODULE__{}), do: {:error, :already_started}

  @doc """
  Le lancer en cours doit-il être résolu par le serveur, sans attendre le joueur ?

  Oui dans trois cas : aucun coup possible, un seul coup jouable (l'enchaîner
  évite un clic inutile), ou trois 6 d'affilée qui font perdre le tour.

  Le serveur attend alors un court instant avant d'appeler `resolve_roll/1`, pour
  que le numéro tiré reste affiché — sinon il disparaîtrait aussitôt.
  """
  @spec auto_resolve?(t()) :: boolean()
  def auto_resolve?(%__MODULE__{status: :playing} = game) do
    game.dice != nil and (game.six_streak >= 3 or length(legal_moves(game)) <= 1)
  end

  def auto_resolve?(%__MODULE__{}), do: false

  @doc """
  Résout un lancer que le joueur ne peut pas jouer lui-même : perd son tour avec
  trois 6, passe la main faute de coup, ou enchaîne l'unique coup jouable.
  """
  @spec resolve_roll(t()) :: {:ok, t(), list()} | {:error, atom()}
  def resolve_roll(%__MODULE__{status: :playing, dice: dice} = game) when is_integer(dice) do
    player = current_player(game)

    cond do
      player == nil ->
        {:error, :no_current_player}

      game.six_streak >= 3 ->
        game =
          game
          |> log_event(
            event(game, %{
              type: :triple_six,
              color: player.color,
              text: "Trois 6 d'affilée : le tour est perdu."
            })
          )
          |> end_turn(false)

        {:ok, game, []}

      true ->
        case legal_moves(game) do
          [] ->
            game =
              game
              |> log_event(
                event(game, %{
                  type: :stuck,
                  color: player.color,
                  text: "Aucun coup possible, le tour passe."
                })
              )
              |> end_turn(false)

            {:ok, game, []}

          [only] ->
            move(game, player.id, only)

          _moves ->
            {:error, :ambiguous}
        end
    end
  end

  def resolve_roll(%__MODULE__{}), do: {:error, :no_dice}

  @doc "Marque un joueur comme déconnecté (la partie continue)."
  def disconnect(game, player_id) do
    case Enum.find_index(game.players, &(&1.id == player_id)) do
      nil ->
        game

      index ->
        player = Enum.at(game.players, index)
        %{game | players: List.replace_at(game.players, index, %{player | connected: false})}
    end
  end

  # Retire complètement un joueur et libère son siège. Réservé aux parties en
  # attente : une fois la partie lancée on se contente de `disconnect/2`, sinon
  # les couleurs et l'ordre des tours changeraient en plein jeu.
  defp drop_player(game, player_id) do
    case player_by_id(game, player_id) do
      nil ->
        game

      player ->
        %{
          game
          | players: Enum.reject(game.players, &(&1.seat == player.seat)),
            tokens: Map.delete(game.tokens, player.color),
            version: game.version + 1
        }
    end
  end

  @doc """
  Retire un joueur d'une partie en attente et libère son siège.

  Sans effet si la partie est déjà commencée (voir `disconnect/2`).
  """
  def remove_player(%__MODULE__{status: :waiting} = game, player_id) do
    drop_player(game, player_id)
  end

  def remove_player(%__MODULE__{} = game, player_id), do: disconnect(game, player_id)

  @doc "Nombre de joueurs humains installés."
  def human_count(game), do: Enum.count(game.players, &(&1.kind == :human))

  @doc "Sièges encore libres."
  def free_seats(game), do: game.seats - length(game.players)

  defp next_free_seat(game) do
    taken = MapSet.new(game.players, & &1.seat)
    Enum.find(0..(game.seats - 1), &(not MapSet.member?(taken, &1)))
  end

  defp replace_player(players, target, new) do
    Enum.map(players, fn p -> if p.seat == target.seat, do: new, else: p end)
  end

  @doc "Nettoie un pseudo : supprime les espaces superflus et borne la longueur."
  def clean_name(name) when is_binary(name) do
    name
    |> String.replace(~r/\s+/u, " ")
    |> String.trim()
    |> String.slice(0, 18)
  end

  def clean_name(_), do: ""

  # ---------------------------------------------------------------------------
  # Tour de jeu
  # ---------------------------------------------------------------------------

  @doc "Le joueur dont c'est le tour."
  def current_player(game), do: Enum.find(game.players, &(&1.seat == game.turn))

  @doc "Le joueur identifié par `id`, ou nil."
  def player_by_id(game, id), do: Enum.find(game.players, &(&1.id == id and not is_nil(id)))

  @doc "Pions d'un joueur, sous forme de liste de positions."
  def tokens_of(game, color), do: Map.get(game.tokens, color, List.duplicate(:base, 4))

  @doc "Nombre de pions arrivés pour une couleur."
  def finished_count(game, color) do
    game |> tokens_of(color) |> Enum.count(&(&1 == Board.finish()))
  end

  @doc """
  Lance le dé pour le joueur `player_id`.

  `dice` ne doit **jamais** venir du client : il n'existe que pour rendre les
  tests et les simulations déterministes. Le serveur appelle toujours `roll/2`.

  Renvoie `{:ok, game, events}` ou `{:error, raison}`.
  """
  def roll(game, player_id, dice \\ :random)

  def roll(%__MODULE__{status: :playing} = game, player_id, dice) do
    player = current_player(game)

    cond do
      player == nil ->
        {:error, :no_current_player}

      player.id != player_id ->
        {:error, :not_your_turn}

      game.dice != nil ->
        {:error, :already_rolled}

      true ->
        value = if dice == :random, do: :rand.uniform(6), else: dice

        unless is_integer(value) and value in 1..6 do
          raise ArgumentError, "valeur de dé invalide : #{inspect(value)}"
        end

        game = %{game | dice: value, version: game.version + 1}
        streak = if value == 6, do: game.six_streak + 1, else: 0
        game = %{game | six_streak: streak}

        rolled =
          event(game, %{
            type: :rolled,
            color: player.color,
            dice: value,
            text: "#{player.name} lance un #{value}."
          })

        game = log_event(game, rolled)

        # Le lancer est publié tel quel : c'est au serveur de le résoudre, après
        # un court délai, pour que le numéro tiré soit visible même quand le
        # joueur n'a aucun coup à jouer.
        {:ok, game, [Map.put(rolled, :legal, legal_moves(game))]}
    end
  end

  def roll(%__MODULE__{}, _player_id, _dice), do: {:error, :not_playing}

  @doc """
  Coups légaux pour le joueur courant, étant donné le dé déjà lancé.

  Renvoie la liste des index de pions jouables.
  """
  def legal_moves(%__MODULE__{status: :playing, dice: dice} = game) when is_integer(dice) do
    player = current_player(game)
    tokens = tokens_of(game, player.color)
    finish = Board.finish()

    tokens
    |> Enum.with_index()
    |> Enum.flat_map(fn {position, index} ->
      cond do
        position == :base -> if dice == 6, do: [index], else: []
        position == finish -> []
        position + dice <= finish -> [index]
        true -> []
      end
    end)
  end

  def legal_moves(%__MODULE__{}), do: []

  @doc """
  Joue le pion `token_index` du joueur `player_id`.

  Renvoie `{:ok, game, events}` ou `{:error, raison}`.
  """
  def move(game, player_id, token_index)

  def move(%__MODULE__{status: :playing, dice: dice} = game, player_id, token_index)
      when is_integer(dice) and is_integer(token_index) do
    player = current_player(game)

    cond do
      player == nil ->
        {:error, :no_current_player}

      player.id != player_id ->
        {:error, :not_your_turn}

      token_index not in legal_moves(game) ->
        {:error, :illegal_move}

      true ->
        {game, events} = do_move(game, player, token_index)
        {:ok, game, events}
    end
  end

  def move(%__MODULE__{status: :playing}, _player_id, _token), do: {:error, :no_dice}
  def move(%__MODULE__{}, _player_id, _token), do: {:error, :not_playing}

  # ---------------------------------------------------------------------------
  # Application d'un coup
  # ---------------------------------------------------------------------------

  defp do_move(game, player, token_index) do
    dice = game.dice
    color = player.color
    tokens = tokens_of(game, color)
    from = Enum.at(tokens, token_index)
    to = if from == :base, do: 0, else: from + dice

    game = %{game | tokens: Map.put(game.tokens, color, List.replace_at(tokens, token_index, to))}

    {game, captures} = capture_at(game, color, to)

    events =
      [
        event(game, %{
          type: :moved,
          color: color,
          token: token_index,
          from: from,
          to: to,
          dice: dice,
          text: move_text(player, from, to, dice)
        })
      ] ++
        Enum.map(captures, fn {victim_color, victim_token} ->
          event(game, %{
            type: :captured,
            color: color,
            victim: victim_color,
            victim_token: victim_token,
            text: "#{player.name} capture un pion #{color_label(victim_color)} !"
          })
        end)

    arrived = to == Board.finish()

    events =
      if arrived do
        events ++
          [
            event(game, %{
              type: :arrived,
              color: color,
              token: token_index,
              text: "#{player.name} rentre un pion à l'arrivée."
            })
          ]
      else
        events
      end

    game = Enum.reduce(events, game, &log_event(&2, &1))
    won = finished_count(game, color) == 4

    cond do
      won ->
        game =
          game
          |> Map.put(:status, :finished)
          |> Map.put(:winner, color)
          |> Map.put(:dice, nil)
          |> log_event(
            event(game, %{type: :won, color: color, text: "#{player.name} gagne la partie !"})
          )

        {game, events}

      true ->
        extra = dice == 6 or captures != [] or arrived
        {end_turn(%{game | dice: nil}, extra), events}
    end
  end

  defp move_text(player, :base, 0, 6) do
    "#{player.name} sort un pion de sa base."
  end

  # `Board.finish()` est un appel de fonction : interdit dans un guard.
  defp move_text(player, _from, to, dice) do
    cond do
      to == Board.finish() -> "#{player.name} amène un pion à l'arrivée."
      true -> "#{player.name} avance de #{dice}."
    end
  end

  # Capture les pions adverses présents sur la case d'arrivée. Les cases sûres
  # (départs et étoiles) protègent : aucune capture n'y a lieu.
  defp capture_at(game, color, position) do
    case Board.ring_index(color, position) do
      nil ->
        {game, []}

      index ->
        if Board.safe_index?(index) do
          {game, []}
        else
          victims =
            for {other, tokens} <- game.tokens,
                other != color,
                {token_position, token_index} <- Enum.with_index(tokens),
                Board.ring_index(other, token_position) == index,
                do: {other, token_index}

          game =
            Enum.reduce(victims, game, fn {victim_color, victim_index}, acc ->
              tokens = tokens_of(acc, victim_color)
              put_in(acc.tokens[victim_color], List.replace_at(tokens, victim_index, :base))
            end)

          {game, victims}
        end
    end
  end

  # Termine le tour : `extra` conserve la main (6, capture ou pion arrivé).
  defp end_turn(game, true) do
    %{game | dice: nil, version: game.version + 1}
  end

  defp end_turn(game, false) do
    next = rem(game.turn + 1, game.seats)

    %{game | turn: next, dice: nil, six_streak: 0, version: game.version + 1}
  end

  @doc "Vrai si c'est au tour d'un joueur automatisé."
  def bot_turn?(game) do
    case current_player(game) do
      %{kind: :bot} -> true
      _ -> false
    end
  end

  # ---------------------------------------------------------------------------
  # Journal
  # ---------------------------------------------------------------------------

  defp event(game, data), do: Map.put(data, :turn, game.turn)

  defp log_event(game, data) do
    entry = Map.take(data, [:type, :text, :color, :dice, :token, :from, :to, :victim, :turn])
    %{game | log: Enum.take(game.log ++ [entry], -@max_log)}
  end

  @doc "Derniers messages du journal, du plus ancien au plus récent."
  def recent_log(game, count \\ 8), do: Enum.take(game.log, -count)

  # ---------------------------------------------------------------------------
  # Sérialisation
  # ---------------------------------------------------------------------------

  @doc """
  État complet destiné au navigateur.

  Toute l'information du Ludo est publique ; on n'envoie donc pas d'état caché.
  Les identifiants de connexion (`id`) ne sont jamais transmis.
  """
  def public_state(game) do
    player = current_player(game)
    dice = game.dice

    %{
      code: game.code,
      mode: to_string(game.mode),
      mode_label: mode_label(game.mode),
      seats: game.seats,
      status: to_string(game.status),
      winner: game.winner && to_string(game.winner),
      turn: game.turn,
      turn_color: player && to_string(player.color),
      turn_name: player && player.name,
      turn_is_bot: player != nil and player.kind == :bot,
      dice: dice,
      six_streak: game.six_streak,
      version: game.version,
      players:
        Enum.map(game.players, fn p ->
          %{
            seat: p.seat,
            name: p.name,
            color: to_string(p.color),
            kind: to_string(p.kind),
            connected: p.connected,
            tokens: Enum.map(tokens_of(game, p.color), &encode_position/1),
            finished: finished_count(game, p.color)
          }
        end),
      legal_moves: legal_moves(game),
      log: recent_log(game, 8)
    }
  end

  defp encode_position(:base), do: "base"
  defp encode_position(position), do: position
end
