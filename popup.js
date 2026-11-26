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
    `Conexão com Supabase: ${status.supabaseConnectionStatus === "connected" ? "conectado" : "desconectado"}`,
    `Eventos pendentes: ${status.pendingCount ?? 0}`,
    `Role usada em web_events: ${status.lastWebEventRole || "Aguardando requisição"}`,
    `Role usada em inactivity_events: ${status.lastInactivityEventRole || "Aguardando requisição"}`,
    `Último envio com sucesso: ${formatarData(status.lastSuccessAt)}`,
    `Último erro: ${status.lastError || "Nenhum"}`
  ].join("\n");
}

function renderizarEstadoAutenticacao(authState = {}) {
  const expiresAt = Number(authState.expiresAt);
  const sessionValid =
    authState.status === "authenticated" &&
    typeof authState.userId === "string" &&
    authState.userId.trim() &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now();
  document.getElementById("auth-warning").hidden = Boolean(sessionValid);
}

async function carregarEstadoAutenticacao() {
  const { portalAuthState } = await chrome.storage.local.get("portalAuthState");
  renderizarEstadoAutenticacao(portalAuthState);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "PORTAL_GET_AUTH_STATE"
    });
    if (response?.ok) {
      renderizarEstadoAutenticacao(response.authState);
    }
  } catch (error) {
    console.error(
      "[Portal Extensão][popup] Não foi possível consultar a autenticação",
      error
    );
  }
}

async function conectarAoPortal() {
  const portalUrl =
    "https://portal-produtividade.gehaka.workers.dev/";
  const portalPattern =
    "https://portal-produtividade.gehaka.workers.dev/*";
  const connectError = document.getElementById("connect-error");
  connectError.textContent = "";

  try {
    const tabs = await chrome.tabs.query({ url: portalPattern });
    const portalTab = tabs.find((tab) => typeof tab.id === "number");

    if (portalTab) {
      if (typeof portalTab.windowId === "number") {
        await chrome.windows.update(portalTab.windowId, { focused: true });
      }
      await chrome.tabs.update(portalTab.id, { active: true });
      return;
    }

    await chrome.tabs.create({ url: portalUrl });
  } catch (error) {
    console.error(
      "[Portal Extensão][popup] Não foi possível abrir o portal",
      error
    );
    connectError.textContent = "Não foi possível abrir o portal.";
  }
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

function renderizarStatusMonitoramento(status = {}) {
  const session = status.session;
  const monitorState = status.monitorState || {};
  const journey = status.journeySettings || {};
  const lines = [
    `Monitoramento: ${session ? "ativo" : "encerrado"}`,
    `Tipo: ${session ? (monitorState.exceptionalStatus === "confirmed" ? "excepcional confirmado" : status.journeyType || "regular") : "não iniciado"}`,
    `Supabase heartbeat: ${monitorState.supabaseHeartbeatStatus === "connected" ? "confirmado" : "não confirmado"}`,
    `Último heartbeat confirmado: ${formatarData(monitorState.lastSupabaseHeartbeatAt)}`,
    `Frequência heartbeat: ${monitorState.heartbeatFrequencySeconds || 30} segundos`,
    `Início da sessão: ${formatarData(session?.inicio)}`,
    `Último heartbeat válido: ${formatarData(monitorState.lastHeartbeatAt)}`,
    `Última interação: ${formatarData(monitorState.lastInteractionAt)}`,
    `Jornada: ${journey.workStart || "08:12"}–${journey.workEnd || "18:00"}`,
    `Almoço: ${journey.lunchStart || "12:00"}–${journey.lunchEnd || "13:00"}`
  ];
  document.getElementById("monitor-status").textContent = lines.join("\n");
  document.getElementById("exceptional-actions").hidden =
    monitorState.exceptionalStatus !== "pending";
}

function obterTipoJornadaTexto() {
  return "regular";
}

async function carregarStatusMonitoramento() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "PORTAL_GET_MONITOR_STATUS"
    });
    if (response?.ok) {
      renderizarStatusMonitoramento(response.status);
    }
  } catch (error) {
    document.getElementById("monitor-status").textContent =
      "Monitoramento: indisponível";
  }
}

async function responderEncerramento(type) {
  await chrome.runtime.sendMessage({ type });
  await carregarStatusMonitoramento();
}

carregarRegistros();
carregarStatusSincronizacao();
carregarEstadoAutenticacao();
carregarDiagnosticoCaptura();
carregarStatusMonitoramento();
document
  .getElementById("connect-portal")
  .addEventListener("click", () => void conectarAoPortal());
document
  .getElementById("exceptional-confirm")
  .addEventListener("click", () =>
    void responderEncerramento("PORTAL_EXCEPTIONAL_CONFIRM"));
document
  .getElementById("exceptional-end")
  .addEventListener("click", () =>
    void responderEncerramento("PORTAL_EXCEPTIONAL_END"));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.syncStatus) {
    renderizarStatusSincronizacao(changes.syncStatus.newValue);
  }
  if (changes.portalAuthState) {
    renderizarEstadoAutenticacao(changes.portalAuthState.newValue);
  }
  if (changes.captureDiagnostics) {
    renderizarDiagnosticoCaptura(changes.captureDiagnostics.newValue);
  }
  if (changes.monitorState) {
    void carregarStatusMonitoramento();
  }
});