defmodule LudoWeb.Router do
  use LudoWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {LudoWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", LudoWeb do
    pipe_through :browser

    get "/", PageController, :home
    get "/partie/:code", PageController, :game
    get "/regles", PageController, :rules
    get "/sante", PageController, :health
  end

  # Other scopes may use custom stacks.
  # scope "/api", LudoWeb do
  #   pipe_through :api
  # end
end
