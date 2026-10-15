defmodule Ludo.GameServerTest do
  @moduledoc """
  Le délai de l'IA n'était pas testable tant qu'il était figé : on vérifie ici sa
  plage, son caractère aléatoire, et surtout que le serveur attend réellement
  avant de laisser jouer un bot.
  """

  use ExUnit.Case, async: false

  alias Ludo.{GameServer, Lobby}

  describe "bot_delay/0" do
    test "tire un délai entre 1 et 3 secondes" do
      assert GameServer.bot_delay_range() == {1_000, 3_000}
      {min, max} = GameServer.bot_delay_range()

      samples = for _ <- 1..500, do: GameServer.bot_delay()

      assert Enum.all?(samples, &(&1 >= min and &1 <= max)),
             "échantillon hors bornes : #{Enum.min(samples)}..#{Enum.max(samples)}"
    end

    test "couvre toute la plage, ce n'est pas une valeur figée" do
      {min, max} = GameServer.bot_delay_range()
      samples = for _ <- 1..500, do: GameServer.bot_delay()

      # avec 500 tirages sur 2 001 valeurs, ne pas approcher les bornes est
      # statistiquement impossible
      assert Enum.min(samples) < min + 300, "le tirage ne descend pas : #{Enum.min(samples)}"
      assert Enum.max(samples) > max - 300, "le tirage ne monte pas : #{Enum.max(samples)}"
      assert length(Enum.uniq(samples)) > 100, "délai non aléatoire"
    end
  end

  describe "le serveur attend avant de laisser jouer l'IA" do
    test "l'IA ne joue pas tout de suite" do
      player_id = "player-timing-#{System.unique_integer([:positive])}"
      {:ok, code} = Lobby.create_game(:vs_ai, "Alice", player_id)

      # le joueur humain joue jusqu'à ce que la main passe à une IA
      state = play_until_bot(code, player_id, 40)
      assert state.turn_is_bot, "la main n'est jamais passée à une IA"

      {min, _max} = GameServer.bot_delay_range()
      started = System.monotonic_time(:millisecond)
      waited = wait_for_change(code, state.version, started)

      assert is_integer(waited), "l'IA n'a pas joué dans le délai imparti"

      # On sonde toutes les 10 ms : la mesure peut être en retard, jamais en
      # avance. L'ancien délai fixe de 750 ms échouerait ici.
      assert waited >= min - 40,
             "l'IA a joué après seulement #{waited} ms (attendu >= #{min} ms)"
    end
  end

  # ---------------------------------------------------------------------------

  # `GameServer.public_state/1` renvoie `{:ok, état}` : on déballe ici.
  defp state(code) do
    {:ok, state} = GameServer.public_state(code)
    state
  end

  # Fait jouer le joueur humain jusqu'à ce que la main revienne à une IA.
  defp play_until_bot(code, player_id, attempts) do
    Enum.reduce_while(1..attempts, state(code), fn _, state ->
      cond do
        state.turn_is_bot ->
          {:halt, state}

        # `public_state/1` sérialise pour JSON : le statut est une chaîne
        state.status != "playing" ->
          {:halt, state}

        state.dice == nil ->
          {:cont, advance(code, fn -> GameServer.roll(code, player_id) end)}

        state.legal_moves != [] ->
          {:cont,
           advance(code, fn -> GameServer.move(code, player_id, hd(state.legal_moves)) end)}

        true ->
          Process.sleep(20)
          {:cont, state(code)}
      end
    end)
  end

  # Une action refusée (coup illégal, par exemple) laisse l'état en place : on le
  # relit plutôt que de propager l'erreur.
  defp advance(code, action) do
    case action.() do
      {:ok, state} -> state
      {:error, _reason} -> state(code)
    end
  end

  defp wait_for_change(code, version, started) do
    Enum.reduce_while(1..600, nil, fn _, _ ->
      Process.sleep(10)

      if state(code).version > version do
        {:halt, System.monotonic_time(:millisecond) - started}
      else
        {:cont, nil}
      end
    end)
  end
end
