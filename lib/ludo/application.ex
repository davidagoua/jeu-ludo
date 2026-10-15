defmodule Ludo.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      LudoWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:ludo, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Ludo.PubSub},
      # Registre code -> processus de salon (lecture directe depuis les canaux).
      {Registry, keys: :unique, name: Ludo.GameRegistry},
      # Un enfant par partie, arrêté avec elle.
      {DynamicSupervisor, name: Ludo.GameSupervisor, strategy: :one_for_one},
      # Liste des parties et codes de salon.
      Ludo.Lobby,
      # Start to serve requests, typically the last entry
      LudoWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Ludo.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    LudoWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
