defmodule Ludo.GameTest do
  use ExUnit.Case, async: true

  alias Ludo.{Board, Game}

  # --- aides ---------------------------------------------------------------
  #
  # Les tests ne codent jamais une position « en dur » : ils la calculent à
  # partir de l'index d'anneau visé, si bien qu'un changement de géométrie du
  # plateau ne les casse pas.

  defp new_game(mode \\ :p2, host \\ "Alice", id \\ "a") do
    Game.new("TEST", mode, host, id)
  end

  defp two_players do
    game = new_game()
    {:ok, game, _player, :joined} = Game.add_player(game, "Bob", "b")
    game
  end

  defp started(mode \\ :p2) do
    game = if mode == :p2, do: two_players(), else: new_game(mode)

    case Game.start(game) do
      {:ok, game} -> game
      {:error, :already_started} -> game
    end
  end

  defp set_tokens(game, color, tokens) do
    %{game | tokens: Map.put(game.tokens, color, tokens)}
  end

  defp finish, do: Board.finish()

  # Couleur du second siège : c'est l'adversaire dans une partie à 2.
  defp second, do: Board.seat_color(1)

  # Position relative à laquelle `player` occupe l'index d'anneau donné.
  defp position_at(player, ring_index) do
    rem(ring_index - Board.start_index(player) + Board.ring_size(), Board.ring_size())
  end

  # Index d'anneau atteint par `player` depuis la position `position`.
  defp index_at(player, position), do: Board.ring_index(player, position)

  # --- création ------------------------------------------------------------

  # Le serveur résout lui-même les lancers que le joueur ne peut pas jouer
  # (aucun coup, un seul, ou trois 6) : les simulations font de même.
  defp resolve(game) do
    if Game.auto_resolve?(game) do
      {:ok, resumed, _events} = Game.resolve_roll(game)
      resumed
    else
      game
    end
  end

  describe "création de partie" do
    test "l'hôte occupe le siège 0 et la couleur rouge" do
      game = new_game()
      assert game.status == :waiting
      assert game.seats == 2
      assert [player] = game.players
      assert player.seat == 0
      assert player.color == :red
      assert player.name == "Alice"
      assert player.kind == :human
      assert game.tokens == %{red: [:base, :base, :base, :base]}
    end

    test "le mode solo installe les IA et démarre immédiatement" do
      game = new_game(:vs_ai)
      assert game.status == :playing
      assert game.seats == 4
      assert length(game.players) == 4
      assert Game.human_count(game) == 1
      assert Enum.count(game.players, &(&1.kind == :bot)) == 3
      assert Enum.map(game.players, & &1.seat) == [0, 1, 2, 3]
      # ordre horaire du plateau : rouge, bleu, jaune, vert
      assert Enum.map(game.players, & &1.color) == [:red, :blue, :yellow, :green]
    end

    test "les sièges se remplissent dans l'ordre" do
      game = new_game(:p4)
      assert [%{seat: 0}] = game.players

      {:ok, game, p2, :joined} = Game.add_player(game, "Bob", "b")
      {:ok, game, p3, :joined} = Game.add_player(game, "Carol", "c")
      {:ok, game, p4, :joined} = Game.add_player(game, "Dan", "d")

      assert [p2.seat, p3.seat, p4.seat] == [1, 2, 3]
      assert [p2.color, p3.color, p4.color] == [:blue, :yellow, :green]
      assert {:error, :full} = Game.add_player(game, "Eve", "e")
    end

    test "un joueur qui revient avec le même identifiant reprend son siège" do
      game = new_game(:p4)
      {:ok, game, _bob, :joined} = Game.add_player(game, "Bob", "b")
      {:ok, game, back, :rejoined} = Game.add_player(game, "Bob", "b")
      assert back.seat == 1
      assert back.color == :blue
      assert length(game.players) == 2
    end

    test "impossible de rejoindre une partie déjà commencée avec un nouvel identifiant" do
      game = started()
      assert {:error, :already_started} = Game.add_player(game, "Zoe", "z")
    end

    test "les sièges libres peuvent être complétés par des IA" do
      game = new_game(:p4)
      assert Game.free_seats(game) == 3
      game = Game.fill_with_bots(game)
      assert Game.free_seats(game) == 0
      assert length(game.players) == 4
      assert {:ok, game} = Game.start(game)
      assert game.status == :playing
    end

    test "on ne démarre pas avec des sièges vides" do
      assert {:error, :not_enough_players} = Game.start(new_game(:p4))
    end

    test "les modes sont exposés pour le formulaire" do
      modes = Game.modes_list()
      assert Enum.map(modes, & &1.key) == ["vs_ai", "p2", "p3", "p4"]
      assert Enum.map(modes, & &1.seats) == [4, 2, 3, 4]
      assert Enum.all?(modes, &(is_binary(&1.label) and is_binary(&1.hint)))
    end

    test "parse_mode valide les entrées" do
      assert {:ok, :p2} = Game.parse_mode("p2")
      assert {:ok, :vs_ai} = Game.parse_mode("vs_ai")
      assert {:ok, :p4} = Game.parse_mode(:p4)
      # un atome existant mais qui n'est pas un mode doit être refusé
      assert {:error, :unknown_mode} = Game.parse_mode("triche")
      assert {:error, :unknown_mode} = Game.parse_mode("red")
      assert {:error, :unknown_mode} = Game.parse_mode("ok")
      assert {:error, :unknown_mode} = Game.parse_mode(nil)
      assert {:error, :unknown_mode} = Game.parse_mode(42)
    end

    test "clean_name nettoie le pseudo" do
      assert Game.clean_name("  Jean   Dupont  ") == "Jean Dupont"
      assert Game.clean_name("abcdefghijklmnopqrstuvwxyz") == "abcdefghijklmnopqr"
      assert Game.clean_name(nil) == ""
    end
  end

  # --- lancer le dé --------------------------------------------------------

  describe "lancer le dé" do
    test "on ne peut pas jouer hors de son tour" do
      game = started()
      assert {:error, :not_your_turn} = Game.roll(game, "b", 6)
    end

    test "on ne peut pas lancer deux fois de suite" do
      game = started() |> set_tokens(:red, [:base, :base, :base, :base])
      {:ok, game, _events} = Game.roll(game, "a", 6)
      assert game.dice == 6
      assert {:error, :already_rolled} = Game.roll(game, "a", 6)
    end

    test "un dé hors bornes est refusé" do
      game = started()
      assert_raise ArgumentError, fn -> Game.roll(game, "a", 7) end
      assert_raise ArgumentError, fn -> Game.roll(game, "a", 0) end
    end

    test "un 6 est nécessaire pour sortir de la base" do
      game = started() |> set_tokens(:red, [:base, :base, :base, :base])
      game = %{game | dice: 4}
      assert Game.legal_moves(game) == []

      game = %{game | dice: 6}
      assert Game.legal_moves(game) == [0, 1, 2, 3]
    end

    test "sans coup possible, le lancer est publié puis la main passe" do
      game = started() |> set_tokens(:red, [:base, :base, :base, :base])

      # le lancer reste en place : c'est ce qui permet d'afficher le numéro tiré
      {:ok, game, _events} = Game.roll(game, "a", 3)
      assert game.dice == 3
      assert game.turn == 0
      assert Game.auto_resolve?(game)

      # puis le serveur résout, après avoir laissé le numéro affiché
      {:ok, game, _events} = Game.resolve_roll(game)
      assert game.turn == 1
      assert game.dice == nil
      assert Enum.any?(game.log, &(&1.type == :stuck))
    end

    test "avec un seul coup possible, le serveur l'enchaîne" do
      game = started() |> set_tokens(:red, [0, finish(), finish(), finish()])

      {:ok, game, _events} = Game.roll(game, "a", 6)
      # le lancer est d'abord publié, sans être joué
      assert game.dice == 6
      assert Game.tokens_of(game, :red) == [0, finish(), finish(), finish()]
      assert Game.auto_resolve?(game)

      {:ok, game, _events} = Game.resolve_roll(game)
      assert Game.tokens_of(game, :red) == [6, finish(), finish(), finish()]
    end

    test "avec plusieurs coups possibles, le joueur doit choisir" do
      game = started() |> set_tokens(:red, [:base, :base, :base, :base])
      {:ok, game, _events} = Game.roll(game, "a", 6)
      assert game.dice == 6
      assert length(Game.legal_moves(game)) == 4
      assert {:error, :illegal_move} = Game.move(game, "a", 9)
      assert {:error, :illegal_move} = Game.move(game, "a", -1)
    end
  end

  # --- déplacement ---------------------------------------------------------

  describe "déplacement" do
    test "sortir un pion de la base le place sur sa case de départ" do
      game = started() |> set_tokens(:red, [:base, :base, :base, :base])
      {:ok, game, _events} = Game.roll(game, "a", 6)
      {:ok, game, _events} = Game.move(game, "a", 0)

      assert Game.tokens_of(game, :red) == [0, :base, :base, :base]
      # la case de départ du rouge est (1,6) sur le plateau classique
      assert Board.cell(:red, 0) == {1, 6}
    end

    test "un pion avance du nombre exact de cases" do
      game = started() |> set_tokens(:red, [10, :base, :base, :base]) |> Map.put(:dice, 4)
      {:ok, game, _events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, :red) == [14, :base, :base, :base]
    end

    test "il faut le compte exact pour entrer à l'arrivée" do
      # deux cases avant l'arrivée
      game = started() |> set_tokens(:red, [finish() - 2, :base, :base, :base])

      # un 6 dépasserait l'arrivée : le pion ne peut pas bouger (les trois
      # pions en base restent jouables, eux, puisqu'on a fait un 6)
      refute 0 in Game.legal_moves(%{game | dice: 6})
      assert Game.legal_moves(%{game | dice: 6}) == [1, 2, 3]

      assert Game.legal_moves(%{game | dice: 2}) == [0]
      {:ok, game, _events} = Game.move(%{game | dice: 2}, "a", 0)
      assert Game.tokens_of(game, :red) == [finish(), :base, :base, :base]
    end

    test "un pion franchit la dernière case de l'anneau pour entrer dans sa colonne" do
      game =
        started()
        |> set_tokens(:red, [Board.last_ring_position(), :base, :base, :base])
        |> Map.put(:dice, 6)

      {:ok, game, _events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, :red) == [finish(), :base, :base, :base]
      # la dernière position d'anneau est l'entrée de la colonne
      assert Board.cell(:red, Board.last_ring_position()) == {0, 7}
    end

    test "un pion déjà arrivé ne bouge plus" do
      game = started() |> set_tokens(:red, [finish(), :base, :base, :base])
      assert Game.legal_moves(%{game | dice: 6}) == [1, 2, 3]
    end
  end

  # --- tours ---------------------------------------------------------------

  describe "tours" do
    test "un dé ordinaire passe la main au joueur suivant" do
      game = started() |> set_tokens(:red, [10, :base, :base, :base])
      game = %{game | dice: 3}
      {:ok, game, _events} = Game.move(game, "a", 0)
      assert game.turn == 1
      assert game.dice == nil
      assert game.six_streak == 0
    end

    test "un 6 donne un tour supplémentaire" do
      game = started() |> set_tokens(:red, [10, :base, :base, :base])

      # quatre coups possibles : le joueur doit choisir, on reste maître du coup
      {:ok, game, _events} = Game.roll(game, "a", 6)
      assert game.six_streak == 1
      assert game.turn == 0

      {:ok, game, _events} = Game.move(game, "a", 0)
      assert game.turn == 0
      assert game.dice == nil
      assert game.six_streak == 1
    end

    test "une capture donne un tour supplémentaire" do
      target = index_at(:red, 5)

      game = started() |> set_tokens(:red, [4, :base, :base, :base])
      game = set_tokens(game, second(), [position_at(second(), target), :base, :base, :base])
      game = %{game | turn: 0, dice: 1}

      {:ok, game, _events} = Game.move(game, "a", 0)
      assert game.turn == 0
      assert Game.tokens_of(game, second()) == [:base, :base, :base, :base]
    end

    test "un pion arrivé donne un tour supplémentaire" do
      game = started() |> set_tokens(:red, [finish() - 1, :base, :base, :base])
      game = %{game | dice: 1}
      {:ok, game, _events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, :red) == [finish(), :base, :base, :base]
      assert game.turn == 0
    end

    test "trois 6 consécutifs annulent le tour" do
      game = started() |> set_tokens(:red, [10, :base, :base, :base]) |> Map.put(:turn, 0)

      # 1er 6 : tour supplémentaire
      {:ok, game, _} = Game.roll(game, "a", 6)
      assert game.six_streak == 1
      assert game.turn == 0
      {:ok, game, _} = Game.move(game, "a", 0)

      # 2e 6 : tour supplémentaire
      {:ok, game, _} = Game.roll(game, "a", 6)
      assert game.six_streak == 2
      assert game.turn == 0
      {:ok, game, _} = Game.move(game, "a", 0)

      # 3e 6 : le tour est perdu, après un court affichage du numéro
      {:ok, game, _} = Game.roll(game, "a", 6)
      assert game.dice == 6
      assert game.turn == 0
      assert Game.auto_resolve?(game)

      {:ok, game, _} = Game.resolve_roll(game)
      assert game.turn == 1
      assert game.six_streak == 0
      assert Enum.any?(game.log, &(&1.type == :triple_six))
    end

    test "un dé non-6 remet le compteur de 6 à zéro" do
      game = started() |> set_tokens(:red, [10, 20, :base, :base])
      {:ok, game, _} = Game.roll(game, "a", 6)
      assert game.six_streak == 1
      {:ok, game, _} = Game.move(game, "a", 0)
      {:ok, game, _} = Game.roll(game, "a", 2)
      assert game.six_streak == 0
    end

    test "le tour revient au premier joueur après le dernier" do
      game = started(:p2)
      game = %{game | turn: 1, dice: 2} |> set_tokens(second(), [10, :base, :base, :base])
      {:ok, game, _} = Game.move(game, "b", 0)
      assert game.turn == 0
    end
  end

  # --- captures ------------------------------------------------------------

  describe "captures" do
    test "atterrir sur un pion adverse le renvoie à sa base" do
      # le rouge va de la position 4 à la position 5, dont l'index d'anneau est
      # occupé par un pion du joueur suivant
      target = index_at(:red, 5)
      occupant = position_at(second(), target)

      game = started() |> set_tokens(:red, [4, :base, :base, :base])
      game = set_tokens(game, second(), [occupant, :base, :base, :base])
      game = %{game | turn: 0, dice: 1}

      refute Board.safe_index?(target)

      {:ok, game, events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, second()) == [:base, :base, :base, :base]
      assert Enum.any?(events, &(&1.type == :captured))
    end

    test "aucune capture sur une case sûre" do
      # on vise une case étoile : le pion adverse y est protégé
      # on vise une case étoile (et non une case de départ, qui est aussi sûre
      # mais dont la position relative au joueur ne laisse pas de place avant)
      safe = Enum.find(Board.safe_indexes(), &(rem(&1, 14) != 1))

      red_position = position_at(:red, safe) - 1
      occupant = position_at(second(), safe)

      game = started() |> set_tokens(:red, [red_position, :base, :base, :base])
      game = set_tokens(game, second(), [occupant, :base, :base, :base])
      game = %{game | turn: 0, dice: 1}

      assert Board.safe_index?(safe)
      assert index_at(:red, red_position + 1) == safe

      {:ok, game, events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, second()) == [occupant, :base, :base, :base]
      refute Enum.any?(events, &(&1.type == :captured))
    end

    test "un pion dans sa colonne d'arrivée ne peut plus être capturé" do
      game = started() |> set_tokens(:red, [Board.last_ring_position() + 1, :base, :base, :base])
      game = set_tokens(game, second(), [10, :base, :base, :base])
      game = %{game | turn: 0, dice: 1}

      {:ok, game, events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, :red) == [Board.last_ring_position() + 2, :base, :base, :base]
      assert Game.tokens_of(game, second()) == [10, :base, :base, :base]
      refute Enum.any?(events, &(&1.type == :captured))
    end

    test "une capture renvoie tous les pions adverses de la case" do
      target = index_at(:red, 5)
      occupant = position_at(second(), target)

      game = started() |> set_tokens(:red, [4, :base, :base, :base])
      game = set_tokens(game, second(), [occupant, occupant, :base, :base])
      game = %{game | turn: 0, dice: 1}

      {:ok, game, _events} = Game.move(game, "a", 0)
      assert Game.tokens_of(game, second()) == [:base, :base, :base, :base]
    end
  end

  # --- victoire ------------------------------------------------------------

  describe "victoire" do
    test "rentrer ses quatre pions fait gagner la partie" do
      game =
        started()
        |> set_tokens(:red, [finish(), finish(), finish(), finish() - 1])

      assert game.status == :playing

      # un seul pion jouable : le serveur enchaîne le coup après avoir publié
      # le numéro tiré
      {:ok, game, _events} = Game.roll(game, "a", 1)
      assert game.dice == 1
      assert game.status == :playing

      {:ok, game, _events} = Game.resolve_roll(game)
      assert game.status == :finished
      assert game.winner == :red
      assert Game.finished_count(game, :red) == 4
      assert Enum.any?(game.log, &(&1.type == :won))
    end

    test "on ne peut plus jouer une fois la partie terminée" do
      game =
        started()
        |> set_tokens(:red, [finish(), finish(), finish(), finish() - 1])

      {:ok, game, _} = Game.roll(game, "a", 1)
      {:ok, game, _} = Game.resolve_roll(game)
      assert game.status == :finished

      assert {:error, :not_playing} = Game.roll(game, "b", 3)
      assert {:error, :not_playing} = Game.move(game, "b", 0)
    end

    test "avoir trois pions arrivés ne suffit pas" do
      game = started() |> set_tokens(:red, [finish(), finish(), finish(), :base])
      game = %{game | dice: 6}
      {:ok, game, _} = Game.move(game, "a", 3)
      refute game.status == :finished
      assert Game.finished_count(game, :red) == 3
    end
  end

  # --- choix du camp --------------------------------------------------------

  describe "choix du camp" do
    test "un joueur prend le camp qu'il veut" do
      game = new_game(:p4, "Alice", "a")
      assert Enum.find(game.players, &(&1.id == "a")).seat == 0

      {:ok, game, []} = Game.choose_seat(game, "a", 2)
      joueur = Enum.find(game.players, &(&1.id == "a"))

      assert joueur.seat == 2
      assert joueur.color == Board.seat_color(2)
      # le siège 0 devient libre : c'est là que joue le premier joueur
      assert Enum.all?(game.players, &(&1.seat != 0))
    end

    test "les pions suivent le joueur dans son nouveau camp" do
      game = new_game(:p4, "Alice", "a")
      ancienne = Board.seat_color(0)
      nouvelle = Board.seat_color(3)

      assert Map.has_key?(game.tokens, ancienne)

      {:ok, game, []} = Game.choose_seat(game, "a", 3)

      refute Map.has_key?(game.tokens, ancienne)
      assert game.tokens[nouvelle] == [:base, :base, :base, :base]
    end

    test "un camp déjà pris est refusé" do
      game = new_game(:p4, "Alice", "a")
      {:ok, game, _player, :joined} = Game.add_player(game, "Bob", "b")
      assert Enum.find(game.players, &(&1.id == "b")).seat == 1

      assert {:error, :seat_taken} = Game.choose_seat(game, "a", 1)
      # rien n'a bougé
      assert Enum.find(game.players, &(&1.id == "a")).seat == 0
    end

    test "un siège hors de la partie est refusé" do
      game = new_game(:p2, "Alice", "a")

      assert {:error, :unknown_seat} = Game.choose_seat(game, "a", 2)
      assert {:error, :unknown_seat} = Game.choose_seat(game, "a", -1)
      assert {:error, :unknown_seat} = Game.choose_seat(game, "a", "rouge")
    end

    test "un joueur absent de la partie ne peut pas choisir" do
      game = new_game(:p2, "Alice", "a")
      assert {:error, :not_in_game} = Game.choose_seat(game, "inconnu", 1)
    end

    test "on ne change plus de camp une fois la partie lancée" do
      game = started(:p2)
      assert {:error, :already_started} = Game.choose_seat(game, "a", 1)
    end

    test "choisir son camp actuel ne change rien" do
      game = new_game(:p4, "Alice", "a")
      version = game.version

      assert {:ok, game, []} = Game.choose_seat(game, "a", 0)
      assert game.version == version
      assert Enum.find(game.players, &(&1.id == "a")).seat == 0
    end

    test "celui qui prend le siège 0 joue en premier" do
      game = new_game(:p4, "Alice", "a")
      {:ok, game, _player, :joined} = Game.add_player(game, "Bob", "b")

      # Alice libère le siège 0, que Bob s'empresse de prendre : c'est lui qui
      # jouera en premier
      {:ok, game, []} = Game.choose_seat(game, "a", 3)
      {:ok, game, []} = Game.choose_seat(game, "b", 0)

      {:ok, game, _player, :joined} = Game.add_player(game, "Chloé", "c")
      {:ok, game, _player, :joined} = Game.add_player(game, "Dan", "d")

      {:ok, game} = Game.start(game)

      assert Game.current_player(game).name == "Bob"
      assert Game.current_player(game).color == Board.seat_color(0)
    end
  end

  # --- état public ---------------------------------------------------------

  describe "état public" do
    test "est sérialisable en JSON" do
      game = started(:vs_ai) |> set_tokens(:red, [0, 5, :base, finish()])
      state = Game.public_state(game)

      assert {:ok, json} = Jason.encode(state)
      decoded = Jason.decode!(json)

      assert decoded["code"] == "TEST"
      assert decoded["mode"] == "vs_ai"
      assert decoded["status"] == "playing"
      assert decoded["seats"] == 4
      assert decoded["turn"] == 0
      assert decoded["turn_color"] == "red"
      assert decoded["turn_is_bot"] == false
      assert length(decoded["players"]) == 4

      red = Enum.find(decoded["players"], &(&1["color"] == "red"))
      assert red["tokens"] == [0, 5, "base", 60]
      assert red["finished"] == 1
      assert red["kind"] == "human"
      assert is_binary(red["name"])
    end

    test "ne divulgue jamais les identifiants de connexion" do
      game = started()
      state = Game.public_state(game)
      json = Jason.encode!(state)

      refute json =~ "\"a\""
      refute json =~ "\"b\""
      refute Map.has_key?(state, :players) and Enum.any?(state.players, &Map.has_key?(&1, :id))
    end

    test "expose les coups légaux au joueur dont c'est le tour" do
      game = started() |> set_tokens(:red, [10, :base, :base, :base])
      game = %{game | dice: 3}
      assert Game.public_state(game).legal_moves == [0]
      assert Game.public_state(game).dice == 3
    end

    test "le journal reste borné" do
      game = started() |> set_tokens(:red, [0, 1, 2, 3])

      game =
        Enum.reduce(1..60, game, fn _, acc ->
          %{acc | log: acc.log ++ [%{type: :x, text: "x"}]}
        end)

      state = Game.public_state(game)
      assert length(state.log) == 8
      _ = Game.recent_log(game, 100)
    end
  end

  # --- cohérence globale ---------------------------------------------------

  describe "partie simulée" do
    test "une partie complète en solo se termine sans blocage" do
      game = new_game(:vs_ai)
      assert game.status == :playing

      result =
        Enum.reduce_while(1..4000, game, fn _, acc ->
          if acc.status == :finished do
            {:halt, acc}
          else
            player = Game.current_player(acc)
            dice = :rand.uniform(6)

            case Game.roll(acc, player.id, dice) do
              {:ok, game, _events} ->
                case Game.legal_moves(game) do
                  [] -> {:cont, resolve(game)}
                  moves -> {:cont, resolve(elem(Game.move(game, player.id, hd(moves)), 1))}
                end

              {:error, reason} ->
                flunk("échec inattendu : #{inspect(reason)}")
            end
          end
        end)

      assert result.status == :finished, "la partie ne s'est pas terminée"
      assert result.winner in [:red, :blue, :yellow, :green]
      assert Game.finished_count(result, result.winner) == 4
    end

    test "les pions restent toujours dans un état valide" do
      game = new_game(:vs_ai)

      Enum.reduce(1..1500, game, fn _, acc ->
        player = Game.current_player(acc)

        next =
          if acc.status == :finished do
            acc
          else
            case Game.roll(acc, player.id, :rand.uniform(6)) do
              {:ok, g, _} ->
                g =
                  case Game.legal_moves(g) do
                    [] -> g
                    moves -> elem(Game.move(g, player.id, Enum.random(moves)), 1)
                  end

                resolve(g)

              {:error, _} ->
                acc
            end
          end

        for {_color, tokens} <- next.tokens, position <- tokens do
          assert position == :base or
                   (is_integer(position) and position >= 0 and position <= finish()),
                 "position invalide : #{inspect(position)}"
        end

        assert length(next.players) == next.seats
        next
      end)
    end
  end
end
