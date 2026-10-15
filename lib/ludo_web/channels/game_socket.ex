defmodule LudoWeb.GameSocket do
  @moduledoc """
  Point d'entrée WebSocket.

  Aucune authentification : on se contente d'un pseudo. L'identifiant de joueur
  (`player_id`) est un UUID tiré par le navigateur et conservé dans son
  `localStorage` ; il sert uniquement à reprendre son siège après une
  déconnexion, jamais à protéger quoi que ce soit de sensible.
  """

  use Phoenix.Socket

  channel "lobby", LudoWeb.LobbyChannel
  channel "game:*", LudoWeb.GameChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  # Pas d'identification cross-process : un socket par onglet.
  @impl true
  def id(_socket), do: nil
end
