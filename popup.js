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

function formatarData(valor) {
  if (!valor) {
    return "Nunca";
  }

  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? "Indisponível" : data.toLocaleString();
}

function renderizarStatusSincronizacao(status = {}) {
  const elemento = document.getElementById("sync-status");
  elemento.textContent = [
    `Eventos pendentes: ${status.pendingCount ?? 0}`,
    `Último envio com sucesso: ${formatarData(status.lastSuccessAt)}`,
    `Último erro: ${status.lastError || "Nenhum"}`
  ].join("\n");
}

async function carregarStatusSincronizacao() {
  const { syncStatus } = await chrome.storage.local.get("syncStatus");
  renderizarStatusSincronizacao(syncStatus);
}

carregarRegistros();
carregarStatusSincronizacao();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.syncStatus) {
    renderizarStatusSincronizacao(changes.syncStatus.newValue);
  }
});