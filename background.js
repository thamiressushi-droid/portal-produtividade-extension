const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";

async function obterUserId() {
  const dados = await chrome.storage.local.get([
    "portalUserId",
    "user_id"
  ]);

  console.log("📦 Storage:", dados);

  if (dados.portalUserId) {
    console.log(
      "✅ Usuário recebido do portal:",
      dados.portalUserId
    );

    return dados.portalUserId;
  }

  if (dados.user_id) {
    return dados.user_id;
  }

  console.warn(
    "⚠️ Nenhum usuário recebido do portal. Usando UUID temporário."
  );

  return "662bb8f3-684f-4a31-a34d-98195f226109";
}

const INACTIVITY_LIMIT_SECONDS = 300;
const INACTIVITY_ALARM = "portal-session-inactivity";

let currentSession = null;
let sessionOperation = Promise.resolve();

const sessionReady = chrome.storage.local
  .get("activeSession")
  .then(async ({ activeSession }) => {
    currentSession = activeSession
      ? {
          ...activeSession,
          intervalStart: activeSession.intervalStart || activeSession.inicio,
          isActive: activeSession.isActive !== false
        }
      : null;

    if (currentSession) {
      await agendarEncerramento();
    }
  })
  .catch((error) => {
    console.error("Erro ao recuperar sessão ativa:", error);
    currentSession = null;
  });

function serializarOperacao(callback) {
  sessionOperation = sessionOperation
    .then(() => sessionReady)
    .then(callback)
    .catch((error) => {
      console.error("Erro ao atualizar sessão:", error);
    });

  return sessionOperation;
}

async function persistirSessao() {
  if (currentSession) {
    await chrome.storage.local.set({
      activeSession: currentSession
    });
    return;
  }

  await chrome.storage.local.remove("activeSession");
}

async function agendarEncerramento() {
  if (!currentSession || !currentSession.isActive) {
    await chrome.alarms.clear(INACTIVITY_ALARM);
    return;
  }

  const deadline =
    new Date(currentSession.lastActivity).getTime() +
    INACTIVITY_LIMIT_SECONDS * 1000;

  await chrome.alarms.create(INACTIVITY_ALARM, {
    when: deadline
  });
}

async function encerrarSessao(endTime = Date.now(), reason = "unknown") {
  if (!currentSession) {
    return;
  }

  const inactivityDeadline =
    new Date(currentSession.lastActivity).getTime() +
    INACTIVITY_LIMIT_SECONDS * 1000;

  if (currentSession.isActive && endTime >= inactivityDeadline) {
    await registrarInatividade(inactivityDeadline);
  }

  const sessao = currentSession;
  const inicioIntervalo = new Date(
    sessao.intervalStart || sessao.inicio
  ).getTime();
  const fim = Math.max(inicioIntervalo, endTime);
  const duracaoSegundos = Math.floor((fim - inicioIntervalo) / 1000);
  const dados = obterDadosUrl(sessao.url);

  console.info(
    "[Portal Extensão][background] Sessão encerrada",
    {
      domain: dados.hostname,
      timestamp: new Date().toISOString(),
      inicio: new Date(inicioIntervalo).toISOString(),
      lastActivity: sessao.lastActivity,
      fim: new Date(fim).toISOString(),
      duracaoSegundos,
      isActive: sessao.isActive,
      reason
    }
  );

  if (duracaoSegundos >= 5) {
    const info = identificarAplicacao(
      sessao.url,
      dados.hostname,
      sessao.titulo
    );
    const registro = {
      url: dados.url,
      hostname: dados.hostname,
      pathname: dados.pathname,
      protocolo: dados.protocolo,
      empresa: info.empresa,
      aplicacao: info.aplicacao,
      categoria: info.categoria,
      titulo: sessao.titulo,
      inicio: new Date(inicioIntervalo).toISOString(),
      fim: new Date(fim).toISOString(),
      duracaoSegundos,
      is_active: sessao.isActive
    };

    await salvarRegistro(registro);
  }

  currentSession = null;
  await persistirSessao();
  await chrome.alarms.clear(INACTIVITY_ALARM);
}

async function iniciarSessao(tab, startTime = Date.now()) {
  if (!tab?.url || tab.url.startsWith("chrome://")) {
    return;
  }

  const timestamp = new Date(startTime).toISOString();
  currentSession = {
    tabId: tab.id,
    url: tab.url,
    titulo: tab.title || "",
    inicio: timestamp,
    lastActivity: timestamp,
    intervalStart: timestamp,
    isActive: true
  };

  await persistirSessao();
  await agendarEncerramento();

  const dadosAtuais = obterDadosUrl(tab.url);
  console.info(
    "[Portal Extensão][background] Nova sessão criada",
    {
      domain: dadosAtuais.hostname,
      timestamp,
      tabId: tab.id,
      url: tab.url
    }
  );
}

async function registrarTroca(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab.active) {
      return;
    }

    if (!tab.url || tab.url.startsWith("chrome://")) {
      await encerrarSessao(Date.now(), "tab_change");
      return;
    }

    await encerrarSessao(Date.now(), "tab_change");
    await iniciarSessao(tab);
  } catch (error) {
    console.error("Erro ao registrar troca de aba:", error);
  }
}

async function registrarInteracao(tabId, interaction = "unknown") {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    return;
  }

  const now = Date.now();

  if (currentSession?.tabId !== tabId) {
    await encerrarSessao(now, "tab_change");
  }

  if (!currentSession) {
    await iniciarSessao(tab, now);
    return;
  }

  if (currentSession.isActive) {
    const inactivityDeadline =
      new Date(currentSession.lastActivity).getTime() +
      INACTIVITY_LIMIT_SECONDS * 1000;

    if (now >= inactivityDeadline) {
      await registrarInatividade(inactivityDeadline);
    }
  }

  if (!currentSession.isActive) {
    await salvarIntervalo(
      currentSession,
      currentSession.intervalStart,
      now,
      false
    );
    currentSession.intervalStart = new Date(now).toISOString();
    currentSession.isActive = true;
  }

  const previousLastActivity = currentSession.lastActivity;
  currentSession.lastActivity = new Date(now).toISOString();
  console.info(
    "[Portal Extensão][background] Timestamp de atividade atualizado",
    {
      domain: obterDadosUrl(currentSession.url).hostname,
      timestamp: currentSession.lastActivity,
      previousLastActivity,
      tabId,
      interaction
    }
  );
  await persistirSessao();
  await agendarEncerramento();
}

async function registrarInatividade(timestamp = Date.now()) {
  if (!currentSession || !currentSession.isActive) {
    return;
  }

  const inactivityDeadline =
    new Date(currentSession.lastActivity).getTime() +
    INACTIVITY_LIMIT_SECONDS * 1000;

  if (timestamp < inactivityDeadline) {
    await agendarEncerramento();
    return;
  }

  const inicioIntervalo = currentSession.intervalStart || currentSession.inicio;
  await salvarIntervalo(
    currentSession,
    inicioIntervalo,
    inactivityDeadline,
    true
  );
  currentSession.intervalStart = new Date(inactivityDeadline).toISOString();
  currentSession.isActive = false;
  await persistirSessao();
  await chrome.alarms.clear(INACTIVITY_ALARM);

  console.info(
    "[Portal Extensão][background] Inatividade detectada após 5 minutos",
    {
      timestamp: new Date(inactivityDeadline).toISOString(),
      tabId: currentSession.tabId
    }
  );
}

async function salvarIntervalo(sessao, inicio, fim, isActive) {
  const inicioMs = new Date(inicio).getTime();
  const fimMs = Math.max(inicioMs, new Date(fim).getTime());
  const duracaoSegundos = Math.floor((fimMs - inicioMs) / 1000);

  if (duracaoSegundos < 5) {
    return;
  }

  const dados = obterDadosUrl(sessao.url);
  const info = identificarAplicacao(
    sessao.url,
    dados.hostname,
    sessao.titulo
  );
  const registro = {
    url: dados.url,
    hostname: dados.hostname,
    pathname: dados.pathname,
    protocolo: dados.protocolo,
    empresa: info.empresa,
    aplicacao: info.aplicacao,
    categoria: info.categoria,
    titulo: sessao.titulo,
    inicio: new Date(inicioMs).toISOString(),
    fim: new Date(fimMs).toISOString(),
    duracaoSegundos,
    is_active: isActive
  };

  await salvarRegistro(registro);
}

/**
 * Envia registro para o Supabase
 */
async function enviarParaSupabase(registro) {
  try {
    const userId = await obterUserId();

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/web_events`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({
          user_id: userId,
          domain: registro.hostname,
          started_at: registro.inicio,
          ended_at: registro.fim,
          is_active: registro.is_active,
          source: "chrome-extension"
        })
      }
    );

    if (!response.ok) {
      const erro = await response.text();

      console.error(
        "❌ Erro Supabase:",
        response.status,
        erro
      );

      return;
    }

    console.log(
      "✅ Enviado para Supabase:",
      registro.hostname
    );

  } catch (error) {
    console.error(
      "❌ Falha ao enviar:",
      error
    );
  }
}

/**
 * Identifica aplicação automaticamente
 */
function identificarAplicacao(url, hostname, titulo = "") {
  const urlLower = url.toLowerCase();
  const hostLower = hostname.toLowerCase();
  const tituloLower = titulo.toLowerCase();

  if (hostLower.includes("teams")) {
    return {
      empresa: "Microsoft",
      aplicacao: "Teams",
      categoria: "Reuniao"
    };
  }

  if (
    hostLower.includes("outlook") ||
    hostLower.includes("office")
  ) {
    return {
      empresa: "Microsoft",
      aplicacao: "Outlook",
      categoria: "Email"
    };
  }

  if (hostLower.includes("sharepoint")) {
    return {
      empresa: "Microsoft",
      aplicacao: "SharePoint",
      categoria: "Documentos"
    };
  }

  if (hostLower.includes("onedrive")) {
    return {
      empresa: "Microsoft",
      aplicacao: "OneDrive",
      categoria: "Armazenamento"
    };
  }

  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/spreadsheets/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Sheets",
      categoria: "Planilha"
    };
  }

  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/document/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Docs",
      categoria: "Documento"
    };
  }

  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/presentation/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Slides",
      categoria: "Apresentacao"
    };
  }

  if (hostLower.includes("drive.google")) {
    return {
      empresa: "Google",
      aplicacao: "Google Drive",
      categoria: "Armazenamento"
    };
  }

  if (hostLower.includes("meet.google")) {
    return {
      empresa: "Google",
      aplicacao: "Google Meet",
      categoria: "Reuniao"
    };
  }

  if (hostLower.includes("mail.google")) {
    return {
      empresa: "Google",
      aplicacao: "Gmail",
      categoria: "Email"
    };
  }

  if (hostLower.includes("github")) {
    return {
      empresa: "GitHub",
      aplicacao: "GitHub",
      categoria: "Desenvolvimento"
    };
  }

  if (hostLower.includes("gitlab")) {
    return {
      empresa: "GitLab",
      aplicacao: "GitLab",
      categoria: "Desenvolvimento"
    };
  }

  if (
    hostLower.includes("chatgpt") ||
    hostLower.includes("openai")
  ) {
    return {
      empresa: "OpenAI",
      aplicacao: "ChatGPT",
      categoria: "IA"
    };
  }

  if (hostLower.includes("claude")) {
    return {
      empresa: "Anthropic",
      aplicacao: "Claude",
      categoria: "IA"
    };
  }

  if (hostLower.includes("copilot")) {
    return {
      empresa: "Microsoft",
      aplicacao: "Copilot",
      categoria: "IA"
    };
  }

  if (hostLower.includes("whatsapp")) {
    return {
      empresa: "Meta",
      aplicacao: "WhatsApp",
      categoria: "Comunicacao"
    };
  }

  if (hostLower.includes("slack")) {
    return {
      empresa: "Slack",
      aplicacao: "Slack",
      categoria: "Comunicacao"
    };
  }

  if (hostLower.includes("discord")) {
    return {
      empresa: "Discord",
      aplicacao: "Discord",
      categoria: "Comunicacao"
    };
  }

  if (hostLower.includes("salesforce")) {
    return {
      empresa: "Salesforce",
      aplicacao: "Salesforce",
      categoria: "CRM"
    };
  }

  if (hostLower.includes("hubspot")) {
    return {
      empresa: "HubSpot",
      aplicacao: "HubSpot",
      categoria: "CRM"
    };
  }

  if (
    hostLower.includes("totvs") ||
    tituloLower.includes("totvs")
  ) {
    return {
      empresa: "TOTVS",
      aplicacao: "TOTVS",
      categoria: "ERP"
    };
  }

  return {
    empresa: "Desconhecida",
    aplicacao: hostname,
    categoria: "Nao Classificado"
  };
}

/**
 * Extrai dados da URL
 */
function obterDadosUrl(url) {
  try {
    const parsed = new URL(url);

    return {
      url: parsed.href,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      protocolo: parsed.protocol
    };
  } catch {
    return {
      url,
      hostname: "desconhecido",
      pathname: "",
      protocolo: ""
    };
  }
}

/**
 * Salva localmente e envia ao Supabase
 */
async function salvarRegistro(registro) {
  try {
    const storage = await chrome.storage.local.get("registros");

    const registros = storage.registros || [];

    registros.push(registro);

    await chrome.storage.local.set({
      registros
    });

    console.log("Registro salvo:", registro);

    await enviarParaSupabase(registro);

  } catch (error) {
    console.error("Erro ao salvar:", error);
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void serializarOperacao(() => registrarTroca(activeInfo.tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    void serializarOperacao(() => registrarTroca(tabId));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serializarOperacao(async () => {
    if (currentSession?.tabId === tabId) {
      await encerrarSessao(Date.now(), "tab_closed");
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "PORTAL_USER_ACTIVITY" || !sender.tab?.id) {
    return;
  }

  console.info(
    "[Portal Extensão][background] PORTAL_USER_ACTIVITY recebida",
    {
      domain: obterDadosUrl(sender.tab.url || message.hostname || "").hostname,
      timestamp: new Date().toISOString(),
      activityTimestamp: message.timestamp || null,
      interaction: message.interaction || "unknown",
      tabId: sender.tab.id
    }
  );

  void serializarOperacao(() =>
    registrarInteracao(sender.tab.id, message.interaction)
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== INACTIVITY_ALARM) {
    return;
  }

  void serializarOperacao(async () => {
    if (!currentSession) {
      return;
    }

    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      INACTIVITY_LIMIT_SECONDS * 1000;

    if (Date.now() < deadline) {
      await agendarEncerramento();
      return;
    }

    await encerrarSessao(deadline, "inactivity");
  });
});

chrome.idle.setDetectionInterval(INACTIVITY_LIMIT_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  if (state !== "idle" && state !== "locked") {
    return;
  }

  void serializarOperacao(() => encerrarSessao(Date.now(), "browser_idle"));
});

chrome.runtime.onStartup.addListener(() => {
  void serializarOperacao(async () => {
    if (!currentSession) {
      return;
    }

    // Do not count time while the browser was closed.
    await encerrarSessao(
      new Date(currentSession.lastActivity).getTime(),
      "browser_startup"
    );
  });
});

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      message?.type !==
      "PORTAL_IDENTITY_CHANGED"
    ) {
      return;
    }

    console.info(
      "[Portal Extensão][background] Mensagem recebida",
      {
        senderUrl: sender?.url,
        senderTabUrl: sender?.tab?.url,
        hasUserId:
          typeof message.userId === "string",
        userIdIsNull:
          message.userId === null
      }
    );

    if (
      message.userId !== null &&
      typeof message.userId !== "string"
    ) {
      console.error(
        "[Portal Extensão][background] Identidade rejeitada: userId deve ser string ou null"
      );
      sendResponse({
        ok: false,
        stage: "validation"
      });
      return;
    }

    console.info(
      "[Portal Extensão][background] Iniciando gravação no chrome.storage.local",
      {
        operation:
          message.userId === null ? "remove" : "set"
      }
    );

    const operation =
      message.userId === null
        ? chrome.storage.local.remove("portalUserId")
        : chrome.storage.local.set({
            portalUserId: message.userId
          });

    void operation
      .then(async () => {
        const stored = await chrome.storage.local.get("portalUserId");
        const persisted =
          message.userId === null
            ? !Object.hasOwn(stored, "portalUserId")
            : stored.portalUserId === message.userId;

        if (!persisted) {
          console.error(
            "[Portal Extensão][background] Storage não confirmou o valor esperado"
          );
          sendResponse({
            ok: false,
            stage: "storage_verification"
          });
          return;
        }

        console.info(
          "[Portal Extensão][background] Identidade persistida e verificada"
        );
        sendResponse({
          ok: true,
          stage: "storage"
        });
      })
      .catch((error) => {
        console.error(
          "[Portal Extensão][background] Erro ao atualizar chrome.storage.local",
          error
        );
        sendResponse({
          ok: false,
          stage: "storage"
        });
      });

    return true;
  }
);

console.info(
  "[Portal Extensão][background] Listener PORTAL_IDENTITY_CHANGED registrado",
  {
    event: "PORTAL_IDENTITY_CHANGED",
    storage: "chrome.storage.local"
  }
);

console.log("🚀 Portal Produtividade iniciado!");