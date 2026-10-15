defmodule Ludo.BotTest do
  use ExUnit.Case, async: true

  alias Ludo.{Board, Bot, Game}

  defp base_game(mode \\ :p2) do
    game = Game.new("BOT", mode, "Alice", "a")

    game =
      if mode == :p2 do
        {:ok, game, _p, :joined} = Game.add_player(game, "Bob", "b")
        game
      else
        game
      end

    case Game.start(game) do
      {:ok, game} -> game
      {:error, :already_started} -> game
    end
  end

  defp set_tokens(game, color, tokens), do: %{game | tokens: Map.put(game.tokens, color, tokens)}

  # Couleur du second siège : l'adversaire dans une partie à 2.
  defp second, do: Board.seat_color(1)

  # Position relative à laquelle `player` occupe l'index d'anneau donné.
  defp position_at(player, ring_index) do
    rem(ring_index - Board.start_index(player) + Board.ring_size(), Board.ring_size())
  end

  describe "choix du coup" do
    test "renvoie nil quand aucun coup n'est possible" do
      game = base_game() |> set_tokens(:red, [:base, :base, :base, :base])
      assert Bot.choose_move(%{game | dice: 3}) == nil
    end

    test "renvoie l'unique coup disponible" do
      game = base_game() |> set_tokens(:red, [30, :base, :base, :base])
      assert Bot.choose_move(%{game | dice: 2}) == 0
    end

    test "renvoie toujours un coup légal" do
      game =
        base_game(:vs_ai)
        |> set_tokens(:red, [3, 17, :base, 40])

      for dice <- 1..6 do
        g = %{game | dice: dice}

        case Bot.choose_move(g) do
          nil -> assert Game.legal_moves(g) == []
          choice -> assert choice in Game.legal_moves(g)
        end
      end
    end

    test "préfère capturer plutôt qu'avancer" do
      # le pion rouge avance de 1 et tombe sur l'index d'anneau occupé par un
      # pion adverse ; l'autre pion rouge, plus avancé, n'est pas une capture
      target = Board.ring_index(:red, 5)
      occupant = position_at(second(), target)

      game = base_game() |> set_tokens(:red, [4, 20, :base, :base])
      game = set_tokens(game, second(), [occupant, :base, :base, :base])
      game = %{game | dice: 1}

      assert Board.ring_index(second(), occupant) == target
      assert Bot.choose_move(game) == 0
    end

    test "préfère amener un pion à l'arrivée" do
      game = base_game() |> set_tokens(:red, [Board.finish() - 1, 10, :base, :base])
      game = %{game | dice: 1}

      assert Bot.choose_move(game) == 0
    end

    test "préfère sortir un pion de sa base avec un 6" do
      game = base_game() |> set_tokens(:red, [:base, 10, :base, :base])
      game = %{game | dice: 6}

      choice = Bot.choose_move(game)

      # Les trois pions en base aboutissent à la même case : n'importe lequel
      # convient, mais surtout pas le pion déjà engagé sur l'anneau (index 1).
      assert Enum.at(Game.tokens_of(game, :red), choice) == :base
      refute choice == 1
    end

    test "évite de se poser devant un adversaire" do
      # le pion rouge déjà dans sa colonne d'arrivée est à l'abri : il doit être
      # préféré au pion de l'anneau, exposé aux pions adverses.
      game = base_game() |> set_tokens(:red, [Board.finish() - 2, 20, :base, :base])
      game = set_tokens(game, second(), [22, :base, :base, :base])
      game = %{game | dice: 1}

      assert Bot.choose_move(game) == 0
    end

    test "le classement des coups est cohérent et complet" do
      target = Board.ring_index(:red, 5)
      occupant = position_at(second(), target)

      game = base_game() |> set_tokens(:red, [4, 20, :base, :base])
      game = set_tokens(game, second(), [occupant, :base, :base, :base])
      game = %{game | dice: 1}

      ranked = Bot.rank_moves(game)
      assert Enum.map(ranked, &elem(&1, 0)) |> Enum.sort() == Enum.sort(Game.legal_moves(game))

      assert [{best, best_score} | _] = ranked
      assert best == 0
      assert best_score > 0
    end
  end

  describe "partie complète IA contre IA" do
    test "les IA terminent une partie sans blocage ni coup illégal" do
      game = base_game(:vs_ai)
      # Le mode solo, c'est 1 humain (siège 0) + 3 IA : ici on fait jouer
      # tous les sièges avec le cerveau de l'IA.
      assert length(game.players) == 4
      assert Enum.count(game.players, &(&1.kind == :bot)) == 3

      result =
        Enum.reduce_while(1..20_000, game, fn _, acc ->
          if acc.status == :finished do
            {:halt, acc}
          else
            player = Game.current_player(acc)

            case Game.roll(acc, player.id, :rand.uniform(6)) do
              {:ok, g, _events} ->
                # Le serveur résout lui-même les lancers sans choix possible.
                g =
                  if Game.auto_resolve?(g) do
                    {:ok, resumed, _} = Game.resolve_roll(g)
                    resumed
                  else
                    g
                  end

                case Bot.choose_move(g) do
                  nil ->
                    {:cont, g}

                  choice ->
                    assert choice in Game.legal_moves(g)
                    {:ok, moved, _} = Game.move(g, player.id, choice)
                    {:cont, moved}
                end

              {:error, reason} ->
                flunk("échec du lancer : #{inspect(reason)}")
            end
          end
        end)

      assert result.status == :finished, "les IA ne terminent pas la partie"
      assert Game.finished_count(result, result.winner) == 4
    end

    test "une IA ne perd jamais de vue qu'elle doit sortir avec un 6" do
      game = base_game(:vs_ai) |> set_tokens(:red, [:base, :base, :base, :base])

      for dice <- 1..5 do
        assert Bot.choose_move(%{game | dice: dice}) == nil
      end

      assert Bot.choose_move(%{game | dice: 6}) in [0, 1, 2, 3]
    end
  end
end
