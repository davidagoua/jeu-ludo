defmodule LudoWeb.GameChannelTest do
  use LudoWeb.ChannelCase, async: false

  alias Ludo.Lobby
  alias LudoWeb.{GameChannel, GameSocket}

  defp id, do: "player-" <> Integer.to_string(:erlang.unique_integer([:positive]))

  defp create(mode, name \\ "Alice") do
    host = id()
    {:ok, code} = Lobby.create_game(mode, name, host)
    {code, host}
  end

  # `join` est déjà importé par Phoenix.ChannelTest : on préfixe le nôtre.
  defp join_game(code, name, player_id) do
    socket(GameSocket)
    |> subscribe_and_join(GameChannel, "game:#{code}", %{name: name, player_id: player_id})
  end

  # Joue un coup pour le joueur humain (siège 0) via le canal.
  # Renvoie true dès que la main n'est plus à l'humain.
  defp play_human_turn(socket, code) do
    {:ok, state} = Ludo.GameServer.public_state(code)

    cond do
      state.status != "playing" ->
        true

      state.turn_is_bot ->
        true

      true ->
        if state.dice == nil do
          ref = push(socket, "roll", %{})
          assert_reply ref, :ok, _payload
        else
          case state.legal_moves do
            [] ->
              :ok

            [token | _] ->
              ref = push(socket, "move", %{token: token})
              assert_reply ref, :ok, _payload
          end
        end

        false
    end
  end

  describe "connexion au salon" do
    test "renvoie la géométrie, le siège et l'état" do
      {code, host} = create(:p2)
      {:ok, reply, _socket} = join_game(code, "Alice", host)

      assert reply.seat.seat == 0
      assert reply.seat.color == "red"
      # l'hôte est déjà installé par la création : il reprend son siège
      assert reply.seat.how == "rejoined"
      assert reply.state.code == code
      assert reply.state.status == "waiting"

      # la réponse de `join` n'est pas sérialisée : les clés restent des atomes
      geo = reply.geometry
      assert geo.ring_size == 56
      assert length(geo.ring) == 56
      assert length(geo.home_columns[:red]) == 5
      assert length(geo.bases[:blue]) == 4
      assert length(geo.center) == 5
      assert geo.safe_indexes == [0, 8, 14, 22, 28, 36, 42, 50]
      assert geo.starts[:red] == 0
      assert geo.colors[:red] =~ "#"
      assert Enum.sort(Map.keys(geo.starts)) == [:blue, :green, :red, :yellow]
    end

    test "la géométrie envoyée reste sérialisable en JSON" do
      {code, host} = create(:p2)
      {:ok, reply, _socket} = join_game(code, "Alice", host)

      assert {:ok, json} = Jason.encode(reply.geometry)
      decoded = Jason.decode!(json)
      # après passage en JSON, les clés deviennent des chaînes : c'est ce que
      # verra le navigateur.
      assert decoded["starts"]["red"] == 0
      assert length(decoded["ring"]) == 56
    end

    test "les joueurs suivants prennent les sièges dans l'ordre" do
      # l'hôte de `create` occupe déjà le siège 0 (rouge)
      {code, _host} = create(:p4)

      {:ok, reply1, _} = join_game(code, "Alice", id())
      assert reply1.seat.color == "green"
      assert reply1.seat.seat == 1
      assert reply1.seat.how == "joined"

      {:ok, reply2, _} = join_game(code, "Bob", id())
      assert reply2.seat.color == "yellow"
      assert reply2.seat.seat == 2

      {:ok, reply3, _} = join_game(code, "Carol", id())
      assert reply3.seat.color == "blue"
      assert reply3.seat.seat == 3
    end

    test "un joueur qui revient reprend son siège" do
      {code, host} = create(:p4)
      {:ok, first, _} = join_game(code, "Alice", host)
      assert first.seat.color == "red"

      {:ok, again, _} = join_game(code, "Alice", host)
      assert again.seat.color == "red"
      assert again.seat.how == "rejoined"
      assert again.seat.seat == 0
      # aucun siège supplémentaire n'a été consommé
      assert length(again.state.players) == 1
    end

    test "la partie démarre toute seule quand le dernier siège est pris" do
      {code, host} = create(:p2)
      {:ok, _reply, _socket} = join_game(code, "Alice", host)

      {:ok, reply, _socket} = join_game(code, "Bob", id())
      assert reply.state.status == "playing"
      assert length(reply.state.players) == 2
    end

    test "refuse un code inexistant" do
      assert {:error, %{reason: "not_found"}} = join_game("ZZZZ", "Alice", id())
    end

    test "refuse un joueur de trop" do
      {code, host} = create(:p2)
      {:ok, _r, _s} = join_game(code, "Alice", host)
      {:ok, _r, _s} = join_game(code, "Bob", id())

      assert {:error, %{reason: "already_started"}} = join_game(code, "Carol", id())
    end
  end

  describe "déroulement d'une partie" do
    setup do
      {code, host} = create(:p2)
      {:ok, reply, socket} = join_game(code, "Alice", host)
      bob = id()
      {:ok, _r, bob_socket} = join_game(code, "Bob", bob)

      %{
        code: code,
        host: host,
        bob: bob,
        socket: socket,
        bob_socket: bob_socket,
        state: reply.state
      }
    end

    test "lancer le dé hors de son tour est refusé", %{bob_socket: bob_socket} do
      ref = push(bob_socket, "roll", %{})
      assert_reply ref, :error, %{reason: "not_your_turn", message: message}
      assert message =~ "tour"
    end

    test "le joueur courant peut lancer le dé", %{socket: socket} do
      ref = push(socket, "roll", %{})
      assert_reply ref, :ok, %{state: state}

      # soit le dé attend un choix, soit le tour a déjà été résolu
      assert state.status == "playing"
      assert state.dice == nil or state.dice in 1..6
    end

    test "déplacer un pion sans avoir lancé le dé est refusé", %{socket: socket} do
      ref = push(socket, "move", %{token: 0})
      assert_reply ref, :error, %{reason: reason}
      assert reason in ["no_dice", "illegal_move"]
    end

    test "un index de pion hors bornes est refusé", %{socket: socket} do
      ref = push(socket, "move", %{token: 99})
      assert_reply ref, :error, %{reason: reason}
      # sans dé lancé, le refus arrive avant la validation de l'index
      assert reason in ["no_dice", "illegal_move"]
    end

    test "un événement inconnu est refusé", %{socket: socket} do
      ref = push(socket, "triche", %{})
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    test "l'état peut être redemandé", %{socket: socket, code: code} do
      ref = push(socket, "state", %{})
      assert_reply ref, :ok, %{state: state}
      assert state.code == code
      assert length(state.players) == 2
    end

    test "les autres joueurs reçoivent le nouvel état", %{socket: socket} do
      ref = push(socket, "roll", %{})
      assert_reply ref, :ok, _payload

      assert_push "state", pushed
      assert pushed.status == "playing"
      assert is_list(pushed.players)
      assert is_list(pushed.log)
      assert is_integer(pushed.version)
    end

    test "aucun identifiant de joueur ne circule dans l'état", %{
      socket: socket,
      host: host,
      bob: bob
    } do
      ref = push(socket, "state", %{})
      assert_reply ref, :ok, %{state: state}

      json = Jason.encode!(state)
      refute json =~ host
      refute json =~ bob
    end

    test "seul l'hôte peut compléter avec des IA" do
      {code, host} = create(:p4)
      {:ok, _r, host_socket} = join_game(code, "Dan", host)
      {:ok, _r, other_socket} = join_game(code, "Eve", id())

      ref = push(other_socket, "fill_bots", %{})
      assert_reply ref, :error, %{reason: "not_host"}

      ref = push(host_socket, "fill_bots", %{})
      assert_reply ref, :ok, %{state: state}
      assert state.status == "playing"
      assert length(state.players) == 4
      assert Enum.count(state.players, &(&1.kind == "bot")) == 2
    end
  end

  describe "partie en solo" do
    test "la partie contre l'IA démarre immédiatement" do
      {code, host} = create(:vs_ai)
      {:ok, reply, _socket} = join_game(code, "Alice", host)

      assert reply.state.status == "playing"
      assert length(reply.state.players) == 4
      assert Enum.count(reply.state.players, &(&1.kind == "bot")) == 3
      assert reply.state.turn == 0
      assert reply.state.turn_is_bot == false
    end

    test "après le coup du joueur, une IA joue toute seule" do
      {code, host} = create(:vs_ai)
      {:ok, _reply, socket} = join_game(code, "Alice", host)

      # Alice joue jusqu'à ce que la main passe à une IA.
      assert wait_until(fn -> play_human_turn(socket, code) end, 5_000),
             "l'humain n'a pas réussi à passer la main"

      {:ok, before_bot} = Ludo.GameServer.public_state(code)
      assert before_bot.turn_is_bot, "la main aurait dû passer à une IA"

      # Plus aucune action du client : c'est le serveur qui doit jouer.
      assert wait_until(
               fn ->
                 case Ludo.GameServer.public_state(code) do
                   {:ok, state} -> state.version > before_bot.version
                   _ -> false
                 end
               end,
               5_000
             ),
             "l'IA n'a pas joué d'elle-même"
    end
  end
end
