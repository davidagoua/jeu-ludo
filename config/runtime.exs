import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/ludo start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :ludo, LudoWeb.Endpoint, server: true
end

config :ludo, LudoWeb.Endpoint, http: [port: String.to_integer(System.get_env("PORT", "4000"))]

if config_env() == :dev do
  # Reload browser tabs when matching files change.
  config :ludo, LudoWeb.Endpoint,
    live_reload: [
      web_console_logger: true,
      patterns: [
        # Static assets, except user uploads
        ~r"priv/static/(?!uploads/).*\.(js|css|png|jpeg|jpg|gif|svg)$"E,
        # Router, Controllers, LiveViews and LiveComponents
        ~r"lib/ludo_web/router\.ex$"E,
        ~r"lib/ludo_web/(controllers|live|components)/.*\.(ex|heex)$"E
      ]
    ]
end

if config_env() == :prod do
  # Clé de signature des cookies. Toutes les données de partie vivent en mémoire
  # et l'identité du joueur est conservée par le navigateur (localStorage) : ce
  # secret ne protège donc aucune session serveur. Fournissez SECRET_KEY_BASE
  # pour figer la valeur ; sinon on en tire une au démarrage, ce qui permet de
  # lancer le conteneur sans aucune configuration.
  secret_key_base =
    case System.get_env("SECRET_KEY_BASE") do
      # `nil` (variable absente) comme `""` (variable définie mais vide, ce que
      # produit une substitution docker-compose non renseignée) déclenchent la
      # génération.
      value when value in [nil, ""] ->
        IO.puts(
          :stderr,
          "[ludo] SECRET_KEY_BASE absent : un secret aléatoire a été généré pour ce démarrage."
        )

        :crypto.strong_rand_bytes(64) |> Base.encode64()

      value ->
        value
    end

  host = System.get_env("PHX_HOST") || "localhost"
  port = String.to_integer(System.get_env("PORT") || "4000")
  scheme = System.get_env("PHX_SCHEME") || "http"

  # Phoenix refuse par défaut les WebSockets dont l'origine ne correspond pas à
  # `url[:host]`. En auto-hébergement (IP locale, nom de domaine, reverse proxy)
  # cela couperait le jeu : on rend donc la vérification réglable.
  #
  #   CHECK_ORIGIN absent   -> vérification stricte sur PHX_HOST
  #   CHECK_ORIGIN=false    -> aucune vérification
  #   CHECK_ORIGIN=a.com,b  -> liste d'origines autorisées
  check_origin =
    case System.get_env("CHECK_ORIGIN") do
      nil -> true
      "true" -> true
      "false" -> false
      list -> list |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
    end

  config :ludo, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :ludo, LudoWeb.Endpoint,
    url: [host: host, port: port, scheme: scheme],
    check_origin: check_origin,
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://bandit.hexdocs.pm/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :ludo, LudoWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://plug.hexdocs.pm/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :ludo, LudoWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end
