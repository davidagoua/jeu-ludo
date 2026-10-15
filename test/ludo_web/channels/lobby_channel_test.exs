defmodule LudoWeb.LobbyChannelTest do
  use LudoWeb.ChannelCase, async: false

  alias Ludo.Lobby
  alias LudoWeb.{GameSocket, LobbyChannel}

  defp id, do: "player-" <> Integer.to_string(:erlang.unique_integer([:positive]))

  defp join_lobby do
    {:ok, _reply, socket} = socket(GameSocket) |> subscribe_and_join(LobbyChannel, "lobby", %{})
    socket
  end

  describe "connexion" do
    test "reçoit la liste des parties et les modes" do
      socket = join_lobby()
      assert_push "games", %{games: games, modes: modes}

      assert games == []
      # les charges utiles de poussée gardent les clés atom d'origine
      assert Enum.map(modes, & &1[:key]) == ["vs_ai", "p2", "p3", "p4"]
      assert Enum.map(modes, & &1[:seats]) == [4, 2, 3, 4]
      assert Enum.all?(modes, &is_binary(&1[:label]))
      assert is_pid(socket.channel_pid)
    end
  end

  describe "création" do
    test "crée une partie et renvoie son code" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice", mode: "p2", player_id: id()})
      assert_reply ref, :ok, %{code: code}

      assert String.length(code) == 4
      assert {:ok, meta} = Lobby.get_game(code)
      assert meta.mode == "p2"
      assert meta.host == "Alice"
    end

    test "diffuse la nouvelle partie aux autres visiteurs" do
      _socket = join_lobby()
      other = join_lobby()

      # on vide la file des deux messages d'accueil (un par socket) : sinon
      # l'assertion suivante pourrait retomber sur une liste périmée.
      assert_push "games", _
      assert_push "games", _

      ref = push(other, "create", %{name: "Bob", mode: "p3", player_id: id()})
      assert_reply ref, :ok, %{code: code}

      assert_push "games", %{games: games}
      assert Enum.any?(games, &(&1.code == code))
    end

    test "refuse un mode inconnu" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice", mode: "triche", player_id: id()})
      assert_reply ref, :error, %{reason: "unknown_mode"}
    end

    test "refuse un mode qui est un atome existant mais pas un mode" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice", mode: "ok", player_id: id()})
      assert_reply ref, :error, %{reason: "unknown_mode"}
    end

    test "refuse un pseudo vide" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "   ", mode: "p2", player_id: id()})
      assert_reply ref, :error, %{reason: "invalid_name", message: message}
      assert message =~ "pseudo"
    end

    test "refuse un identifiant de joueur invalide" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice", mode: "p2", player_id: "x"})
      assert_reply ref, :error, %{reason: "invalid_player_id"}
    end
  end

  describe "vérification d'un code" do
    test "accepte un code valide" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", id())

      socket = join_lobby()
      ref = push(socket, "check", %{code: code, player_id: id()})
      assert_reply ref, :ok, %{code: ^code}
    end

    test "accepte un code en minuscules" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", id())

      socket = join_lobby()
      ref = push(socket, "check", %{code: String.downcase(code), player_id: id()})
      assert_reply ref, :ok, %{code: ^code}
    end

    test "refuse un code inconnu" do
      socket = join_lobby()
      ref = push(socket, "check", %{code: "ZZZZ", player_id: id()})
      assert_reply ref, :error, %{reason: "not_found"}
    end

    test "refuse une partie déjà lancée" do
      {:ok, code} = Lobby.create_game(:p2, "Alice", id())
      {:ok, _seat, _state} = Ludo.GameServer.join(code, "Bob", id())

      socket = join_lobby()
      ref = push(socket, "check", %{code: code, player_id: id()})
      assert_reply ref, :error, %{reason: "already_started"}
    end
  end

  describe "rejoindre rapidement" do
    test "signale l'absence de partie" do
      socket = join_lobby()
      ref = push(socket, "quick_join", %{player_id: id()})
      assert_reply ref, :error, %{reason: "no_game"}
    end

    test "renvoie une partie ouverte" do
      {:ok, code} = Lobby.create_game(:p4, "Alice", id())

      socket = join_lobby()
      ref = push(socket, "quick_join", %{player_id: id()})
      assert_reply ref, :ok, %{code: ^code}
    end

    test "privilégie la partie la plus remplie" do
      {:ok, vide} = Lobby.create_game(:p4, "Alice", id())
      {:ok, pleine} = Lobby.create_game(:p4, "Bob", id())
      {:ok, _seat, _state} = Ludo.GameServer.join(pleine, "Carol", id())

      socket = join_lobby()
      ref = push(socket, "quick_join", %{player_id: id()})
      assert_reply ref, :ok, %{code: ^pleine}
      refute vide == pleine
    end
  end

  describe "robustesse" do
    test "un événement inconnu ne casse pas le canal" do
      socket = join_lobby()
      ref = push(socket, "nimportequoi", %{})
      assert_reply ref, :error, %{reason: "bad_request"}

      # le canal répond toujours
      ref = push(socket, "quick_join", %{player_id: id()})
      assert_reply ref, :error, %{reason: "no_game"}
    end

    test "une charge utile incomplète est refusée proprement" do
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice"})
      assert_reply ref, :error, %{reason: "bad_request"}

      # sans clé « code », l'événement ne correspond à aucune clause : refus
      ref = push(socket, "check", %{})
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    test "le canal survit à un mode atome existant dans la VM" do
      # non-régression : `String.to_existing_atom/1` aurait accepté « red »
      socket = join_lobby()
      ref = push(socket, "create", %{name: "Alice", mode: "red", player_id: id()})
      assert_reply ref, :error, %{reason: "unknown_mode"}

      ref = push(socket, "create", %{name: "Alice", mode: "base", player_id: id()})
      assert_reply ref, :error, %{reason: "unknown_mode"}
    end
  end
end
