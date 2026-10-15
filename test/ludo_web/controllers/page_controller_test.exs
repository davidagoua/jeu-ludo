defmodule LudoWeb.PageControllerTest do
  use LudoWeb.ConnCase

  describe "GET /" do
    test "affiche le pseudo, les quatre modes et la liste des parties", %{conn: conn} do
      conn = get(conn, ~p"/")
      html = html_response(conn, 200)

      assert html =~ "Votre pseudo"
      assert html =~ ~s(name="mode")
      assert html =~ "Solo contre l&#39;IA"
      assert html =~ "2 joueurs"
      assert html =~ "3 joueurs"
      assert html =~ "4 joueurs"
      assert html =~ "Parties ouvertes"
      # le client temps réel est bien chargé
      assert html =~ "/assets/js/phoenix.min.js"
      assert html =~ "/assets/js/app.js"
    end
  end

  describe "GET /regles" do
    test "explique les règles", %{conn: conn} do
      html = get(conn, ~p"/regles") |> html_response(200)

      assert html =~ "Comment jouer"
      assert html =~ "Trois 6"
      assert html =~ "cases sûres"
    end
  end

  describe "GET / — choix des adversaires" do
    test "propose de choisir le nombre d'IA", %{conn: conn} do
      html = get(conn, ~p"/") |> html_response(200)

      # un bouton par nombre d'adversaires possible
      assert html =~ ~s(id="bots-row")

      for n <- 1..3 do
        assert html =~ ~s(value="#{n}")
      end

      # le choix n'est proposé que par les modes qui prévoient des IA
      assert html =~ ~s(data-bot-choices="1,2,3")
      assert html =~ "1 joueur +"
    end
  end

  describe "GET /partie/:code" do
    test "affiche le plateau d'une partie existante", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-1111")
      html = get(conn, ~p"/partie/#{code}") |> html_response(200)

      assert html =~ code
      assert html =~ ~s(id="board3d")
      assert html =~ ~s(data-code="#{code}")
      assert html =~ "2 joueurs"
    end

    test "charge Three.js sur le plateau, et seulement là", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-5555")

      game = get(conn, ~p"/partie/#{code}") |> html_response(200)
      assert game =~ ~s(src="/assets/js/board3d.js")
      # le module est chargé en `module` : il importe Three.js en ESM
      assert game =~ ~r/<script type="module"[^>]*board3d\.js/

      # l'accueil n'a pas besoin de 747 Ko de moteur 3D
      home = get(conn, ~p"/") |> html_response(200)
      refute home =~ "board3d.js"
      refute home =~ "three.module"
    end

    test "WebGL est annoncé si le navigateur ne peut pas l'afficher", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-6666")
      html = get(conn, ~p"/partie/#{code}") |> html_response(200)

      assert html =~ ~s(id="webgl-error")
      assert html =~ "WebGL"
    end

    test "le dé est un bouton, sans bouton de lancer séparé", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-3333")
      html = get(conn, ~p"/partie/#{code}") |> html_response(200)

      # c'est le dé lui-même qui sert de bouton…
      assert html =~
               ~r/<button[^>]*class="dice"[^>]*id="dice"|<button[^>]*id="dice"[^>]*class="dice"/

      # …et il n'y a plus de bouton de lancer à côté
      refute html =~ ~s(id="roll")
      refute html =~ "dice-box"

      # le dé reste décrit pour les lecteurs d'écran
      assert html =~ ~s(aria-label="Lancer le dé")
    end

    test "la vue est allégée : plus de journal", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-4444")
      html = get(conn, ~p"/partie/#{code}") |> html_response(200)

      refute html =~ "Journal"
      refute html =~ ~s(id="log")
      # la liste des joueurs reste, mais dans une colonne étroite
      assert html =~ ~s(id="players")
      assert html =~ ~s(class="side")
    end

    test "accepte un code en minuscules", %{conn: conn} do
      {:ok, code} = Ludo.Lobby.create_game(:p2, "Alice", "player-aaaa-2222")
      html = get(conn, ~p"/partie/#{String.downcase(code)}") |> html_response(200)
      assert html =~ code
    end

    test "redirige vers l'accueil si la partie n'existe pas", %{conn: conn} do
      conn = get(conn, ~p"/partie/ZZZZ")
      assert redirected_to(conn) == ~p"/"
      assert Phoenix.Flash.get(conn.assigns.flash, :error) =~ "ZZZZ"
    end
  end

  describe "GET /sante" do
    test "renvoie un état JSON", %{conn: conn} do
      body = get(conn, ~p"/sante") |> json_response(200)
      assert body["status"] == "ok"
      assert is_integer(body["games"])
    end
  end
end
