defmodule Ludo.Bot do
  @moduledoc """
  Adversaire automatisé.

  L'IA évalue chacun de ses coups légaux avec une somme de critères pondérés,
  puis tire au hasard parmi les meilleurs pour ne pas être totalement
  prévisible. Elle n'a aucune connaissance cachée : elle ne voit que l'état
  public, exactement comme un joueur humain.
  """

  alias Ludo.{Board, Game}

  # Barème : l'ordre des priorités est capture > arrivée > sortie de base >
  # sécurité > avancement.
  @capture 100
  @arrival 80
  @leave_base 60
  @safe_landing 30
  @home_column 25
  @threat 45
  @jitter 6.0

  @doc """
  Choisit un coup pour le joueur courant.

  Renvoie l'index d'un pion, ou `nil` si aucun coup n'est possible.
  """
  def choose_move(%Game{} = game) do
    case Game.legal_moves(game) do
      [] ->
        nil

      [only] ->
        only

      moves ->
        player = Game.current_player(game)
        tokens = Game.tokens_of(game, player.color)

        scored =
          Enum.map(moves, fn index ->
            {score(game, player.color, tokens, index), index}
          end)

        best = scored |> Enum.max_by(fn {value, _} -> value end) |> elem(0)

        scored
        |> Enum.filter(fn {value, _} -> value == best end)
        |> Enum.map(fn {_, index} -> index end)
        |> Enum.random()
    end
  end

  @doc """
  Détail du score de chaque coup légal (utile pour les tests et le débogage).
  """
  def rank_moves(%Game{} = game) do
    player = Game.current_player(game)
    tokens = Game.tokens_of(game, player.color)

    game
    |> Game.legal_moves()
    |> Enum.map(fn index -> {index, score(game, player.color, tokens, index)} end)
    |> Enum.sort_by(fn {_, value} -> -value end)
  end

  # ---------------------------------------------------------------------------

  defp score(game, color, tokens, index) do
    dice = game.dice
    from = Enum.at(tokens, index)
    to = if from == :base, do: 0, else: from + dice

    # avancement : favorise le pion le plus proche de l'arrivée
    # un peu d'aléatoire pour éviter un jeu mécanique
    @capture * length(captures(game, color, to)) +
      if(to == Board.finish(), do: @arrival, else: 0) +
      if(from == :base, do: @leave_base, else: 0) +
      if(protected?(color, to), do: @safe_landing, else: 0) +
      if(in_home_column?(to), do: @home_column, else: 0) +
      to / 4 +
      :rand.uniform() * @jitter -
      risk(game, color, to)
  end

  # Pions adverses qui seraient renvoyés à leur base par ce coup.
  defp captures(game, color, to) do
    case Board.ring_index(color, to) do
      nil ->
        []

      ring_index ->
        if Board.safe_index?(ring_index) do
          []
        else
          for {other, tokens} <- game.tokens,
              other != color,
              position <- tokens,
              Board.ring_index(other, position) == ring_index,
              do: {other, position}
        end
    end
  end

  # Une case sûre ou la colonne d'arrivée mettent le pion à l'abri.
  # (`Board.last_ring_position()` est un appel de fonction : interdit en guard.)
  defp protected?(color, to) do
    cond do
      not is_integer(to) ->
        false

      to > Board.last_ring_position() ->
        true

      true ->
        case Board.ring_index(color, to) do
          nil -> false
          index -> Board.safe_index?(index)
        end
    end
  end

  defp in_home_column?(to) do
    is_integer(to) and to > Board.last_ring_position() and to < Board.finish()
  end

  # Pénalité si la case d'arrivée est à portée de dé d'un adversaire.
  defp risk(game, color, to) do
    case Board.ring_index(color, to) do
      nil ->
        0

      index ->
        cond do
          Board.safe_index?(index) ->
            0

          threatened?(game, color, index) ->
            @threat

          true ->
            0
        end
    end
  end

  defp threatened?(game, color, index) do
    Enum.any?(game.tokens, fn {other, tokens} ->
      other != color and
        Enum.any?(tokens, fn position ->
          case Board.ring_index(other, position) do
            nil -> false
            theirs -> rem(index - theirs + Board.ring_size(), Board.ring_size()) in 1..6
          end
        end)
    end)
  end
end
