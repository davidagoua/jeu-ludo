defmodule Ludo.BoardTest do
  use ExUnit.Case, async: true

  alias Ludo.Board

  defp adjacent?({x1, y1}, {x2, y2}), do: abs(x1 - x2) + abs(y1 - y2) == 1

  # Rotation d'un quart de tour dans le sens horaire autour du centre du
  # plateau (7,5 ; 7,5) : le plateau doit être invariant par cette rotation.
  defp rotate({x, y}), do: {14 - y, x}

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
        entrance = entrance_cell(player)
        first_home = Board.home_column(player) |> hd()

        assert entrance == Enum.at(ring, entrance_index(player))

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
      assert starts == [1, 15, 29, 43]
      assert Enum.uniq(starts) == starts

      # écart constant de 14 entre joueurs successifs, en boucle
      gaps =
        starts
        |> Enum.with_index()
        |> Enum.map(fn {v, i} -> rem(Enum.at(starts, rem(i + 1, 4)) - v + 56, 56) end)

      assert gaps == [14, 14, 14, 14]
    end

    test "le départ se situe deux cases après l'entrée de la colonne" do
      ring = Board.ring()

      for player <- Board.players() do
        start_index = Board.start_index(player)
        entrance_index = rem(start_index - 2 + 56, 56)

        assert Enum.at(ring, start_index) != Enum.at(ring, entrance_index)

        # deux pas en avant depuis l'entrée mènent bien au départ
        assert rem(entrance_index + 2, 56) == start_index

        # et le départ suit immédiatement la case voisine de l'entrée
        neighbor = rem(start_index - 1 + 56, 56)
        assert adjacent?(Enum.at(ring, neighbor), Enum.at(ring, start_index))
      end
    end

    test "la case de départ de chaque joueur n'est pas sa case d'entrée" do
      for player <- Board.players() do
        start = Enum.at(Board.ring(), Board.start_index(player))
        entrance = entrance_cell(player)
        refute start == entrance, "#{player}: départ et entrée confondus"

        refute adjacent?(start, entrance),
               "#{player}: départ et entrée devraient être en diagonale"
      end
    end
  end

  describe "symétrie du plateau" do
    test "les quatre zones se déduisent par rotation d'un quart de tour" do
      for player <- Board.players() do
        next = next_player(player)

        assert rotate(start_cell(player)) == start_cell(next),
               "le départ de #{player} ne tourne pas vers celui de #{next}"

        assert rotated(player, &Board.home_column/1) ==
                 Enum.sort(Board.home_column(next)),
               "la colonne de #{player} ne tourne pas vers celle de #{next}"

        # les emplacements de base ne sont pas dans le même ordre après
        # rotation : on compare les ensembles.
        assert rotated(player, &Board.base_cells/1) ==
                 Enum.sort(Board.base_cells(next)),
               "la base de #{player} ne tourne pas vers celle de #{next}"
      end
    end

    test "aucune case n'est partagée entre deux joueurs" do
      starts = Board.players() |> Enum.map(&start_cell/1)
      assert starts == Enum.uniq(starts)

      homes = Board.players() |> Enum.flat_map(&Board.home_column/1)
      assert homes == Enum.uniq(homes)

      bases = Board.players() |> Enum.flat_map(&Board.base_cells/1)
      assert bases == Enum.uniq(bases)
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

      cross = for x <- 0..14, y <- 0..14, y in 6..8 or x in 6..8, do: {x, y}
      assert MapSet.new(all) == MapSet.new(cross)
    end

    test "les quatre bases tiennent dans les coins 6x6 attendus" do
      areas = %{
        red: {0..5, 0..5},
        blue: {9..14, 0..5},
        yellow: {9..14, 9..14},
        green: {0..5, 9..14}
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
    test "incluent les quatre départs" do
      safe = Board.safe_indexes()
      starts = Board.players() |> Enum.map(&Board.start_index/1)

      assert Enum.all?(starts, &(&1 in safe))
      assert length(safe) == 8
      assert Enum.all?(safe, &(&1 in 0..55))
    end

    test "alternent des écarts de 9 et 5 et sont régulières" do
      safe = Board.safe_indexes()
      assert safe == [1, 10, 15, 24, 29, 38, 43, 52]

      gaps =
        safe
        |> Enum.with_index()
        |> Enum.map(fn {v, i} -> rem(Enum.at(safe, rem(i + 1, 8)) - v + 56, 56) end)

      assert gaps == [9, 5, 9, 5, 9, 5, 9, 5]
    end

    test "les étoiles sont 9 cases après chaque départ" do
      for player <- Board.players() do
        star = rem(Board.start_index(player) + 9, 56)
        assert Board.safe_index?(star)
      end
    end

    test "une case ordinaire n'est pas sûre" do
      refute Board.safe_index?(2)
      refute Board.safe_index?(7)
    end
  end

  describe "parcours d'un pion" do
    test "la position 0 est la case de départ du joueur" do
      for player <- Board.players() do
        assert Board.cell(player, 0) == start_cell(player)
      end
    end

    test "la position 54 est l'entrée de la colonne du joueur" do
      for player <- Board.players() do
        assert Board.cell(player, 54) == entrance_cell(player)
      end
    end

    test "les positions 55 à 59 sont la colonne d'arrivée" do
      for player <- Board.players() do
        column = Board.home_column(player)

        for k <- 0..4 do
          assert Board.cell(player, 55 + k) == Enum.at(column, k)
        end
      end
    end

    test "la position 60 est l'arrivée" do
      for player <- Board.players() do
        assert Board.cell(player, 60) == :finished
      end
    end

    test "le parcours complet est une suite continue de cases distinctes" do
      for player <- Board.players() do
        cells = for p <- 0..59, do: Board.cell(player, p)

        cells
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.each(fn [a, b] ->
          assert adjacent?(a, b), "#{player}: parcours discontinu #{inspect(a)} -> #{inspect(b)}"
        end)

        assert length(cells) == 60
        assert length(Enum.uniq(cells)) == 60, "#{player}: cases du parcours non distinctes"
      end
    end

    test "ring_index ne renvoie un index que sur l'anneau" do
      for player <- Board.players() do
        assert Board.ring_index(player, 0) == Board.start_index(player)
        assert Board.ring_index(player, 54) == entrance_index(player)
        assert Board.ring_index(player, 55) == nil
        assert Board.ring_index(player, 60) == nil
        assert Board.ring_index(player, :base) == nil
      end
    end

    test "un pion fait le tour complet avant d'entrer dans sa colonne" do
      # 54 pas sur l'anneau, soit 2 cases de moins que l'anneau entier : le pion
      # revient juste avant son départ, ce qui est la disposition classique.
      assert Board.last_ring_position() == 54
      assert Board.ring_size() - Board.last_ring_position() == 2
    end
  end

  describe "geometry/0" do
    test "est sérialisable en JSON et cohérent" do
      geo = Board.geometry()
      assert {:ok, json} = Jason.encode(geo)
      decoded = Jason.decode!(json)

      assert decoded["ring_size"] == 56
      assert decoded["last_ring_position"] == 54
      assert decoded["finish"] == 60
      assert length(decoded["ring"]) == 56
      assert decoded["starts"]["red"] == 1
      assert decoded["starts"]["blue"] == 15
      assert decoded["starts"]["yellow"] == 29
      assert decoded["starts"]["green"] == 43
      assert length(decoded["home_columns"]["blue"]) == 5
      assert length(decoded["bases"]["yellow"]) == 4
      assert length(decoded["center"]) == 5
      assert decoded["safe_indexes"] == [1, 10, 15, 24, 29, 38, 43, 52]
      assert decoded["players"] == ["red", "blue", "yellow", "green"]
    end

    test "la liste des cases JSON est bien [x, y]" do
      decoded = Board.geometry() |> Jason.encode!() |> Jason.decode!()
      assert Enum.at(decoded["ring"], 0) == [0, 6]
      assert Enum.at(decoded["ring"], 1) == [1, 6]
      assert Enum.at(decoded["ring"], 13) == [7, 0]
      assert Enum.at(decoded["ring"], 55) == [0, 7]
    end

    test "les couleurs sont toutes distinctes" do
      colors = Board.geometry().colors
      assert Enum.sort(Map.keys(colors)) == [:blue, :green, :red, :yellow]
      assert length(Enum.uniq(Map.values(colors))) == 4
    end
  end

  # --- aides ---------------------------------------------------------------

  defp start_cell(player), do: Enum.at(Board.ring(), Board.start_index(player))

  defp rotated(player, fun), do: player |> fun.() |> Enum.map(&rotate/1) |> Enum.sort()

  defp entrance_index(player), do: rem(Board.start_index(player) - 2 + 56, 56)

  defp entrance_cell(player), do: Enum.at(Board.ring(), entrance_index(player))

  defp next_player(player) do
    players = Board.players()
    Enum.at(players, rem(Enum.find_index(players, &(&1 == player)) + 1, length(players)))
  end
end
