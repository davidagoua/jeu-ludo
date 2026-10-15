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
      # rouge en 4 peut aller en 5 (index d'anneau 5) où se trouve un pion vert
      game = base_game() |> set_tokens(:red, [4, 20, :base, :base])
      game = set_tokens(game, :green, [47, :base, :base, :base])
      game = %{game | dice: 1}

      assert Board.ring_index(:red, 5) == Board.ring_index(:green, 47)
      assert Bot.choose_move(game) == 0
    end

    test "préfère amener un pion à l'arrivée" do
      game = base_game() |> set_tokens(:red, [60, 10, :base, :base])
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
      # rouge en 20 : 20 -> 26 est menacé par un vert en 22 (index 36), à 4 cases
      # derrière la case 26 ; l'autre option 20 -> 27 l'est aussi, mais le pion
      # protégé en colonne d'arrivée doit l'emporter.
      game = base_game() |> set_tokens(:red, [58, 20, :base, :base])
      game = set_tokens(game, :green, [22, :base, :base, :base])
      game = %{game | dice: 1}

      # 58 -> 59 reste dans la colonne d'arrivée, à l'abri
      assert Bot.choose_move(game) == 0
    end

    test "le classement des coups est cohérent et complet" do
      game = base_game() |> set_tokens(:red, [4, 20, :base, :base])
      game = set_tokens(game, :green, [47, :base, :base, :base])
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
