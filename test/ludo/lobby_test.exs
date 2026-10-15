defmodule Ludo.LobbyTest do
  # Le lobby et le superviseur sont des singletons : ces tests ne doivent pas
  # tourner en parallèle avec d'autres qui créeraient des parties.
  use ExUnit.Case, async: false

  alias Ludo.{Game, GameServer, Lobby}

  setup do
    reset_lobby()
    :ok
  end

  defp reset_lobby do
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Ludo.GameSupervisor) do
      DynamicSupervisor.terminate_child(Ludo.GameSupervisor, pid)
    end

    # Laisse le lobby traiter les :DOWN avant de continuer.
    wait_until(fn -> Lobby.list_games() == [] end)
  end

  defp wait_until(fun, timeout \\ 2_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    cond do
      fun.() ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        :timeout

      true ->
        Process.sleep(20)
        do_wait(fun, deadline)
    end
  end

  defp unique_id, do: "player-" <> Integer.to_string(:erlang.unique_integer([:positive]))

  describe "création" do
    test "génère un code de 4 caractères sans ambiguïté" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", unique_id())

      assert String.length(code) == 4
      assert code =~ ~r/^[A-Z2-9]+$/
      # 0/O et 1/I sont exclus pour rester lisibles au téléphone
      refute code =~ ~r/[01OI]/
    end

    test "deux parties n'ont jamais le même code" do
      codes = for _ <- 1..25, do: elem(Lobby.create_game(:p2, "Alice", unique_id()), 1)
      assert length(Enum.uniq(codes)) == 25
    end

    test "refuse un pseudo vide et un identifiant invalide" do
      assert {:error, :invalid_name} = Lobby.create_game(:p2, "   ", unique_id())
      assert {:error, :invalid_player_id} = Lobby.create_game(:p2, "Alice", "court")
      assert {:error, :invalid_player_id} = Lobby.create_game(:p2, "Alice", nil)
    end

    test "refuse un mode inconnu" do
      assert {:error, _} = Lobby.create_game("triche", "Alice", unique_id())
    end

    test "le mode solo démarre immédiatement et n'apparaît pas dans la liste" do
      {:ok, code} = Lobby.create_game(:vs_ai, "Alice", unique_id())

      {:ok, meta} = Lobby.get_game(code)
      assert meta.status == "playing"
      assert meta.seats == 4
      assert meta.taken == 4

      refute Enum.any?(Lobby.list_games(), &(&1.code == code))
    end
  end

  describe "liste et disponibilité" do
    test "une partie en attente apparaît dans la liste" do
      {:ok, code} = Lobby.create_game(:p4, "Alice", unique_id())

      entry = Enum.find(Lobby.list_games(), &(&1.code == code))
      assert entry
      assert entry.mode == "p4"
      assert entry.mode_label == "4 joueurs"
      assert entry.seats == 4
      assert entry.taken == 1
      assert entry.free_seats == 3
      assert entry.host == "Alice"
    end

    test "joinable? accepte une place libre et refuse le reste" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", unique_id())

      assert :ok = Lobby.joinable?(code, unique_id())
      assert {:error, :not_found} = Lobby.joinable?("ZZZZ", unique_id())

      # la partie démarre dès que tous les sièges sont pris
      assert :ok = Lobby.joinable?(code, unique_id())
      {:ok, _seat, _state} = GameServer.join(code, "Bob", unique_id())
      assert {:error, :already_started} = Lobby.joinable?(code, unique_id())
    end

    test "un joueur déjà installé peut revenir même après le début" do
      id = unique_id()
      {:ok, code} = Lobby.create_game(:p2, "Alice", id)
      {:ok, _seat, _state} = GameServer.join(code, "Bob", unique_id())

      {:ok, meta} = Lobby.get_game(code)
      assert meta.status == "playing"

      assert :ok = Lobby.joinable?(code, id)
    end

    test "la liste se met à jour quand un joueur rejoint" do
      {:ok, code} = Lobby.create_game(:p4, "Alice", unique_id())
      Lobby.subscribe()

      {:ok, _seat, _state} = GameServer.join(code, "Bob", unique_id())
      assert_receive {:games, games}, 1_000

      entry = Enum.find(games, &(&1.code == code))
      assert entry.taken == 2
    end
  end

  describe "démarrage automatique" do
    test "la partie démarre quand le dernier siège est pris" do
      {:ok, code} = Lobby.create_game(:p3, "Alice", unique_id())

      {:ok, _s, state} = GameServer.join(code, "Bob", unique_id())
      assert state.status == "waiting"

      {:ok, _s, state} = GameServer.join(code, "Carol", unique_id())
      assert state.status == "playing"
      assert state.seats == 3
      assert length(state.players) == 3
      assert state.turn == 0
    end

    test "l'hôte peut compléter avec des IA et démarrer" do
      host = unique_id()
      {:ok, code} = Lobby.create_game(:p4, "Alice", host)

      assert {:ok, state} = GameServer.fill_bots(code, host)
      assert state.status == "playing"
      assert length(state.players) == 4
      assert Enum.count(state.players, &(&1.kind == "bot")) == 3
    end

    test "un simple joueur ne peut pas compléter avec des IA" do
      host = unique_id()
      other = unique_id()
      {:ok, code} = Lobby.create_game(:p4, "Alice", host)
      {:ok, _s, _state} = GameServer.join(code, "Bob", other)

      assert {:error, :not_host} = GameServer.fill_bots(code, other)
    end
  end

  describe "cycle de vie" do
    test "quitter une partie en attente libère le siège" do
      id = unique_id()
      {:ok, code} = Lobby.create_game(:p4, "Alice", id)
      {:ok, _s, _state} = GameServer.join(code, "Bob", unique_id())

      assert elem(Lobby.get_game(code), 1).taken == 2

      GameServer.leave(code, id)
      wait_until(fn -> elem(Lobby.get_game(code), 1).taken == 1 end)

      assert elem(Lobby.get_game(code), 1).taken == 1
    end

    test "quitter une partie commencée ne retire pas le joueur" do
      id = unique_id()
      {:ok, code} = Lobby.create_game(:p2, "Alice", id)
      {:ok, _s, _state} = GameServer.join(code, "Bob", unique_id())

      GameServer.leave(code, id)
      Process.sleep(80)

      assert elem(Lobby.get_game(code), 1).taken == 2
      assert {:ok, state} = GameServer.public_state(code)
      refute Enum.find(state.players, &(&1.seat == 0)).connected
    end

    test "la fermeture retire la partie du registre" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", unique_id())
      assert {:ok, _} = Lobby.get_game(code)

      Lobby.close(code)
      wait_until(fn -> Lobby.get_game(code) == :error end)
      assert :error = Lobby.get_game(code)
    end

    test "une partie supprimée n'est plus joignable" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", unique_id())
      Lobby.close(code)
      wait_until(fn -> Lobby.get_game(code) == :error end)

      assert {:error, :not_found} = GameServer.join(code, "Bob", unique_id())
    end
  end

  describe "le lobby ne divulgue pas les identifiants" do
    test "l'entrée publique ne contient aucun player_id" do
      id = unique_id()
      {:ok, code} = Lobby.create_game(:p2, "Alice", id)

      entry = Enum.find(Lobby.list_games(), &(&1.code == code))
      refute inspect(entry) =~ id
    end

    test "les métadonnées internes conservent l'identifiant pour la reconnexion" do
      id = unique_id()
      {:ok, code} = Lobby.create_game(:p4, "Alice", id)
      assert :ok = Lobby.joinable?(code, id)
    end
  end

  describe "modes" do
    test "chaque mode a le bon nombre de sièges" do
      assert Game.seats_for(:vs_ai) == 4
      assert Game.seats_for(:p2) == 2
      assert Game.seats_for(:p3) == 3
      assert Game.seats_for(:p4) == 4
    end

    test "un mode à 2 places refuse un troisième joueur" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", unique_id())
      {:ok, _s, state} = GameServer.join(code, "Bob", unique_id())
      assert state.status == "playing"

      assert {:error, _} = GameServer.join(code, "Carol", unique_id())
    end
  end
end
