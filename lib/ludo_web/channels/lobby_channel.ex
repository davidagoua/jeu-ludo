defmodule LudoWeb.LobbyChannel do
  @moduledoc """
  Salon d'accueil : liste des parties, création, recherche d'une partie à
  rejoindre.

  Le canal ne modifie jamais l'état d'une partie : il délègue au `Ludo.Lobby`,
  qui est le seul à connaître la liste des salons.
  """

  use Phoenix.Channel

  alias Ludo.{Game, Lobby}

  @impl true
  def join("lobby", _payload, socket) do
    Lobby.subscribe()
    send(self(), :after_join)
    {:ok, socket}
  end

  @impl true
  def handle_info(:after_join, socket) do
    push(socket, "games", %{games: Lobby.list_games(), modes: Game.modes_list()})
    {:noreply, socket}
  end

  def handle_info({:games, games}, socket) do
    push(socket, "games", %{games: games})
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def handle_in("create", payload, socket) do
    with %{"name" => name, "mode" => mode, "player_id" => player_id} <- payload do
      # `bots` est facultatif : il ne concerne que le mode contre l'IA.
      case Lobby.create_game(mode, name, player_id, payload["bots"]) do
        {:ok, code} -> {:reply, {:ok, %{code: code}}, socket}
        {:error, reason} -> {:reply, {:error, error(reason)}, socket}
      end
    else
      _ -> {:reply, {:error, error(:bad_request)}, socket}
    end
  end

  def handle_in("check", %{"code" => code, "player_id" => player_id}, socket) do
    code = normalize_code(code)

    case Lobby.joinable?(code, player_id) do
      :ok -> {:reply, {:ok, %{code: code}}, socket}
      {:error, reason} -> {:reply, {:error, error(reason)}, socket}
    end
  end

  def handle_in("quick_join", %{"player_id" => _player_id}, socket) do
    case Lobby.list_games() do
      [] ->
        {:reply, {:error, error(:no_game)}, socket}

      games ->
        # On remplit d'abord les parties les plus avancées.
        game = Enum.max_by(games, & &1.taken)
        {:reply, {:ok, %{code: game.code}}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    {:reply, {:error, error(:bad_request)}, socket}
  end

  defp normalize_code(code) when is_binary(code) do
    code |> String.trim() |> String.upcase()
  end

  defp normalize_code(_), do: ""

  defp error(reason) do
    %{reason: to_string(reason), message: message(reason)}
  end

  defp message(:invalid_name), do: "Choisissez un pseudo de 1 à 18 caractères."
  defp message(:invalid_player_id), do: "Session invalide, rechargez la page."
  defp message(:not_found), do: "Aucune partie ne porte ce code."
  defp message(:full), do: "Cette partie est complète."
  defp message(:already_started), do: "Cette partie a déjà commencé."
  defp message(:no_game), do: "Aucune partie disponible pour le moment : créez-en une."
  defp message(_), do: "Requête invalide."
end
