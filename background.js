const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";
const PORTAL_URL_PATTERNS = [
  "https://*.app.github.dev/*",
  "https://portal-produtividade.gehaka.workers.dev/*"
];
const PORTAL_IDENTITY_REQUEST = "PORTAL_GET_AUTHENTICATED_USER";
const OUTBOX_DATABASE_NAME = "portal-prod-activity";
const OUTBOX_DATABASE_VERSION = 1;
const OUTBOX_STORE_NAME = "outbox";
const OUTBOX_SYNC_ALARM = "portal-outbox-sync";
const SYNC_STATUS_STORAGE_KEY = "syncStatus";

function ehOrigemPortal(sender) {
  try {
    const senderUrl = sender?.tab?.url || sender?.url;
    const hostname = new URL(senderUrl).hostname;
    return (
      hostname.endsWith(".app.github.dev") ||
      hostname === "portal-produtividade.gehaka.workers.dev"
    );
  } catch {
    return false;
  }
}

async function lerUserIdPersistido() {
  try {
    const { portalUserId } = await chrome.storage.local.get("portalUserId");
    const userId =
      typeof portalUserId === "string" ? portalUserId.trim() : "";

    console.info("[Portal Extensão][background] Leitura da identidade", {
      portalUserId: userId || null,
      found: Boolean(userId)
    });
    return userId || null;
  } catch (error) {
    console.error(
      "[Portal Extensão][background] Falha ao ler identidade persistida",
      error
    );
    throw error;
  }
}

async function persistirIdentidade(userId, source) {
  const identityStorageKey = "portalUserId";
  const { portalUserId } = await chrome.storage.local.get(identityStorageKey);
  const currentUserId =
    typeof portalUserId === "string" ? portalUserId.trim() : "";

  console.info("[Portal Extensão][background] Leitura para persistência", {
    source,
    portalUserId: currentUserId || null,
    found: Boolean(currentUserId)
  });

  if (userId === null) {
    await chrome.storage.local.remove(identityStorageKey);
    const stored = await chrome.storage.local.get(identityStorageKey);
    if (stored[identityStorageKey] !== undefined) {
      throw new Error("Storage não confirmou a remoção da identidade.");
    }

    console.info("[Portal Extensão][background] Identidade removida", {
      source,
      portalUserId: null,
      hadIdentity: Boolean(currentUserId)
    });
  } else {
    if (currentUserId === userId) {
      console.info("[Portal Extensão][background] Identidade já persistida", {
        source,
        portalUserId: currentUserId,
        hasIdentity: true
      });
      return false;
    }

    await chrome.storage.local.set({ [identityStorageKey]: userId });
    const stored = await chrome.storage.local.get(identityStorageKey);
    if (stored[identityStorageKey] !== userId) {
      throw new Error("Storage não confirmou a identidade esperada.");
    }

    console.info("[Portal Extensão][background] Identidade gravada", {
      source,
      portalUserId: userId,
      hasIdentity: true
    });
  }

  void serializarOperacao(() => registrarTrocaDeIdentidade(userId));
  if (userId !== null) {
    void sincronizarOutbox();
  }
  return true;
}

async function consultarIdentidadePortal() {
  let portalTabs;
  try {
    portalTabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });
  } catch (error) {
    console.error(
      "[Portal Extensão][background] Falha ao consultar abas do portal",
      error
    );
    throw error;
  }
  console.info(
    "[Portal Extensão][background] Resultado da consulta de abas do portal",
    {
      tabCount: portalTabs.length,
      tabs: portalTabs.map(({ id, url }) => ({
        tabId: id,
        hostname: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })()
      }))
    }
  );

  for (const tab of portalTabs) {
    if (typeof tab.id !== "number") {
      continue;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: PORTAL_IDENTITY_REQUEST
      });
      const userId =
        typeof response?.userId === "string" ? response.userId.trim() : "";
      console.info(
        "[Portal Extensão][background] Resultado da consulta à aba do portal",
        {
          tabId: tab.id,
          receivedResponse: response !== undefined,
          userId: userId || null
        }
      );
      if (userId) {
        return userId;
      }
    } catch (error) {
      console.warn(
        "[Portal Extensão][background] Consulta à aba do portal falhou",
        {
          tabId: tab.id,
          error: error.message || String(error)
        }
      );
    }
  }

  console.info(
    "[Portal Extensão][background] Consulta ao portal sem identidade",
    { userId: null }
  );
  return null;
}

async function obterUserId() {
  try {
    const persistedUserId = await lerUserIdPersistido();
    if (persistedUserId) {
      console.info("[Portal Extensão][background] Resultado de obterUserId()", {
        userId: persistedUserId,
        source: "chrome.storage.local"
      });
      return persistedUserId;
    }

    const userId = await consultarIdentidadePortal();
    if (userId) {
      await persistirIdentidade(userId, "portal_tab_recovery");
      const recoveredUserId = await lerUserIdPersistido();
      console.info("[Portal Extensão][background] Resultado de obterUserId()", {
        userId: recoveredUserId,
        source: "portal_tab_recovery"
      });
      return recoveredUserId;
    }

    console.warn("[Portal Extensão][background] Resultado de obterUserId()", {
      userId: null,
      source: "no_persisted_identity_or_portal_response"
    });
    return null;
  } catch (error) {
    console.error("[Portal Extensão][background] obterUserId() falhou", error);
    throw error;
  }
}

const INACTIVITY_SETTINGS_KEY = "inactivity_threshold_minutes";
const INACTIVITY_SETTINGS_REFRESH_ALARM = "portal-inactivity-settings-refresh";
const INACTIVITY_ALARM = "portal-session-inactivity";
const PRIVATE_APPLICATIONS = [
  {
    name: "Copilot",
    domains: [
      "copilot.microsoft.com",
      "copilot.com",
      "m365.cloud.microsoft"
    ]
  },
  { name: "ChatGPT", domains: ["chatgpt.com", "chat.openai.com"] },
  { name: "Claude", domains: ["claude.ai"] },
  { name: "Gemini", domains: ["gemini.google.com"] },
  { name: "WhatsApp", domains: ["whatsapp.com"] },
  {
    name: "Teams",
    domains: [
      "teams.microsoft.com",
      "teams.live.com",
      "teams.cloud.microsoft",
      "teams.microsoft.us"
    ]
  },
  {
    name: "Outlook",
    domains: [
      "outlook.com",
      "outlook.live.com",
      "outlook.office.com",
      "outlook.office365.com",
      "outlook.office365.us",
      "outlook.cloud.microsoft"
    ]
  },
  { name: "Gmail", domains: ["mail.google.com"] },
  { name: "Slack", domains: ["slack.com"] },
  { name: "Discord", domains: ["discord.com"] }
];

let currentSession = null;
let inactivityThresholdSeconds = null;
let sessionOperation = Promise.resolve();
let outboxDatabasePromise;
let synchronizationOperation = Promise.resolve();

function abrirOutboxDatabase() {
  if (!outboxDatabasePromise) {
    outboxDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(
        OUTBOX_DATABASE_NAME,
        OUTBOX_DATABASE_VERSION
      );

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(OUTBOX_STORE_NAME)
          ? request.transaction.objectStore(OUTBOX_STORE_NAME)
          : database.createObjectStore(OUTBOX_STORE_NAME, {
            keyPath: "id",
            autoIncrement: true
          });
        if (!store.indexNames.contains("clientEventId")) {
          store.createIndex("clientEventId", "clientEventId", {
            unique: true
          });
        }
        if (!store.indexNames.contains("chronological")) {
          store.createIndex("chronological", ["sortAt", "id"]);
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          outboxDatabasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        outboxDatabasePromise = null;
        reject(request.error || new Error("Não foi possível abrir o outbox."));
      };
      request.onblocked = () => {
        outboxDatabasePromise = null;
        reject(new Error("A abertura do outbox IndexedDB foi bloqueada."));
      };
    });
  }

  return outboxDatabasePromise;
}

function aguardarTransacao(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("Transação IndexedDB cancelada."));
    transaction.onerror = () =>
      reject(transaction.error || new Error("Falha na transação IndexedDB."));
  });
}

function criarIdEvento() {
  return crypto.randomUUID();
}

async function contarEventosPendentes() {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
  const completion = aguardarTransacao(transaction);
  const request = transaction.objectStore(OUTBOX_STORE_NAME).count();
  const count = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Falha ao contar eventos pendentes."));
  });
  await completion;
  return count;
}

async function atualizarStatusSincronizacao(updates = {}) {
  const pendingCount = await contarEventosPendentes();
  const { [SYNC_STATUS_STORAGE_KEY]: previousStatus = {} } =
    await chrome.storage.local.get(SYNC_STATUS_STORAGE_KEY);
  const syncStatus = {
    ...previousStatus,
    ...updates,
    pendingCount
  };
  await chrome.storage.local.set({ [SYNC_STATUS_STORAGE_KEY]: syncStatus });
  return syncStatus;
}

async function enfileirarRequisicao({
  clientEventId = criarIdEvento(),
  endpoint,
  method = "POST",
  body
}) {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(
    OUTBOX_STORE_NAME,
    "readwrite",
    { durability: "strict" }
  );
  const completion = aguardarTransacao(transaction);
  const store = transaction.objectStore(OUTBOX_STORE_NAME);
  const lookup = store.index("clientEventId").get(clientEventId);

  lookup.onsuccess = () => {
    const existing = lookup.result;
    if (existing) {
      store.put({
        ...existing,
        endpoint,
        method,
        body,
        sortAt: body.started_at || existing.sortAt,
        revision: existing.revision + 1,
        attempts: 0,
        nextAttemptAt: 0
      });
      return;
    }

    store.add({
      clientEventId,
      endpoint,
      method,
      body,
      createdAt: new Date().toISOString(),
      sortAt: body.started_at || new Date().toISOString(),
      revision: 1,
      attempts: 0,
      nextAttemptAt: 0
    });
  };

  await completion;
  try {
    await atualizarStatusSincronizacao();
  } catch (error) {
    console.error(
      "[Portal Extensão][sync] Evento persistido, mas não foi possível atualizar o status",
      error
    );
  }
  void sincronizarOutbox();
  return clientEventId;
}

async function obterProximoEventoPendente() {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
  const completion = aguardarTransacao(transaction);
  const cursorRequest = transaction
    .objectStore(OUTBOX_STORE_NAME)
    .index("chronological")
    .openCursor();
  const event = await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () =>
      resolve(cursorRequest.result?.value || null);
    cursorRequest.onerror = () =>
      reject(cursorRequest.error || new Error("Falha ao ler o outbox."));
  });
  await completion;
  return event;
}

async function removerEventoEnviado(event) {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(
    OUTBOX_STORE_NAME,
    "readwrite",
    { durability: "strict" }
  );
  const completion = aguardarTransacao(transaction);
  const store = transaction.objectStore(OUTBOX_STORE_NAME);
  const request = store.get(event.id);
  request.onsuccess = () => {
    if (request.result?.revision === event.revision) {
      store.delete(event.id);
    }
  };
  await completion;
}

async function registrarFalhaDeEnvio(event, error) {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(
    OUTBOX_STORE_NAME,
    "readwrite",
    { durability: "strict" }
  );
  const completion = aguardarTransacao(transaction);
  const store = transaction.objectStore(OUTBOX_STORE_NAME);
  const request = store.get(event.id);
  request.onsuccess = () => {
    const currentEvent = request.result;
    if (!currentEvent || currentEvent.revision !== event.revision) {
      return;
    }

    const attempts = currentEvent.attempts + 1;
    const retryDelayMs = Math.min(5 * 60_000, 5_000 * 2 ** (attempts - 1));
    store.put({
      ...currentEvent,
      attempts,
      nextAttemptAt: Date.now() + retryDelayMs
    });
  };
  await completion;
  await atualizarStatusSincronizacao({
    lastError: error.message || String(error),
    lastErrorAt: new Date().toISOString()
  });
}

async function enviarEventoPendente(event) {
  const body = { ...event.body };
  if (event.method === "POST" && !body.user_id) {
    body.user_id = await obterUserId();
    if (!body.user_id) {
      throw new Error("Identidade indisponível; evento mantido na fila.");
    }
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${event.endpoint}`,
    {
      method: event.method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Sincronização de ${event.endpoint} falhou: ${response.status} ${await response.text()}`
    );
  }
}

async function processarOutbox() {
  while (true) {
    const event = await obterProximoEventoPendente();
    if (!event) {
      await atualizarStatusSincronizacao();
      return;
    }

    if (event.nextAttemptAt > Date.now()) {
      return;
    }

    try {
      await enviarEventoPendente(event);
      await removerEventoEnviado(event);
      await atualizarStatusSincronizacao({
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastErrorAt: null
      });
    } catch (error) {
      await registrarFalhaDeEnvio(event, error);
      console.error(
        "[Portal Extensão][sync] Evento mantido no outbox para nova tentativa",
        { eventId: event.clientEventId, error: error.message }
      );
      return;
    }
  }
}

function sincronizarOutbox() {
  synchronizationOperation = synchronizationOperation
    .then(() => processarOutbox())
    .catch((error) => {
      console.error(
        "[Portal Extensão][sync] Falha ao processar o outbox",
        error
      );
    });
  return synchronizationOperation;
}

function obterAplicacaoPrivada(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PRIVATE_APPLICATIONS.find(({ domains }) =>
      domains.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      )
    )?.name || null;
  } catch {
    return null;
  }
}

function obterTituloSeguro(url, title) {
  const privateApplication = obterAplicacaoPrivada(url);
  if (privateApplication) {
    return privateApplication;
  }

  return typeof title === "string" && title.trim() ? title : null;
}

function obterNomeTelaSeguro(url, screenName) {
  const privateApplication = obterAplicacaoPrivada(url);
  if (privateApplication) {
    return privateApplication;
  }

  return typeof screenName === "string" && screenName.trim()
    ? screenName.trim().slice(0, 120)
    : null;
}

function obterContextoTelaSeguro(url, screenContext) {
  if (obterAplicacaoPrivada(url)) {
    return null;
  }

  return typeof screenContext === "string" && screenContext.trim()
    ? screenContext.trim().slice(0, 120)
    : null;
}

function converterLimiteInatividade(value) {
  const minutes = Number(value);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  return Math.ceil(minutes * 60);
}

function extrairValorConfiguracao(payload) {
  const candidates = [
    Array.isArray(payload) ? payload[0] : payload,
    payload?.data,
    Array.isArray(payload?.data) ? payload.data[0] : null
  ];
  const record = candidates.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      Object.hasOwn(candidate, "value")
  );

  if (record) {
    return record.value;
  }

  return typeof payload === "number" || typeof payload === "string"
    ? payload
    : undefined;
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

    const responseBody = await response.text();
    let settings;
    try {
      settings = JSON.parse(responseBody);
    } catch {
      throw new Error(
        `Resposta de settings não é JSON válido: HTTP ${response.status}; corpo=${responseBody}`
      );
    }

    const value = extrairValorConfiguracao(settings);
    console.info(
      "[Portal Extensão][background] Resposta de inactivity_threshold_minutes",
      {
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        receivedFormat: Array.isArray(settings)
          ? `array(${settings.length})`
          : typeof settings,
        receivedBody: settings,
        extractedValue: value,
        extractedType: typeof value
      }
    );

    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Configuração não retornada. Esperado, por exemplo, [{"value":5}]; recebido: ${JSON.stringify(settings)}.`
      );
    }

    if (!await aplicarLimiteInatividade(value)) {
      throw new Error(
        `Valor inválido para inactivity_threshold_minutes. Esperado número de minutos (ex.: 5); recebido ${JSON.stringify(value)} (${typeof value}).`
      );
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

    if (currentSession) {
      if (!Object.hasOwn(currentSession, "userId")) {
        currentSession.userId = await obterUserId();
      }
      currentSession.titulo = obterTituloSeguro(
        currentSession.url,
        currentSession.titulo
      ) || "";
      currentSession.windowTitle = obterTituloSeguro(
        currentSession.url,
        currentSession.windowTitle
      );
      currentSession.screenName = obterNomeTelaSeguro(
        currentSession.url,
        currentSession.screenName
      );
      currentSession.screenContext = obterContextoTelaSeguro(
        currentSession.url,
        currentSession.screenContext
      );
      await persistirSessao();
    }

    const cachedThreshold = converterLimiteInatividade(
      inactivityThresholdMinutes
    );
    if (cachedThreshold !== null) {
      inactivityThresholdSeconds = cachedThreshold;
      await chrome.idle.setDetectionInterval(
        Math.max(15, cachedThreshold)
      );
    }

    await abrirOutboxDatabase();
    await chrome.alarms.create(OUTBOX_SYNC_ALARM, {
      periodInMinutes: 1
    });
    if (
      currentSession?.inactivityStartedAt &&
      currentSession.inactivityClientEventId
    ) {
      await enviarEventoInatividade(
        currentSession,
        currentSession.inactivityStartedAt,
        currentSession.inactivityEndedAt
      );
      await persistirSessao();
    }
    void sincronizarOutbox();
    void atualizarLimiteInatividade();
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
      reason,
      userId: sessao.userId ?? null
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
      user_id: sessao.userId || null,
      titulo: obterTituloSeguro(sessao.url, sessao.titulo) || "",
      tab_title: obterTituloSeguro(sessao.url, sessao.titulo),
      window_title: obterTituloSeguro(sessao.url, sessao.windowTitle),
      screen_name: obterNomeTelaSeguro(sessao.url, sessao.screenName),
      screen_context: obterContextoTelaSeguro(
        sessao.url,
        sessao.screenContext
      ),
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
    userId: await obterUserId(),
    titulo: obterTituloSeguro(tab.url, tab.title) || "",
    windowTitle: obterTituloSeguro(tab.url, tab.windowTitle),
    screenName: obterNomeTelaSeguro(tab.url, tab.screenName),
    screenContext: obterContextoTelaSeguro(tab.url, tab.screenContext),
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
      url: tab.url,
      userId: currentSession.userId ?? null,
      screen_name: currentSession.screenName ?? null,
      screen_context: currentSession.screenContext ?? null
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

async function registrarTrocaDeIdentidade(userId) {
  const sessionUserId = currentSession?.userId ?? null;
  const hasSession = Boolean(currentSession);
  console.info(
    "[Portal Extensão][background] Avaliando troca de identidade da sessão",
    {
      requestedUserId: userId,
      sessionUserId,
      hasSession,
      action:
        !hasSession
          ? "skip_no_session"
          : currentSession.userId === userId
            ? "skip_same_identity"
            : "restart_session"
    }
  );
  if (!currentSession || currentSession.userId === userId) {
    return;
  }

  const tabId = currentSession.tabId;
  const timestamp = Date.now();
  await encerrarSessao(timestamp, "identity_change");

  const tab = await chrome.tabs.get(tabId);
  if (tab.active && tab.url && !tab.url.startsWith("chrome://")) {
    await iniciarSessao(tab, timestamp);
  }
}

async function registrarInteracao(
  tabId,
  interaction = "unknown",
  windowTitle = null,
  screenName = null,
  screenContext = null
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
    await iniciarSessao(
      { ...tab, windowTitle, screenName, screenContext },
      now
    );
    return;
  }

  if (currentSession.inactivityEndedAt) {
    await finalizarEventoInatividade(
      new Date(currentSession.inactivityEndedAt).getTime()
    );
  }

  const safeTitle = obterTituloSeguro(tab.url, tab.title);
  currentSession.titulo = safeTitle || "";
  const safeWindowTitle = obterTituloSeguro(tab.url, windowTitle);
  if (safeWindowTitle) {
    currentSession.windowTitle = safeWindowTitle;
  }
  currentSession.screenName = obterNomeTelaSeguro(tab.url, screenName);
  currentSession.screenContext = obterContextoTelaSeguro(
    tab.url,
    screenContext
  );
  console.info(
    "[Portal Extensão][background] Contexto recebido na atividade",
    {
      tabId,
      hostname: obterDadosUrl(tab.url).hostname,
      screen_name: currentSession.screenName ?? null,
      screen_context: currentSession.screenContext ?? null
    }
  );

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
  if (!sessao.inactivityClientEventId) {
    sessao.inactivityClientEventId = criarIdEvento();
  }
  if (!Object.hasOwn(sessao, "inactivityUserId")) {
    sessao.inactivityUserId = await obterUserId();
  }

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
  await enfileirarRequisicao({
    clientEventId: sessao.inactivityClientEventId,
    endpoint: "inactivity_events?on_conflict=client_event_id",
    body: {
      client_event_id: sessao.inactivityClientEventId,
      user_id: sessao.inactivityUserId,
      started_at: startedAtIso,
      ended_at: endedAtIso,
      duration_seconds: durationSeconds,
      classification: "inactive",
      created_at: startedAtIso
    }
  });

  return sessao.inactivityClientEventId;
}

async function criarEventoInatividade(startedAt) {
  if (!currentSession) {
    return;
  }

  currentSession.inactivityStartedAt = new Date(startedAt).toISOString();
  currentSession.inactivityEndedAt = null;
  currentSession.inactivityEventId = null;
  currentSession.inactivityClientEventId = criarIdEvento();
  currentSession.inactivityUserId = await obterUserId();
  await persistirSessao();

  await enviarEventoInatividade(
    currentSession,
    currentSession.inactivityStartedAt
  );
  await persistirSessao();
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

  if (currentSession.inactivityClientEventId || !currentSession.inactivityEventId) {
    if (!currentSession.inactivityClientEventId) {
      currentSession.inactivityClientEventId = criarIdEvento();
    }
    await persistirSessao();
    await enviarEventoInatividade(currentSession, startedAt, endedAtIso);
  } else {
    await enfileirarRequisicao({
      endpoint: `inactivity_events?id=eq.${encodeURIComponent(currentSession.inactivityEventId)}&ended_at=is.null`,
      method: "PATCH",
      body: {
        ended_at: endedAtIso,
        duration_seconds: durationSeconds
      }
    });
  }

  currentSession.inactivityStartedAt = null;
  currentSession.inactivityEndedAt = null;
  currentSession.inactivityEventId = null;
  currentSession.inactivityClientEventId = null;
  currentSession.inactivityUserId = null;
  await persistirSessao();
  return true;
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
    user_id: sessao.userId || null,
    titulo: obterTituloSeguro(sessao.url, sessao.titulo) || "",
    tab_title: obterTituloSeguro(sessao.url, sessao.titulo),
    window_title: obterTituloSeguro(sessao.url, sessao.windowTitle),
    screen_name: obterNomeTelaSeguro(sessao.url, sessao.screenName),
    screen_context: obterContextoTelaSeguro(
      sessao.url,
      sessao.screenContext
    ),
    inicio: new Date(inicioMs).toISOString(),
    fim: new Date(fimMs).toISOString(),
    duracaoSegundos,
    is_active: isActive
  };

  await salvarRegistro(registro);
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

  if (hostLower.includes("gemini")) {
    return {
      empresa: "Google",
      aplicacao: "Gemini",
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
 * Persiste o evento no outbox antes de iniciar qualquer sincronização.
 */
async function salvarRegistro(registro) {
  const clientEventId = criarIdEvento();
  const body = {
    client_event_id: clientEventId,
    user_id: registro.user_id ?? await obterUserId(),
    domain: registro.hostname,
    started_at: registro.inicio,
    ended_at: registro.fim,
    is_active: registro.is_active,
    tab_title: registro.tab_title,
    window_title: registro.window_title,
    screen_name: registro.screen_name,
    screen_context: registro.screen_context,
    source: "chrome-extension"
  };
  console.info("[Portal Extensão][background] Campos de contexto no outbox", {
    endpoint: "web_events?on_conflict=client_event_id",
    screen_name: body.screen_name ?? null,
    screen_context: body.screen_context ?? null
  });
  await enfileirarRequisicao({
    clientEventId,
    endpoint: "web_events?on_conflict=client_event_id",
    body
  });

  try {
    const storage = await chrome.storage.local.get("registros");
    const registros = storage.registros || [];
    registros.push({
      domain: registro.hostname,
      duracaoSegundos: registro.duracaoSegundos,
      started_at: registro.inicio,
      screen_name: registro.screen_name,
      screen_context: registro.screen_context
    });
    await chrome.storage.local.set({
      registros: registros.slice(-100)
    });
  } catch (error) {
    console.error(
      "[Portal Extensão][sync] Evento está no outbox, mas o histórico recente não foi atualizado",
      error
    );
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void serializarOperacao(() => registrarTroca(activeInfo.tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.status === "complete") {
    void serializarOperacao(async () => {
      if (changeInfo.title && currentSession?.tabId === tabId) {
        const pageUrl = tab?.url || changeInfo.url || currentSession.url;
        currentSession.titulo =
          obterTituloSeguro(pageUrl, changeInfo.title) || "";
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
      message.windowTitle,
      message.screenName,
      message.screenContext
    )
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_SYNC_ALARM) {
    void sincronizarOutbox();
    return;
  }

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

    await registrarInatividade(Date.now());
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

    if (!ehOrigemPortal(sender)) {
      console.error(
        "[Portal Extensão][background] Identidade rejeitada: origem não autorizada",
        { senderUrl: sender?.tab?.url || sender?.url }
      );
      sendResponse({
        ok: false,
        stage: "origin"
      });
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

    void persistirIdentidade(userId, "portal_identity_message")
      .then((changed) => {
        sendResponse({
          ok: true,
          stage: changed ? "storage" : "unchanged",
          ...(userId === null ? { userId: null } : {})
        });
      })
      .catch((error) => {
        console.error(
          "[Portal Extensão][background] Erro ao persistir ou remover identidade",
          error
        );
        sendResponse({
          ok: false,
          stage: "storage",
          error: error.message || String(error)
        });
      });

    return true;
  }
);

console.info(
  "[Portal Extensão][background] Listener PORTAL_IDENTITY_CHANGED registrado",
  {
    event: "PORTAL_IDENTITY_CHANGED",
    storage: "chrome.storage.local",
    retainsIdentityWhenUnavailable: true,
    removesIdentityOnExplicitLogout: true
  }
);

console.log("🚀 Portal Produtividade iniciado!");