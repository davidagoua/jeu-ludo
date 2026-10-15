defmodule LudoWeb.PageController do
  @moduledoc """
  Pages HTML. Toute la logique de partie vit dans les canaux ; ces pages ne font
  que fournir le squelette et l'identifiant de salon.
  """

  use LudoWeb, :controller

  alias Ludo.{Game, Lobby}

  @doc "Accueil : pseudo, choix du mode, liste des parties ouvertes."
  def home(conn, _params) do
    render(conn, :home,
      page_title: "Jouer au Ludo en ligne",
      modes: Game.modes_list(),
      games: Lobby.list_games()
    )
  end

  @doc "Plateau d'une partie. Le code est validé avant d'afficher quoi que ce soit."
  def game(conn, %{"code" => code}) do
    code = normalize_code(code)

    case Lobby.get_game(code) do
      {:ok, game} ->
        render(conn, :game,
          page_title: "Salon #{code}",
          code: code,
          lobby: game,
          # le layout ne charge Three.js que sur cette page
          load_board3d: true
        )

      :error ->
        conn
        |> put_flash(:error, "Aucune partie ne porte le code #{code}.")
        |> redirect(to: ~p"/")
    end
  end

  @doc "Règles du jeu."
  def rules(conn, _params), do: render(conn, :rules, page_title: "Règles du jeu")

  @doc "Sonde de disponibilité, utilisée par Docker et le reverse proxy."
  def health(conn, _params) do
    json(conn, %{status: "ok", games: length(Lobby.list_games())})
  end

  defp normalize_code(code) when is_binary(code), do: code |> String.trim() |> String.upcase()
  defp normalize_code(_), do: ""
end
