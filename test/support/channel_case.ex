defmodule LudoWeb.ChannelCase do
  @moduledoc """
  Cas de test pour les canaux.

  Les canaux s'appuient sur le `Ludo.Lobby` et le `DynamicSupervisor`, qui sont
  des singletons : chaque test repart donc d'un lobby vide.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      @endpoint LudoWeb.Endpoint

      import Phoenix.ChannelTest
      import LudoWeb.ChannelCase
    end
  end

  setup do
    reset_lobby()
    :ok
  end

  @doc "Arrête toutes les parties et attend que le lobby l'ait enregistré."
  def reset_lobby do
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Ludo.GameSupervisor) do
      DynamicSupervisor.terminate_child(Ludo.GameSupervisor, pid)
    end

    wait_until(fn -> Ludo.Lobby.list_games() == [] end)
  end

  @doc "Attend qu'une condition devienne vraie (ou abandonne au bout du délai)."
  def wait_until(fun, timeout \\ 2_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    cond do
      fun.() ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        :timeout

      true ->
        Process.sleep(20)
        do_wait(fun, deadline)
    end
  end
end
