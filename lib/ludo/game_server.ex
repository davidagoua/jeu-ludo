defmodule Ludo.GameServer do
  @moduledoc """
  Un processus par partie.

  Le serveur est le **seul écrivain** de l'état du jeu : toutes les actions
  (rejoindre, lancer le dé, déplacer un pion) passent par des `call`, ce qui
  élimine toute condition de course entre joueurs d'un même salon.

  Il s'occupe aussi de ce qui doit se produire sans intervention humaine :

    * jouer à la place des IA, avec un court délai pour que ce soit lisible ;
    * débloquer un tour resté en suspens (joueur parti ou inactif) au bout
      de `#{div(60_000, 1000)} secondes`.

  Les deux mécanismes sont protégés par un numéro de version : un minuteur
  devenu obsolète (parce qu'un autre coup est arrivé entre-temps) est ignoré.
  """

  use GenServer

  require Logger

  alias Ludo.{Bot, Game, Lobby}

  @pubsub Ludo.PubSub

  # L'IA ne joue pas instantanément : une pause aléatoire laisse le temps de voir
  # le dé et le déplacement, et évite qu'elle enchaîne ses coups comme une
  # machine. Le tirage est refait à chaque action (voir `bot_delay/0`).
  @bot_delay_min 1_000
  @bot_delay_max 3_000

  @turn_timeout 60_000

  # ---------------------------------------------------------------------------
  # API
  # ---------------------------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  # `child_spec/1` vient du superviseur, pas de GenServer : pas de @impl ici.
  def child_spec(opts) do
    %{
      id: {__MODULE__, Keyword.fetch!(opts, :code)},
      start: {__MODULE__, :start_link, [opts]},
      restart: :temporary,
      shutdown: 5_000
    }
  end

  @doc """
  Sujet PubSub interne d'un salon.

  Le préfixe évite la collision avec le sujet du canal Phoenix (`game:CODE`) :
  sans lui, un message PubSub brut atterrirait dans la boîte du canal.
  """
  def topic(code), do: "ludo:game:" <> code

  @doc "Abonne l'appelant aux mises à jour du salon."
  def subscribe(code), do: Phoenix.PubSub.subscribe(@pubsub, topic(code))

  @doc """
  Délai avant que l'IA ne joue, tiré au hasard entre #{@bot_delay_min} et
  #{@bot_delay_max} millisecondes.

  Le tirage est refait à **chaque** action : l'IA marque une pause avant de lancer
  le dé, puis à nouveau avant de déplacer son pion — sans quoi on ne verrait
  jamais le numéro qu'elle vient de faire.
  """
  @spec bot_delay() :: pos_integer()
  def bot_delay do
    @bot_delay_min + :rand.uniform(@bot_delay_max - @bot_delay_min + 1) - 1
  end

  @doc "Bornes du délai de l'IA, en millisecondes."
  @spec bot_delay_range() :: {pos_integer(), pos_integer()}
  def bot_delay_range, do: {@bot_delay_min, @bot_delay_max}

  def game(code), do: call(code, :game)
  def public_state(code), do: call(code, :public_state)
  def join(code, name, player_id), do: call(code, {:join, name, player_id})
  def start_game(code, player_id), do: call(code, {:start, player_id})
  def fill_bots(code, player_id), do: call(code, {:fill_bots, player_id})
  def roll(code, player_id), do: call(code, {:roll, player_id})
  def move(code, player_id, token), do: call(code, {:move, player_id, token})
  def leave(code, player_id), do: cast(code, {:leave, player_id})

  defp lookup(code) do
    case Registry.lookup(Ludo.GameRegistry, code) do
      [{pid, _}] -> {:ok, pid}
      [] -> :error
    end
  end

  defp call(code, message) do
    case lookup(code) do
      {:ok, pid} ->
        # Le salon peut disparaître entre la recherche dans le registre et
        # l'appel (fin de partie, nettoyage automatique) : un salon qui s'en va
        # doit répondre « introuvable », pas faire planter l'appelant.
        try do
          GenServer.call(pid, message, 5_000)
        catch
          :exit, {:noproc, _} -> {:error, :not_found}
          :exit, {:normal, _} -> {:error, :not_found}
          :exit, {:shutdown, _} -> {:error, :not_found}
          :exit, {:killed, _} -> {:error, :not_found}
        end

      :error ->
        {:error, :not_found}
    end
  end

  defp cast(code, message) do
    case lookup(code) do
      {:ok, pid} -> GenServer.cast(pid, message)
      :error -> :error
    end
  end

  # ---------------------------------------------------------------------------
  # Callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    code = Keyword.fetch!(opts, :code)
    Registry.register(Ludo.GameRegistry, code, nil)

    game =
      Game.new(
        code,
        Keyword.fetch!(opts, :mode),
        Keyword.fetch!(opts, :host_name),
        Keyword.fetch!(opts, :host_id)
      )

    state = %{game: game, bot_timer: nil, timeout_timer: nil}
    {:ok, after_change(state)}
  end

  @impl true
  def handle_call(:game, _from, state), do: {:reply, {:ok, state.game}, state}

  # Comme les autres appels : {:ok, état} ou {:error, raison}.
  def handle_call(:public_state, _from, state) do
    {:reply, {:ok, Game.public_state(state.game)}, state}
  end

  def handle_call({:join, name, player_id}, _from, state) do
    case Game.add_player(state.game, name, player_id) do
      {:ok, game, player, how} ->
        game = maybe_auto_start(game)
        state = commit(%{state | game: game})

        {:reply,
         {:ok, %{seat: player.seat, color: to_string(player.color), how: to_string(how)},
          Game.public_state(game)}, state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:start, player_id}, _from, state) do
    if host?(state.game, player_id) do
      reply(state, Game.start(state.game))
    else
      {:reply, {:error, :not_host}, state}
    end
  end

  def handle_call({:fill_bots, player_id}, _from, state) do
    if host?(state.game, player_id) and state.game.status == :waiting do
      game = state.game |> Game.fill_with_bots() |> maybe_auto_start()
      {:reply, {:ok, Game.public_state(game)}, commit(%{state | game: game})}
    else
      {:reply, {:error, :not_host}, state}
    end
  end

  def handle_call({:roll, player_id}, _from, state) do
    reply(state, Game.roll(state.game, player_id))
  end

  def handle_call({:move, player_id, token}, _from, state) do
    reply(state, Game.move(state.game, player_id, token))
  end

  @impl true
  def handle_cast({:leave, player_id}, state) do
    game = state.game

    game =
      case game.status do
        # Dans une partie en attente, libérer le siège pour de bon.
        :waiting -> Game.remove_player(game, player_id)
        _ -> Game.disconnect(game, player_id)
      end

    {:noreply, commit(%{state | game: game})}
  end

  @impl true
  def handle_info({:bot_tick, version}, %{game: %{version: version}} = state) do
    {:noreply, state |> bot_act() |> commit()}
  end

  def handle_info({:turn_timeout, version}, %{game: %{version: version}} = state) do
    {:noreply, state |> auto_play() |> commit()}
  end

  # Minuteur obsolète : un autre coup est arrivé entre-temps.
  def handle_info({kind, _stale}, state) when kind in [:bot_tick, :turn_timeout] do
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---------------------------------------------------------------------------
  # Interne
  # ---------------------------------------------------------------------------

  defp reply(state, {:ok, game, _events}) do
    {:reply, {:ok, Game.public_state(game)}, commit(%{state | game: game})}
  end

  defp reply(state, {:error, reason}), do: {:reply, {:error, reason}, state}

  defp host?(game, player_id) do
    case Enum.find(game.players, &(&1.seat == 0)) do
      nil -> false
      player -> player.id == player_id and player.kind == :human
    end
  end

  # Dès que tous les sièges sont pourvus, on démarre sans attendre.
  defp maybe_auto_start(%Game{status: :waiting} = game) do
    if length(game.players) >= game.seats do
      case Game.start(game) do
        {:ok, started} -> started
        {:error, _} -> game
      end
    else
      game
    end
  end

  defp maybe_auto_start(game), do: game

  defp bot_act(state) do
    game = state.game
    player = Game.current_player(game)

    cond do
      player == nil ->
        state

      game.dice == nil ->
        case Game.roll(game, player.id) do
          {:ok, game, _} -> %{state | game: game}
          _ -> state
        end

      true ->
        case Bot.choose_move(game) do
          nil ->
            state

          choice ->
            case Game.move(game, player.id, choice) do
              {:ok, game, _} -> %{state | game: game}
              _ -> state
            end
        end
    end
  end

  # Utilisé quand un joueur humain laisse son tour expirer : on joue à sa place
  # pour que la partie ne reste jamais figée.
  defp auto_play(state) do
    game = state.game
    player = Game.current_player(game)

    if player == nil do
      state
    else
      game =
        if game.dice == nil do
          case Game.roll(game, player.id) do
            {:ok, rolled, _} -> rolled
            _ -> game
          end
        else
          game
        end

      state = %{state | game: game}
      auto_move(state, player)
    end
  end

  defp auto_move(state, player) do
    case Game.legal_moves(state.game) do
      [] ->
        state

      moves ->
        case Game.move(state.game, player.id, Enum.random(moves)) do
          {:ok, game, _} -> %{state | game: game}
          _ -> state
        end
    end
  end

  # Programme la suite : coup d'IA, ou délai de sécurité pour un humain.
  defp after_change(state) do
    state = cancel_timers(state)
    game = state.game

    cond do
      game.status != :playing -> state
      Game.bot_turn?(game) -> schedule(state, :bot_tick, bot_delay())
      true -> schedule(state, :turn_timeout, @turn_timeout)
    end
  end

  defp schedule(state, kind, delay) do
    ref = Process.send_after(self(), {kind, state.game.version}, delay)

    case kind do
      :bot_tick -> %{state | bot_timer: ref}
      :turn_timeout -> %{state | timeout_timer: ref}
    end
  end

  defp cancel_timers(state) do
    if state.bot_timer, do: Process.cancel_timer(state.bot_timer)
    if state.timeout_timer, do: Process.cancel_timer(state.timeout_timer)
    %{state | bot_timer: nil, timeout_timer: nil}
  end

  # Publie le nouvel état et met à jour le lobby.
  defp commit(state) do
    state = after_change(state)

    Phoenix.PubSub.broadcast(
      @pubsub,
      topic(state.game.code),
      {:game_state, Game.public_state(state.game)}
    )

    Lobby.sync(state.game.code, state.game)
    state
  end
end
