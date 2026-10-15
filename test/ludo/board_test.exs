defmodule Ludo.BoardTest do
  use ExUnit.Case, async: true

  alias Ludo.Board

  defp adjacent?({x1, y1}, {x2, y2}), do: abs(x1 - x2) + abs(y1 - y2) == 1

  describe "anneau" do
    test "contient exactement 56 cases distinctes" do
      ring = Board.ring()
      assert length(ring) == 56
      assert ring == Enum.uniq(ring)
      assert Board.ring_size() == 56
    end

    test "est une boucle fermée de cases orthogonales adjacentes" do
      ring = Board.ring()

      ring
      |> Enum.chunk_every(2, 1, :discard)
      |> Enum.each(fn [a, b] ->
        assert adjacent?(a, b), "#{inspect(a)} et #{inspect(b)} ne sont pas adjacentes"
      end)

      assert adjacent?(List.last(ring), List.first(ring)),
             "la boucle n'est pas fermée entre la dernière et la première case"
    end

    test "toutes les cases sont dans la grille 15x15" do
      for {x, y} <- Board.ring() do
        assert x in 0..14 and y in 0..14
      end
    end

    test "les cases de l'anneau font partie de la croix" do
      for {x, y} <- Board.ring() do
        assert y in 6..8 or x in 6..8, "la case {#{x},#{y}} est hors de la croix"
      end
    end

    test "l'anneau ne recouvre ni les colonnes d'arrivée ni le centre" do
      ring = MapSet.new(Board.ring())
      home = Board.players() |> Enum.flat_map(&Board.home_column/1) |> MapSet.new()

      assert MapSet.disjoint?(ring, home)
      assert MapSet.disjoint?(ring, MapSet.new(Board.center_cells()))
    end
  end

  describe "colonnes d'arrivée" do
    test "chaque joueur a 5 cases distinctes et adjacentes" do
      for player <- Board.players() do
        column = Board.home_column(player)
        assert length(column) == 5, "#{player} n'a pas 5 cases"
        assert column == Enum.uniq(column)

        column
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.each(fn [a, b] ->
          assert adjacent?(a, b), "#{player}: #{inspect(a)} -> #{inspect(b)} non adjacentes"
        end)
      end
    end

    test "la première case de la colonne touche l'entrée sur l'anneau" do
      ring = Board.ring()

      for player <- Board.players() do
        entrance_index = rem(Board.start_index(player) - 1 + 56, 56)
        entrance = Enum.at(ring, entrance_index)
        first_home = Board.home_column(player) |> hd()

        assert adjacent?(entrance, first_home),
               "#{player}: entrée #{inspect(entrance)} ne touche pas #{inspect(first_home)}"
      end
    end

    test "la dernière case de la colonne touche le centre" do
      center = Board.center_cells()

      for player <- Board.players() do
        last_home = Board.home_column(player) |> List.last()

        assert Enum.any?(center, &adjacent?(last_home, &1)),
               "#{player}: #{inspect(last_home)} ne touche pas le centre"
      end
    end
  end

  describe "départs" do
    test "les quatre départs sont régulièrement espacés de 14 cases" do
      starts = Board.players() |> Enum.map(&Board.start_index/1)
      assert starts == [0, 14, 28, 42]
      assert rem(56, 4) == 0
      assert Enum.uniq(starts) == starts
    end

    test "le départ suit immédiatement l'entrée de la colonne du même joueur" do
      ring = Board.ring()

      for player <- Board.players() do
        start_index = Board.start_index(player)
        entrance_index = rem(start_index - 1 + 56, 56)

        assert adjacent?(Enum.at(ring, entrance_index), Enum.at(ring, start_index)),
               "#{player}: le départ ne suit pas l'entrée"
      end
    end
  end

  describe "croix complète" do
    test "anneau + colonnes + centre reconstituent exactement les 81 cases de la croix" do
      ring = Board.ring()
      home = Board.players() |> Enum.flat_map(&Board.home_column/1)
      center = Board.center_cells()

      all = ring ++ home ++ center
      assert length(all) == 81
      assert all == Enum.uniq(all), "des cases se recouvrent"

      cross =
        for x <- 0..14, y <- 0..14, y in 6..8 or x in 6..8, do: {x, y}

      assert MapSet.new(all) == MapSet.new(cross)
    end

    test "les quatre bases tiennent dans les coins 6x6" do
      areas = %{
        red: {0..5, 0..5},
        green: {9..14, 0..5},
        yellow: {9..14, 9..14},
        blue: {0..5, 9..14}
      }

      for {player, {xs, ys}} <- areas do
        cells = Board.base_cells(player)
        assert length(cells) == 4
        assert cells == Enum.uniq(cells)

        for {x, y} <- cells do
          assert x in xs and y in ys, "#{player}: {#{x},#{y}} hors de sa base"
        end
      end
    end
  end

  describe "cases sûres" do
    test "incluent les quatre départs et restent symétriques" do
      safe = Board.safe_indexes()
      starts = Board.players() |> Enum.map(&Board.start_index/1)

      assert Enum.all?(starts, &(&1 in safe))
      assert length(safe) == 8
      assert Enum.all?(safe, &(&1 in 0..55))

      # régularité : 8, 6, 8, 6, 8, 6, 8, 6
      gaps =
        safe
        |> Enum.with_index()
        |> Enum.map(fn {v, i} -> rem(Enum.at(safe, rem(i + 1, 8)) - v + 56, 56) end)

      assert gaps == [8, 6, 8, 6, 8, 6, 8, 6] or gaps == [8, 6, 8, 6, 8, 6, 8, 6]

      for i <- safe do
        assert Board.safe_index?(i)
      end

      refute Board.safe_index?(1)
    end
  end

  describe "parcours d'un pion" do
    test "la position 0 est la case de départ du joueur" do
      for player <- Board.players() do
        assert Board.cell(player, 0) == Enum.at(Board.ring(), Board.start_index(player))
      end
    end

    test "la position 55 est l'entrée de la colonne du joueur" do
      for player <- Board.players() do
        entrance_index = rem(Board.start_index(player) - 1 + 56, 56)
        assert Board.cell(player, 55) == Enum.at(Board.ring(), entrance_index)
      end
    end

    test "les positions 56 à 60 sont la colonne d'arrivée" do
      for player <- Board.players() do
        column = Board.home_column(player)

        for k <- 0..4 do
          assert Board.cell(player, 56 + k) == Enum.at(column, k)
        end
      end
    end

    test "la position 61 est l'arrivée" do
      for player <- Board.players() do
        assert Board.cell(player, 61) == :finished
      end
    end

    test "le parcours complet est une suite continue de cases adjacentes" do
      for player <- Board.players() do
        cells = for p <- 0..60, do: Board.cell(player, p)

        cells
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.each(fn [a, b] ->
          assert adjacent?(a, b), "#{player}: parcours discontinu #{inspect(a)} -> #{inspect(b)}"
        end)

        assert length(Enum.uniq(cells)) == 61, "#{player}: cases du parcours non distinctes"
      end
    end

    test "ring_index ne renvoie un index que sur l'anneau" do
      for player <- Board.players() do
        assert Board.ring_index(player, 0) == Board.start_index(player)
        assert Board.ring_index(player, 55) == rem(Board.start_index(player) - 1 + 56, 56)
        assert Board.ring_index(player, 56) == nil
        assert Board.ring_index(player, 61) == nil
        assert Board.ring_index(player, :base) == nil
      end
    end

    test "deux joueurs ne partagent jamais la même case de départ" do
      starts = Board.players() |> Enum.map(&Board.cell(&1, 0))
      assert starts == Enum.uniq(starts)
    end
  end

  describe "geometry/0" do
    test "est sérialisable en JSON et cohérent" do
      geo = Board.geometry()
      assert {:ok, json} = Jason.encode(geo)
      decoded = Jason.decode!(json)

      assert decoded["ring_size"] == 56
      assert length(decoded["ring"]) == 56
      assert decoded["starts"]["red"] == 0
      assert length(decoded["home_columns"]["blue"]) == 5
      assert length(decoded["bases"]["yellow"]) == 4
      assert length(decoded["center"]) == 5
      assert decoded["safe_indexes"] == [0, 8, 14, 22, 28, 36, 42, 50]
      assert decoded["players"] == ["red", "green", "yellow", "blue"]
    end

    test "la liste des cases JSON est bien [x, y]" do
      decoded = Board.geometry() |> Jason.encode!() |> Jason.decode!()
      assert Enum.at(decoded["ring"], 0) == [0, 6]
      assert Enum.at(decoded["ring"], 13) == [7, 0]
      assert Enum.at(decoded["ring"], 55) == [0, 7]
    end
  end
end
