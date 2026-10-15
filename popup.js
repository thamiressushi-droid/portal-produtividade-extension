async function carregarRegistros() {
  const dados = await chrome.storage.local.get("registros");

  const registros = dados.registros || [];

  const lista = document.getElementById("lista");

  lista.innerHTML = "";

  registros
    .slice()
    .reverse()
    .slice(0, 20)
    .forEach((item) => {
      const div = document.createElement("div");

      div.style.borderBottom = "1px solid #ddd";
      div.style.padding = "8px 0";

      div.innerHTML = `
        <strong>${item.domain}</strong><br>
        ${item.duracaoSegundos} segundos
      `;

      lista.appendChild(div);
    });
}

carregarRegistros();