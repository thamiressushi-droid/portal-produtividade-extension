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

function renderizarDiagnosticoCaptura(diagnostics = {}) {
  const campos = [
    ["diagnostic-url", diagnostics.url],
    ["diagnostic-tab-title", diagnostics.tab_title],
    ["diagnostic-window-title", diagnostics.window_title],
    ["diagnostic-screen-name", diagnostics.screen_name],
    ["diagnostic-screen-context", diagnostics.screen_context]
  ];

  for (const [elementId, value] of campos) {
    document.getElementById(elementId).textContent = value || "—";
  }

  const updated = diagnostics.capturedAt
    ? `Atualizado: ${formatarData(diagnostics.capturedAt)}`
    : "Aguardando clique em uma página...";
  document.getElementById("diagnostics-updated").textContent = updated;
}

async function carregarStatusSincronizacao() {
  const { syncStatus } = await chrome.storage.local.get("syncStatus");
  renderizarStatusSincronizacao(syncStatus);
}

async function carregarDiagnosticoCaptura() {
  const { captureDiagnostics } = await chrome.storage.local.get(
    "captureDiagnostics"
  );
  renderizarDiagnosticoCaptura(captureDiagnostics);
}

carregarRegistros();
carregarStatusSincronizacao();
carregarDiagnosticoCaptura();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.syncStatus) {
    renderizarStatusSincronizacao(changes.syncStatus.newValue);
  }
  if (changes.captureDiagnostics) {
    renderizarDiagnosticoCaptura(changes.captureDiagnostics.newValue);
  }
});