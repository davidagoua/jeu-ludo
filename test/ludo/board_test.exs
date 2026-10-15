defmodule Ludo.BoardTest do
  use ExUnit.Case, async: true

  alias Ludo.Board

  defp adjacent?({x1, y1}, {x2, y2}), do: abs(x1 - x2) + abs(y1 - y2) == 1

  # Les quatre coins du carré central ne sont pas jouables : le chemin les
  # contourne, ce qui donne un pas en diagonale dont le coin est le sommet
  # commun aux deux cases.
  @coins_du_centre [{6, 6}, {8, 6}, {8, 8}, {6, 8}]

  defp tourne_autour?({x1, y1}, {x2, y2}, coins \\ @coins_du_centre) do
    abs(x1 - x2) == 1 and abs(y1 - y2) == 1 and ({x2, y1} in coins or {x1, y2} in coins)
  end

  # Rotation d'un quart de tour dans le sens horaire autour du centre du
  # plateau (7,5 ; 7,5) : le plateau doit être invariant par cette rotation.
  defp rotate({x, y}), do: {14 - y, x}

  describe "anneau" do
    test "contient exactement 52 cases distinctes" do
      ring = Board.ring()
      assert length(ring) == 52
      assert ring == Enum.uniq(ring)
      assert Board.ring_size() == 52
    end

    test "est une boucle fermée, qui tourne au coin du carré central" do
      ring = Board.ring()

      (ring ++ [hd(ring)])
      |> Enum.chunk_every(2, 1, :discard)
      |> Enum.each(fn [a, b] ->
        assert adjacent?(a, b) or tourne_autour?(a, b),
               "#{inspect(a)} -> #{inspect(b)} n'est pas un pas valide"
      end)

      # quatre virages en diagonale, un par coin du carré central
      virages =
        (ring ++ [hd(ring)])
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.count(fn [a, b] -> tourne_autour?(a, b) end)

      assert virages == 4, "le chemin devrait tourner 4 fois, pas #{virages}"
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
    test "les quatre départs sont régulièrement espacés de 13 cases" do
      starts = Board.players() |> Enum.map(&Board.start_index/1)
      assert starts == [1, 14, 27, 40]
      assert Enum.uniq(starts) == starts

      # écart constant de 14 entre joueurs successifs, en boucle
      gaps =
        starts
        |> Enum.with_index()
        |> Enum.map(fn {v, i} ->
          rem(Enum.at(starts, rem(i + 1, 4)) - v + Board.ring_size(), Board.ring_size())
        end)

      assert gaps == [13, 13, 13, 13]
    end

    test "le départ se situe deux cases après l'entrée de la colonne" do
      ring = Board.ring()

      for player <- Board.players() do
        start_index = Board.start_index(player)
        entrance_index = rem(start_index - 2 + Board.ring_size(), Board.ring_size())

        assert Enum.at(ring, start_index) != Enum.at(ring, entrance_index)

        # deux pas en avant depuis l'entrée mènent bien au départ
        assert rem(entrance_index + 2, Board.ring_size()) == start_index

        # et le départ suit immédiatement la case voisine de l'entrée
        neighbor = rem(start_index - 1 + Board.ring_size(), Board.ring_size())
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

    test "alternent des écarts de 8 et 5 et sont régulières" do
      safe = Board.safe_indexes()
      assert safe == [1, 9, 14, 22, 27, 35, 40, 48]

      gaps =
        safe
        |> Enum.with_index()
        |> Enum.map(fn {v, i} ->
          rem(Enum.at(safe, rem(i + 1, 8)) - v + Board.ring_size(), Board.ring_size())
        end)

      assert gaps == [8, 5, 8, 5, 8, 5, 8, 5]
    end

    test "les étoiles sont 8 cases après chaque départ" do
      for player <- Board.players() do
        star = rem(Board.start_index(player) + 8, Board.ring_size())
        assert Board.safe_index?(star)
      end
    end

    test "chaque étoile est sur la 4e case de la ligne de son bras" do
      # Les quatre départs sont sûrs eux aussi ; on ne garde que les étoiles.
      departs = Board.players() |> Enum.map(&Board.start_index/1)
      etoiles = Board.safe_indexes() -- departs

      assert length(etoiles) == 4

      for index <- etoiles do
        {x, y} = Enum.at(Board.ring(), index)

        # à quatre cases du centre : la croix a 3 cases de large (6 à 8) et les
        # bras six cases de long, donc la quatrième case du centre est en x (ou
        # y) égal à 2 ou à 12.
        assert x in [2, 12] or y in [2, 12],
               "l'étoile {#{x},#{y}} n'est pas à quatre cases du centre"

        # et elle est sur une ligne extérieure du bras, pas dans une colonne
        assert y in [6, 8] or x in [6, 8],
               "l'étoile {#{x},#{y}} n'est pas sur une ligne de bras"
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

    test "la dernière position d'anneau est l'entrée de la colonne" do
      for player <- Board.players() do
        assert Board.cell(player, Board.last_ring_position()) == entrance_cell(player)
      end
    end

    test "les positions suivantes sont la colonne d'arrivée" do
      for player <- Board.players() do
        column = Board.home_column(player)

        for k <- 0..4 do
          assert Board.cell(player, Board.last_ring_position() + 1 + k) == Enum.at(column, k)
        end
      end
    end

    test "la position d'arrivée termine le parcours" do
      for player <- Board.players() do
        assert Board.cell(player, Board.finish()) == :finished
      end
    end

    test "le parcours complet est une suite continue de cases distinctes" do
      for player <- Board.players() do
        cells = for p <- 0..(Board.finish() - 1), do: Board.cell(player, p)

        cells
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.each(fn [a, b] ->
          assert adjacent?(a, b) or tourne_autour?(a, b),
                 "#{player}: parcours discontinu #{inspect(a)} -> #{inspect(b)}"
        end)

        assert length(cells) == Board.finish()

        assert length(Enum.uniq(cells)) == Board.finish(),
               "#{player}: cases du parcours non distinctes"
      end
    end

    test "ring_index ne renvoie un index que sur l'anneau" do
      for player <- Board.players() do
        assert Board.ring_index(player, 0) == Board.start_index(player)
        assert Board.ring_index(player, Board.last_ring_position()) == entrance_index(player)
        assert Board.ring_index(player, Board.last_ring_position() + 1) == nil
        assert Board.ring_index(player, Board.finish()) == nil
        assert Board.ring_index(player, :base) == nil
      end
    end

    test "un pion fait le tour complet avant d'entrer dans sa colonne" do
      # Il parcourt l'anneau entier sauf la case juste avant son départ, et
      # l'entrée de sa colonne est sa dernière case d'anneau.
      assert Board.last_ring_position() == Board.ring_size() - 2
    end
  end

  describe "geometry/0" do
    test "est sérialisable en JSON et cohérent" do
      geo = Board.geometry()
      assert {:ok, json} = Jason.encode(geo)
      decoded = Jason.decode!(json)

      assert decoded["ring_size"] == 52
      assert decoded["last_ring_position"] == 50
      assert decoded["finish"] == 56
      assert length(decoded["ring"]) == 52
      assert decoded["starts"]["red"] == 1
      assert decoded["starts"]["blue"] == 14
      assert decoded["starts"]["yellow"] == 27
      assert decoded["starts"]["green"] == 40
      assert length(decoded["home_columns"]["blue"]) == 5
      assert length(decoded["bases"]["yellow"]) == 4
      assert length(decoded["center"]) == 9
      assert decoded["safe_indexes"] == [1, 9, 14, 22, 27, 35, 40, 48]
      assert decoded["players"] == ["red", "blue", "yellow", "green"]
    end

    test "la liste des cases JSON est bien [x, y]" do
      decoded = Board.geometry() |> Jason.encode!() |> Jason.decode!()
      dernier = Board.ring_size() - 1

      assert Enum.at(decoded["ring"], 0) == [0, 6]
      assert Enum.at(decoded["ring"], 1) == [1, 6]
      assert Enum.at(decoded["ring"], 12) == [7, 0]
      assert Enum.at(decoded["ring"], dernier) == [0, 7]
    end

    test "expose la position des bases, pour que le client n'en ait aucune en dur" do
      geo = Board.geometry()

      assert geo.base_areas == %{red: [0, 0], blue: [9, 0], yellow: [9, 9], green: [0, 9]}
      assert Enum.sort(Map.keys(geo.base_areas)) == [:blue, :green, :red, :yellow]
    end

    test "expose l'entrée du centre, adjacente à la colonne de chaque joueur" do
      geo = Board.geometry()

      assert geo.center_entries == %{red: [6, 7], blue: [7, 6], yellow: [8, 7], green: [7, 8]}

      # cohérence : l'entrée du centre est voisine de la dernière case de la
      # colonne d'arrivée du même joueur
      for {color, [ex, ey]} <- geo.center_entries do
        [lx, ly] = List.last(geo.home_columns[color])
        assert abs(ex - lx) + abs(ey - ly) == 1, "#{color} : entrée du centre non adjacente"
      end
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

  defp entrance_index(player) do
    rem(Board.start_index(player) - 2 + Board.ring_size(), Board.ring_size())
  end

  defp entrance_cell(player), do: Enum.at(Board.ring(), entrance_index(player))

  defp next_player(player) do
    players = Board.players()
    Enum.at(players, rem(Enum.find_index(players, &(&1 == player)) + 1, length(players)))
  end
end
