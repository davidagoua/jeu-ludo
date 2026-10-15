defmodule Ludo.Board do
  @moduledoc """
  Géométrie du plateau de Ludo.

  Le plateau est une grille 15×15 :

    * les quatre bases occupent les coins (6×6) ;
    * la croix centrale porte le chemin ;
    * le centre (5 cases en « plus ») est la zone d'arrivée.

  Le chemin principal est un **anneau fermé de 56 cases**. Un pion parcourt
  d'abord l'anneau (positions `0..54`), puis sa colonne d'arrivée (positions
  `55..59`), puis l'arrivée (position `60`).

  Les quatre joueurs démarrent à 14 cases d'écart (`1, 15, 29, 43`) : la boucle
  de 56 cases est donc parfaitement symétrique. La case de départ d'un joueur se
  trouve **deux** cases après l'entrée de sa colonne d'arrivée : sortir de la
  base et rentrer dans sa colonne sont deux cases distinctes, en diagonale —
  c'est la disposition du plateau classique.

  | Joueur | Base | Colonne d'arrivée | Départ |
  | --- | --- | --- | --- |
  | rouge | haut-gauche | gauche | `(1,6)` |
  | bleu | haut-droite | haut | `(8,1)` |
  | jaune | bas-droite | droite | `(13,8)` |
  | vert | bas-gauche | bas | `(6,13)` |
  """

  @grid 15
  @ring_size 52
  @home_length 5

  # Dernière position sur l'anneau : c'est l'entrée de la colonne d'arrivée du
  # joueur. Comme le départ se situe deux cases après cette entrée, un pion
  # parcourt 54 pas sur l'anneau avant de s'engager dans sa colonne.
  @last_ring_position 50

  # Positions 55..59 : colonne d'arrivée ; position 60 : arrivée.
  @finish 56

  # Ordre des sièges, dans le sens horaire du plateau.
  @players [:red, :blue, :yellow, :green]

  # Anneau extérieur, dans le sens horaire. Chaque case est orthogonalement
  # adjacente à la suivante, et la dernière touche la première.
  @ring [
    {0, 6},
    {1, 6},
    {2, 6},
    {3, 6},
    {4, 6},
    {5, 6},
    {6, 5},
    {6, 4},
    {6, 3},
    {6, 2},
    {6, 1},
    {6, 0},
    {7, 0},
    {8, 0},
    {8, 1},
    {8, 2},
    {8, 3},
    {8, 4},
    {8, 5},
    {9, 6},
    {10, 6},
    {11, 6},
    {12, 6},
    {13, 6},
    {14, 6},
    {14, 7},
    {14, 8},
    {13, 8},
    {12, 8},
    {11, 8},
    {10, 8},
    {9, 8},
    {8, 9},
    {8, 10},
    {8, 11},
    {8, 12},
    {8, 13},
    {8, 14},
    {7, 14},
    {6, 14},
    {6, 13},
    {6, 12},
    {6, 11},
    {6, 10},
    {6, 9},
    {5, 8},
    {4, 8},
    {3, 8},
    {2, 8},
    {1, 8},
    {0, 8},
    {0, 7}
  ]

  # Case de départ de chaque joueur (index dans l'anneau).
  #
  # Le départ est **deux** cases après l'entrée de la colonne d'arrivée du même
  # joueur : sur le plateau, sortir de la base et entrer dans sa colonne sont
  # deux cases distinctes, disposées en diagonale (par exemple (1,6) pour le
  # départ rouge et (0,7) pour l'entrée de sa colonne).
  @starts %{red: 1, blue: 14, yellow: 27, green: 40}

  # Colonnes d'arrivée, de l'extérieur vers le centre.
  @home_columns %{
    red: [{1, 7}, {2, 7}, {3, 7}, {4, 7}, {5, 7}],
    blue: [{7, 1}, {7, 2}, {7, 3}, {7, 4}, {7, 5}],
    yellow: [{13, 7}, {12, 7}, {11, 7}, {10, 7}, {9, 7}],
    green: [{7, 13}, {7, 12}, {7, 11}, {7, 10}, {7, 9}]
  }

  # Emplacements des pions dans chaque base (pour l'affichage).
  @bases %{
    red: [{1, 1}, {4, 1}, {1, 4}, {4, 4}],
    blue: [{10, 1}, {13, 1}, {10, 4}, {13, 4}],
    yellow: [{10, 10}, {13, 10}, {10, 13}, {13, 13}],
    green: [{1, 10}, {4, 10}, {1, 13}, {4, 13}]
  }

  # Coin haut-gauche du carré 6x6 de chaque base. Envoyé au navigateur pour que
  # le client n'ait aucune coordonnée en dur : c'est la source des bugs de
  # disposition, quand le plateau change d'un côté et pas de l'autre.
  @base_areas %{red: {0, 0}, blue: {9, 0}, yellow: {9, 9}, green: {0, 9}}

  # Le carré central : 9 cases, qu'aucun pion ne traverse. Les quatre coins
  # étaient autrefois dans l'anneau, ce qui faisait 4 cases jouables de trop
  # dans le centre.
  @center for(x <- 6..8, y <- 6..8, do: {x, y})

  # Case du centre par laquelle chaque joueur entre : elle détermine le triangle
  # de sa couleur dans la zone d'arrivée.
  @center_entries %{red: {6, 7}, blue: {7, 6}, yellow: {8, 7}, green: {7, 8}}

  # Cases sûres : les 4 cases de départ, et les 4 cases « étoile ». L'étoile se
  # trouve sur la quatrième case de la ligne de son bras en partant du centre,
  # soit huit cases après le départ. Aucune capture n'y a lieu.
  @safe_indexes [1, 9, 14, 22, 27, 35, 40, 48]

  @colors %{
    red: "#e5484d",
    green: "#30a46c",
    yellow: "#e2b53d",
    blue: "#3b82f6"
  }

  @doc "Les quatre couleurs, dans l'ordre des sièges."
  def players, do: @players

  @doc "Le nom de fichier de la planche de chaque couleur (sièges)."
  def seat_color(index), do: Enum.at(@players, index)

  @doc """
  Les couleurs dans l'ordre des sièges.

  Le siège 0 joue en premier : c'est ce que le navigateur affiche pour laisser
  chaque joueur choisir son camp avant le début de la partie.
  """
  def seat_colors, do: @players

  @doc "L'anneau complet (56 cases)."
  def ring, do: @ring

  @doc "Taille de l'anneau."
  def ring_size, do: @ring_size

  @doc "Nombre de cases de la colonne d'arrivée."
  def home_length, do: @home_length

  @doc "Dernière position sur l'anneau, c'est-à-dire l'entrée de la colonne."
  def last_ring_position, do: @last_ring_position

  @doc "Position d'arrivée : la dernière étape du parcours d'un pion."
  def finish, do: @finish

  @doc "Taille de la grille."
  def grid, do: @grid

  @doc "Index d'anneau du départ d'un joueur."
  def start_index(player), do: Map.fetch!(@starts, player)

  @doc "Cases de la colonne d'arrivée d'un joueur, de l'extérieur vers le centre."
  def home_column(player), do: Map.fetch!(@home_columns, player)

  @doc "Emplacements de départ des pions dans la base d'un joueur."
  def base_cells(player), do: Map.fetch!(@bases, player)

  @doc "Cases de la zone d'arrivée centrale."
  def center_cells, do: @center

  @doc "Index d'anneau considérés comme sûrs."
  def safe_indexes, do: @safe_indexes

  @doc "Vrai si cette case d'anneau est sûre (aucune capture possible)."
  def safe_index?(index), do: index in @safe_indexes

  @doc "Couleur hexadécimale d'un joueur."
  def color(player), do: Map.fetch!(@colors, player)

  @doc """
  Case de la grille occupée par un pion à la position `p`.

  `p` va de `0` à `60` :

    * `0..54` — anneau ;
    * `55..59` — colonne d'arrivée ;
    * `60` — arrivée.

  Renvoie `{x, y}` ou `:finished`.
  """
  def cell(_player, :base), do: nil
  def cell(_player, :finished), do: :finished

  def cell(player, p) when is_integer(p) and p >= 0 do
    cond do
      p <= @last_ring_position -> Enum.at(@ring, rem(start_index(player) + p, @ring_size))
      p < @finish -> Enum.at(home_column(player), p - @last_ring_position - 1)
      p == @finish -> :finished
      true -> nil
    end
  end

  @doc """
  Index absolu dans l'anneau pour un pion du joueur `player` à la position `p`.

  Renvoie `nil` si le pion n'est pas sur l'anneau (base, colonne d'arrivée ou
  arrivée) : deux pions ne peuvent s'y capturer.
  """
  def ring_index(player, p)
      when is_integer(p) and p >= 0 and p <= @last_ring_position do
    rem(start_index(player) + p, @ring_size)
  end

  def ring_index(_player, _p), do: nil

  @doc """
  Géométrie complète, prête à être envoyée au navigateur en JSON.
  """
  def geometry do
    %{
      grid: @grid,
      ring_size: @ring_size,
      home_length: @home_length,
      last_ring_position: @last_ring_position,
      finish: @finish,
      ring: Enum.map(@ring, &Tuple.to_list/1),
      starts: Map.new(@starts, fn {player, i} -> {player, i} end),
      home_columns:
        Map.new(@home_columns, fn {p, cells} -> {p, Enum.map(cells, &Tuple.to_list/1)} end),
      bases: Map.new(@bases, fn {p, cells} -> {p, Enum.map(cells, &Tuple.to_list/1)} end),
      base_areas: Map.new(@base_areas, fn {p, {x, y}} -> {p, [x, y]} end),
      center: Enum.map(@center, &Tuple.to_list/1),
      center_entries: Map.new(@center_entries, fn {p, {x, y}} -> {p, [x, y]} end),
      safe_indexes: @safe_indexes,
      players: @players,
      seat_colors: @players,
      colors: @colors
    }
  end
end
