defmodule Ludo.Lobby do
  @moduledoc """
  Registre des parties en cours.

  Le lobby est le seul endroit qui connaît la liste des parties : il génère les
  codes, démarre un `Ludo.GameServer` par partie (sous un `DynamicSupervisor`),
  tient à jour les métadonnées affichées sur la page d'accueil, et diffuse la
  liste à tous les visiteurs connectés.

  Les parties vivent en mémoire : aucune base de données n'est nécessaire, ce qui
  rend le déploiement (Docker) trivial. Toute la partie tient dans un processus
  par salon, et un `Registry` permet de retrouver le processus depuis son code.
  """

  use GenServer

  require Logger

  alias Ludo.{Game, GameServer}

  @pubsub Ludo.PubSub
  # Préfixé pour ne jamais coïncider avec le nom d'un sujet de canal Phoenix.
  @lobby_topic "ludo:lobby"
  @alphabet ~w(A B C D E F G H J K L M N P Q R S T U V W X Y Z 2 3 4 5 6 7 8 9)
  @code_length 4
  @cleanup_interval :timer.seconds(30)
  @finished_ttl :timer.minutes(5)
  @waiting_ttl :timer.minutes(45)
  @abandoned_ttl :timer.minutes(10)

  # ---------------------------------------------------------------------------
  # API publique
  # ---------------------------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Crée une partie et y installe l'hôte.

  Renvoie `{:ok, code}` ou `{:error, raison}`.
  """
  def create_game(mode, name, player_id) do
    GenServer.call(__MODULE__, {:create_game, mode, name, player_id})
  end

  @doc "Liste des parties rejoignables, pour la page d'accueil."
  def list_games do
    GenServer.call(__MODULE__, :list_games)
  end

  @doc "Métadonnées d'une partie."
  def get_game(code) do
    GenServer.call(__MODULE__, {:get_game, code})
  end

  @doc """
  Vérifie qu'une partie existe et qu'il reste de la place.

  Le siège n'est réellement attribué qu'à l'arrivée dans le salon
  (`Ludo.GameServer.join/3`), qui est le seul écrivain de l'état.
  """
  def joinable?(code, player_id) do
    GenServer.call(__MODULE__, {:joinable?, code, player_id})
  end

  @doc "Met à jour les métadonnées après un changement d'état du salon."
  def sync(code, %Game{} = game) do
    GenServer.cast(__MODULE__, {:sync, code, game})
  end

  @doc "Retire une partie du registre (le processus est arrêté par le superviseur)."
  def close(code) do
    GenServer.cast(__MODULE__, {:close, code})
  end

  @doc "S'abonner aux mises à jour de la liste des parties."
  def subscribe do
    Phoenix.PubSub.subscribe(@pubsub, @lobby_topic)
  end

  @doc "Diffuse la liste courante (utile après une action locale)."
  def broadcast_list do
    GenServer.cast(__MODULE__, :broadcast_list)
  end

  # ---------------------------------------------------------------------------
  # Callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_opts) do
    schedule_cleanup()
    {:ok, %{games: %{}, monitors: %{}}}
  end

  @impl true
  def handle_call({:create_game, mode, name, player_id}, _from, state) do
    with {:ok, mode} <- Game.parse_mode(mode),
         {:ok, name} <- validate_name(name),
         {:ok, player_id} <- validate_player_id(player_id) do
      code = unique_code(state.games)

      case start_game_server(code, mode, name, player_id) do
        {:ok, pid, game} ->
          ref = Process.monitor(pid)
          meta = build_meta(code, pid, game)
          state = put_in(state.games[code], meta)
          state = put_in(state.monitors[ref], code)
          broadcast(state)
          {:reply, {:ok, code}, state}

        {:error, reason} ->
          {:reply, {:error, reason}, state}
      end
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:list_games, _from, state) do
    {:reply, public_list(state), state}
  end

  def handle_call({:get_game, code}, _from, state) do
    case Map.fetch(state.games, code) do
      {:ok, meta} -> {:reply, {:ok, public_entry(meta)}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call({:joinable?, code, player_id}, _from, state) do
    reply =
      case Map.fetch(state.games, code) do
        :error ->
          {:error, :not_found}

        {:ok, meta} ->
          # `free_seats` n'existe que sur l'entrée publique : ici on le recalcule.
          free_seats = meta.seats - length(meta.players)

          cond do
            reconnect?(meta, player_id) -> :ok
            meta.status != :waiting -> {:error, :already_started}
            free_seats <= 0 -> {:error, :full}
            true -> :ok
          end
      end

    {:reply, reply, state}
  end

  @impl true
  def handle_cast({:sync, code, %Game{} = game}, state) do
    case Map.fetch(state.games, code) do
      :error ->
        {:noreply, state}

      {:ok, meta} ->
        meta = %{
          meta
          | status: game.status,
            seats: game.seats,
            players: players_summary(game),
            host: host_name(game),
            updated_at: now()
        }

        state = put_in(state.games[code], meta)
        broadcast(state)
        {:noreply, state}
    end
  end

  def handle_cast({:close, code}, state) do
    {:noreply, remove_game(state, code)}
  end

  def handle_cast(:broadcast_list, state) do
    broadcast(state)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, ref) do
      {nil, _} ->
        {:noreply, state}

      {code, monitors} ->
        state = %{state | monitors: monitors, games: Map.delete(state.games, code)}
        broadcast(state)
        {:noreply, state}
    end
  end

  def handle_info(:cleanup, state) do
    schedule_cleanup()
    {:noreply, %{state | games: prune(state.games)}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---------------------------------------------------------------------------
  # Interne
  # ---------------------------------------------------------------------------

  defp start_game_server(code, mode, name, player_id) do
    opts = [code: code, mode: mode, host_name: name, host_id: player_id]

    case DynamicSupervisor.start_child(Ludo.GameSupervisor, {GameServer, opts}) do
      {:ok, pid} ->
        case GameServer.game(code) do
          {:ok, game} -> {:ok, pid, game}
          _ -> {:error, :game_unavailable}
        end

      {:error, reason} ->
        Logger.error("impossible de démarrer le salon #{code} : #{inspect(reason)}")
        {:error, :game_unavailable}
    end
  end

  defp build_meta(code, pid, game) do
    %{
      code: code,
      pid: pid,
      mode: game.mode,
      seats: game.seats,
      status: game.status,
      players: players_summary(game),
      host: host_name(game),
      created_at: now(),
      updated_at: now()
    }
  end

  # `id` sert à reconnaître un joueur qui revient. Il reste interne au lobby :
  # `public_entry/1` ne le transmet jamais au navigateur.
  defp players_summary(game) do
    Enum.map(game.players, fn p ->
      %{id: p.id, name: p.name, color: p.color, kind: p.kind, seat: p.seat}
    end)
  end

  defp host_name(game) do
    case Enum.find(game.players, &(&1.kind == :human)) do
      nil -> "?"
      player -> player.name
    end
  end

  defp reconnect?(meta, player_id) do
    is_binary(player_id) and Enum.any?(meta.players, &(Map.get(&1, :id) == player_id))
  end

  defp public_list(state) do
    state.games
    |> Map.values()
    |> Enum.filter(fn meta ->
      meta.status == :waiting and meta.seats - length(meta.players) > 0
    end)
    |> Enum.map(&public_entry/1)
    |> Enum.sort_by(& &1.created_at_ms)
  end

  defp public_entry(meta) do
    free = meta.seats - length(meta.players)

    %{
      code: meta.code,
      mode: to_string(meta.mode),
      mode_label: Game.mode_label(meta.mode),
      seats: meta.seats,
      taken: length(meta.players),
      free_seats: free,
      status: to_string(meta.status),
      host: meta.host,
      players:
        Enum.map(
          meta.players,
          &%{name: &1.name, color: to_string(&1.color), kind: to_string(&1.kind)}
        ),
      created_at_ms: DateTime.to_unix(meta.created_at, :millisecond)
    }
  end

  defp broadcast(state) do
    Phoenix.PubSub.broadcast(@pubsub, @lobby_topic, {:games, public_list(state)})
  end

  defp unique_code(games) do
    code = for _ <- 1..@code_length, into: "", do: Enum.random(@alphabet)
    if Map.has_key?(games, code), do: unique_code(games), else: code
  end

  defp validate_name(name) do
    case Game.clean_name(name) do
      "" -> {:error, :invalid_name}
      clean -> {:ok, clean}
    end
  end

  defp validate_player_id(id) when is_binary(id) and byte_size(id) in 8..64, do: {:ok, id}
  defp validate_player_id(_), do: {:error, :invalid_player_id}

  defp prune(games) do
    cutoff = fn ms -> DateTime.add(now(), -ms, :millisecond) end
    finished_before = cutoff.(@finished_ttl)
    waiting_before = cutoff.(@waiting_ttl)
    abandoned_before = cutoff.(@abandoned_ttl)

    games
    |> Enum.reject(fn {_code, meta} ->
      cond do
        meta.status == :finished and DateTime.compare(meta.updated_at, finished_before) == :lt ->
          true

        meta.status == :waiting and DateTime.compare(meta.created_at, waiting_before) == :lt ->
          true

        no_human?(meta) and DateTime.compare(meta.updated_at, abandoned_before) == :lt ->
          true

        true ->
          false
      end
    end)
    |> Map.new()
  end

  defp no_human?(meta), do: Enum.all?(meta.players, &(&1.kind == :bot))

  defp schedule_cleanup, do: Process.send_after(self(), :cleanup, @cleanup_interval)

  defp remove_game(state, code) do
    case Map.fetch(state.games, code) do
      :error ->
        state

      {:ok, meta} ->
        # On arrête le salon ; le :DOWN qui suit sera ignoré (déjà retiré).
        if Process.alive?(meta.pid),
          do: DynamicSupervisor.terminate_child(Ludo.GameSupervisor, meta.pid)

        monitors = for {ref, c} <- state.monitors, c != code, into: %{}, do: {ref, c}
        state = %{state | games: Map.delete(state.games, code), monitors: monitors}
        broadcast(state)
        state
    end
  end

  defp now, do: DateTime.utc_now()
end
