(() => {
  console.log("Portal identity bridge carregado");

  window.addEventListener("message", (event) => {
    console.log("Mensagem recebida:", event.data);
  });
})();