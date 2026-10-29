const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";

async function obterUserId() {
  const { portalUserId } = await chrome.storage.local.get("portalUserId");
  const userId =
    typeof portalUserId === "string" ? portalUserId.trim() : "";

  if (!userId) {
    throw new Error(
      "Identidade autenticada do portal indisponível; registro não enviado."
    );
  }

  console.info(
    "[Portal Extensão][background] Identidade selecionada para envio",
    { userId }
  );

  return userId;
}

const INACTIVITY_SETTINGS_KEY = "inactivity_threshold_minutes";
const INACTIVITY_SETTINGS_REFRESH_ALARM = "portal-inactivity-settings-refresh";
const INACTIVITY_ALARM = "portal-session-inactivity";

let currentSession = null;
let inactivityThresholdSeconds = null;
let sessionOperation = Promise.resolve();

function converterLimiteInatividade(value) {
  const minutes = Number(value);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  return Math.ceil(minutes * 60);
}

async function aplicarLimiteInatividade(minutes) {
  const thresholdSeconds = converterLimiteInatividade(minutes);

  if (thresholdSeconds === null) {
    return false;
  }

  inactivityThresholdSeconds = thresholdSeconds;
  await chrome.storage.local.set({
    inactivityThresholdMinutes: Number(minutes)
  });
  await chrome.idle.setDetectionInterval(Math.max(15, thresholdSeconds));

  if (currentSession?.isActive) {
    await agendarEncerramento();
  }

  return true;
}

async function atualizarLimiteInatividade() {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(INACTIVITY_SETTINGS_KEY)}&select=value&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_KEY
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Leitura de settings falhou: ${response.status}`);
    }

    const settings = await response.json();
    const value = settings?.[0]?.value;

    if (!await aplicarLimiteInatividade(value)) {
      throw new Error("inactivity_threshold_minutes ausente ou inválido.");
    }

    console.info(
      "[Portal Extensão][background] Limite de inatividade atualizado",
      { minutes: Number(value) }
    );
  } catch (error) {
    if (inactivityThresholdSeconds === null) {
      const { inactivityThresholdMinutes } = await chrome.storage.local.get(
        "inactivityThresholdMinutes"
      );
      const cachedThreshold = converterLimiteInatividade(
        inactivityThresholdMinutes
      );

      if (cachedThreshold !== null) {
        inactivityThresholdSeconds = cachedThreshold;
        await chrome.idle.setDetectionInterval(
          Math.max(15, cachedThreshold)
        );
      }
    }

    console.error(
      "[Portal Extensão][background] Não foi possível atualizar o limite de inatividade; usando último valor válido",
      error
    );
  }
}

const sessionReady = chrome.storage.local
  .get(["activeSession", "inactivityThresholdMinutes"])
  .then(async ({ activeSession, inactivityThresholdMinutes }) => {
    currentSession = activeSession
      ? {
          ...activeSession,
          intervalStart: activeSession.intervalStart || activeSession.inicio,
          isActive: activeSession.isActive !== false
        }
      : null;

    const cachedThreshold = converterLimiteInatividade(
      inactivityThresholdMinutes
    );
    if (cachedThreshold !== null) {
      inactivityThresholdSeconds = cachedThreshold;
      await chrome.idle.setDetectionInterval(
        Math.max(15, cachedThreshold)
      );
    }

    await atualizarLimiteInatividade();
    const settingsRefreshAlarm = await chrome.alarms.get(
      INACTIVITY_SETTINGS_REFRESH_ALARM
    );
    if (!settingsRefreshAlarm) {
      await chrome.alarms.create(INACTIVITY_SETTINGS_REFRESH_ALARM, {
        periodInMinutes: 5
      });
    }

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
  if (
    !currentSession ||
    !currentSession.isActive ||
    inactivityThresholdSeconds === null
  ) {
    await chrome.alarms.clear(INACTIVITY_ALARM);
    return;
  }

  const deadline =
    new Date(currentSession.lastActivity).getTime() +
    inactivityThresholdSeconds * 1000;

  await chrome.alarms.create(INACTIVITY_ALARM, {
    when: deadline
  });
}

async function encerrarSessao(endTime = Date.now(), reason = "unknown") {
  if (!currentSession) {
    return;
  }

  if (currentSession.isActive && inactivityThresholdSeconds !== null) {
    const inactivityDeadline =
      new Date(currentSession.lastActivity).getTime() +
      inactivityThresholdSeconds * 1000;

    if (endTime >= inactivityDeadline) {
      await registrarInatividade(inactivityDeadline);
    }
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
    const info = identificarAplicacao(sessao.url, dados.hostname);
    const registro = {
      url: dados.url,
      hostname: dados.hostname,
      pathname: dados.pathname,
      protocolo: dados.protocolo,
      empresa: info.empresa,
      aplicacao: info.aplicacao,
      categoria: info.categoria,
      titulo: sessao.titulo,
      tab_title: sessao.titulo || null,
      window_title: sessao.windowTitle || null,
      inicio: new Date(inicioIntervalo).toISOString(),
      fim: new Date(fim).toISOString(),
      duracaoSegundos,
      is_active: sessao.isActive
    };

    await salvarRegistro(registro);
  }

  if (currentSession?.inactivityStartedAt) {
    await finalizarEventoInatividade(fim);
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
    windowTitle: tab.windowTitle || null,
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

async function registrarInteracao(
  tabId,
  interaction = "unknown",
  windowTitle = null
) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    return;
  }

  const now = Date.now();

  if (currentSession?.tabId !== tabId) {
    await encerrarSessao(now, "tab_change");
  }

  if (!currentSession) {
    await iniciarSessao({ ...tab, windowTitle }, now);
    return;
  }

  if (currentSession.inactivityEndedAt) {
    await finalizarEventoInatividade(
      new Date(currentSession.inactivityEndedAt).getTime()
    );
  }

  currentSession.titulo = tab.title || currentSession.titulo || "";
  if (typeof windowTitle === "string" && windowTitle.trim()) {
    currentSession.windowTitle = windowTitle;
  }

  if (currentSession.isActive) {
    const inactivityDeadline =
      new Date(currentSession.lastActivity).getTime() +
      (inactivityThresholdSeconds ?? Infinity) * 1000;

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
    await finalizarEventoInatividade(now);
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
  if (
    !currentSession ||
    !currentSession.isActive ||
    inactivityThresholdSeconds === null
  ) {
    return;
  }

  const inactivityDeadline =
    new Date(currentSession.lastActivity).getTime() +
    inactivityThresholdSeconds * 1000;

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
  await criarEventoInatividade(currentSession.intervalStart);
  await chrome.alarms.clear(INACTIVITY_ALARM);

  console.info(
    "[Portal Extensão][background] Inatividade detectada",
    {
      timestamp: new Date(inactivityDeadline).toISOString(),
      thresholdSeconds: inactivityThresholdSeconds,
      tabId: currentSession.tabId
    }
  );
}

async function enviarEventoInatividade(sessao, startedAt, endedAt = null) {
  const userId = await obterUserId();
  const startedAtIso = new Date(startedAt).toISOString();
  const endedAtIso = endedAt ? new Date(endedAt).toISOString() : null;
  const durationSeconds = endedAtIso
    ? Math.max(
        0,
        Math.floor(
          (new Date(endedAtIso).getTime() -
            new Date(startedAtIso).getTime()) /
            1000
        )
      )
    : null;
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/inactivity_events`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        user_id: userId,
        domain: obterDadosUrl(sessao.url).hostname,
        started_at: startedAtIso,
        ended_at: endedAtIso,
        duration_seconds: durationSeconds,
        source: "chrome-extension"
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Criação de inactivity_event falhou: ${response.status} ${await response.text()}`
    );
  }

  const rows = await response.json();
  return rows?.[0]?.id ?? null;
}

async function criarEventoInatividade(startedAt) {
  if (!currentSession) {
    return;
  }

  currentSession.inactivityStartedAt = new Date(startedAt).toISOString();
  currentSession.inactivityEndedAt = null;
  currentSession.inactivityEventId = null;
  await persistirSessao();

  try {
    currentSession.inactivityEventId = await enviarEventoInatividade(
      currentSession,
      currentSession.inactivityStartedAt
    );
    await persistirSessao();
  } catch (error) {
    console.error(
      "[Portal Extensão][background] Falha ao criar inactivity_event",
      error
    );
  }
}

async function finalizarEventoInatividade(endedAt) {
  if (!currentSession?.inactivityStartedAt) {
    return true;
  }

  const startedAt = currentSession.inactivityStartedAt;
  const endedAtIso = currentSession.inactivityEndedAt ||
    new Date(endedAt).toISOString();
  const durationSeconds = Math.max(
    0,
    Math.floor(
      (new Date(endedAtIso).getTime() - new Date(startedAt).getTime()) /
        1000
    )
  );
  currentSession.inactivityEndedAt = endedAtIso;
  await persistirSessao();

  try {
    if (currentSession.inactivityEventId) {
      const userId = await obterUserId();
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/inactivity_events?id=eq.${encodeURIComponent(currentSession.inactivityEventId)}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            ended_at: endedAtIso,
            duration_seconds: durationSeconds
          })
        }
      );

      if (!response.ok) {
        throw new Error(
          `Finalização de inactivity_event falhou: ${response.status} ${await response.text()}`
        );
      }
    } else {
      currentSession.inactivityEventId = await enviarEventoInatividade(
        currentSession,
        startedAt,
        endedAtIso
      );
    }

    currentSession.inactivityStartedAt = null;
    currentSession.inactivityEndedAt = null;
    currentSession.inactivityEventId = null;
    await persistirSessao();
    return true;
  } catch (error) {
    console.error(
      "[Portal Extensão][background] Falha ao finalizar inactivity_event",
      error
    );
    return false;
  }
}

async function salvarIntervalo(sessao, inicio, fim, isActive) {
  const inicioMs = new Date(inicio).getTime();
  const fimMs = Math.max(inicioMs, new Date(fim).getTime());
  const duracaoSegundos = Math.floor((fimMs - inicioMs) / 1000);

  if (duracaoSegundos < 5) {
    return;
  }

  const dados = obterDadosUrl(sessao.url);
  const info = identificarAplicacao(sessao.url, dados.hostname);
  const registro = {
    url: dados.url,
    hostname: dados.hostname,
    pathname: dados.pathname,
    protocolo: dados.protocolo,
    empresa: info.empresa,
    aplicacao: info.aplicacao,
    categoria: info.categoria,
    titulo: sessao.titulo,
    tab_title: sessao.titulo || null,
    window_title: sessao.windowTitle || null,
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

    console.info(
      "[Portal Extensão][background] Enviando web_event",
      {
        user_id: userId,
        domain: registro.hostname,
        started_at: registro.inicio,
        ended_at: registro.fim
      }
    );

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
          tab_title: registro.tab_title,
          window_title: registro.window_title,
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
function identificarAplicacao(url, hostname) {
  const urlLower = url.toLowerCase();
  const hostLower = hostname.toLowerCase();

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

  if (hostLower.includes("totvs")) {
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
  if (changeInfo.title || changeInfo.status === "complete") {
    void serializarOperacao(async () => {
      if (changeInfo.title && currentSession?.tabId === tabId) {
        currentSession.titulo = changeInfo.title;
        await persistirSessao();
      }

      if (changeInfo.status === "complete") {
        await registrarTroca(tabId);
      }
    });
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
    registrarInteracao(
      sender.tab.id,
      message.interaction,
      message.windowTitle
    )
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === INACTIVITY_SETTINGS_REFRESH_ALARM) {
    void serializarOperacao(() => atualizarLimiteInatividade());
    return;
  }

  if (alarm.name !== INACTIVITY_ALARM) {
    return;
  }

  void serializarOperacao(async () => {
    if (!currentSession || inactivityThresholdSeconds === null) {
      return;
    }

    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      inactivityThresholdSeconds * 1000;

    if (Date.now() < deadline) {
      await agendarEncerramento();
      return;
    }

    await registrarInatividade(deadline);
  });
});

chrome.idle.onStateChanged.addListener((state) => {
  if (
    (state !== "idle" && state !== "locked") ||
    inactivityThresholdSeconds === null
  ) {
    return;
  }

  void serializarOperacao(async () => {
    if (!currentSession?.isActive) {
      return;
    }

    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      inactivityThresholdSeconds * 1000;
    await registrarInatividade(deadline);
  });
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

    const userId =
      typeof message.userId === "string"
        ? message.userId.trim()
        : null;

    if (userId === "") {
      console.error(
        "[Portal Extensão][background] Identidade rejeitada: userId vazio"
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
          userId === null ? "remove" : "set",
        userId
      }
    );

    const operation =
      userId === null
        ? chrome.storage.local.remove("portalUserId")
        : chrome.storage.local.set({
            portalUserId: userId
          });

    void operation
      .then(async () => {
        const stored = await chrome.storage.local.get("portalUserId");
        const persisted =
          userId === null
            ? !Object.hasOwn(stored, "portalUserId")
            : stored.portalUserId === userId;

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
          "[Portal Extensão][background] Identidade persistida e verificada",
          {
            userId: userId === null ? null : stored.portalUserId
          }
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