defmodule LudoWeb.GameChannel do
  @moduledoc """
  Canal d'un salon de jeu.

  À la connexion, le joueur est installé sur un siège par le `Ludo.GameServer`
  (ou le reprend s'il revient avec le même `player_id`). Le canal relaie ensuite
  les intentions du client (`roll`, `move`, `start`, `fill_bots`) et rediffuse
  chaque changement d'état à tous les joueurs du salon.
  """

  use Phoenix.Channel

  alias Ludo.{Board, GameServer}

  @impl true
  def join("game:" <> code, payload, socket) do
    name = Map.get(payload, "name", "")
    player_id = Map.get(payload, "player_id")

    case GameServer.join(code, name, player_id) do
      {:ok, seat, state} ->
        GameServer.subscribe(code)

        socket =
          socket
          |> assign(:code, code)
          |> assign(:player_id, player_id)

        {:ok, %{geometry: Board.geometry(), seat: seat, state: state}, socket}

      {:error, reason} ->
        {:error, %{reason: to_string(reason)}}

      :error ->
        {:error, %{reason: "not_found"}}
    end
  end

  @impl true
  def handle_in("roll", _payload, socket) do
    forward(socket, GameServer.roll(socket.assigns.code, socket.assigns.player_id))
  end

  def handle_in("move", %{"token" => token}, socket) when is_integer(token) do
    forward(socket, GameServer.move(socket.assigns.code, socket.assigns.player_id, token))
  end

  def handle_in("start", _payload, socket) do
    forward(socket, GameServer.start_game(socket.assigns.code, socket.assigns.player_id))
  end

  def handle_in("fill_bots", _payload, socket) do
    forward(socket, GameServer.fill_bots(socket.assigns.code, socket.assigns.player_id))
  end

  def handle_in("state", _payload, socket) do
    case GameServer.public_state(socket.assigns.code) do
      {:ok, state} -> {:reply, {:ok, %{state: state}}, socket}
      {:error, _} -> {:reply, {:error, %{reason: "not_found"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    {:reply, {:error, %{reason: "bad_request"}}, socket}
  end

  @impl true
  def handle_info({:game_state, state}, socket) do
    push(socket, "state", state)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def terminate(_reason, socket) do
    case socket.assigns do
      %{code: code, player_id: player_id} -> GameServer.leave(code, player_id)
      _ -> :ok
    end
  end

  defp forward(socket, {:ok, state}), do: {:reply, {:ok, %{state: state}}, socket}
  defp forward(socket, {:error, reason}), do: {:reply, {:error, error(reason)}, socket}
  defp forward(socket, :error), do: {:reply, {:error, error(:not_found)}, socket}

  defp error(reason), do: %{reason: to_string(reason), message: message(reason)}

  defp message(:not_your_turn), do: "Ce n'est pas votre tour."
  defp message(:already_rolled), do: "Vous avez déjà lancé le dé."
  defp message(:no_dice), do: "Lancez le dé d'abord."
  defp message(:illegal_move), do: "Ce coup n'est pas autorisé."
  defp message(:not_host), do: "Seul l'hôte peut faire cela."
  defp message(:full), do: "Cette partie est complète."
  defp message(:already_started), do: "Cette partie a déjà commencé."
  defp message(:not_enough_players), do: "Il manque des joueurs."
  defp message(:not_found), do: "Cette partie n'existe plus."
  defp message(:not_playing), do: "La partie n'est pas en cours."
  defp message(_), do: "Action impossible."
end
