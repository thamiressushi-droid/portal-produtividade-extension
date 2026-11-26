const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";
const PORTAL_URL_PATTERNS = [
  "https://*.app.github.dev/*",
  "https://portal-produtividade.gehaka.workers.dev/*"
];
const PORTAL_IDENTITY_REQUEST = "PORTAL_GET_AUTHENTICATED_USER";
const PORTAL_IDENTITY_SCRIPT = "content-portal-identity.js";
const OUTBOX_DATABASE_NAME = "portal-prod-activity";
const OUTBOX_DATABASE_VERSION = 1;
const OUTBOX_STORE_NAME = "outbox";
const OUTBOX_SYNC_ALARM = "portal-outbox-sync";
const SYNC_STATUS_STORAGE_KEY = "syncStatus";
const PORTAL_AUTH_STATE_STORAGE_KEY = "portalAuthState";
const PORTAL_AUTH_EXPIRY_ALARM = "portal-auth-expiry";
const PORTAL_USER_ID_STORAGE_KEY = "portalUserId";
const PORTAL_ACCESS_TOKEN_STORAGE_KEY = "portalAccessToken";
const INACTIVITY_EVENT_FIELDS = new Set([
  "user_id",
  "started_at",
  "ended_at",
  "classification",
  "created_at",
  "client_event_id"
]);

function prepararBodyRequisicao(endpoint, body) {
  if (endpoint.split("?")[0] !== "inactivity_events") {
    return { ...body };
  }

  return Object.fromEntries(
    Object.entries(body).filter(([field]) =>
      INACTIVITY_EVENT_FIELDS.has(field)
    )
  );
}

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

async function persistirIdentidade(
  userId,
  { name, accessToken = null, email = null, expiresAt = null } = {}
) {
  return serializarAtualizacaoAutenticacao(() =>
    atualizarSessaoAutenticacao({
      userId,
      accessToken,
      email,
      expiresAt,
      source: name
    })
  );
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

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: PORTAL_IDENTITY_REQUEST
      });
    } catch (error) {
      console.warn(
        "[Portal Extensão][background] Aba sem listener de identidade; injetando bridge",
        {
          tabId: tab.id,
          error: error.message || String(error)
        }
      );

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [PORTAL_IDENTITY_SCRIPT]
        });
        console.info(
          "[Portal Extensão][background] Bridge de identidade injetado na aba",
          { tabId: tab.id, script: PORTAL_IDENTITY_SCRIPT }
        );
        response = await chrome.tabs.sendMessage(tab.id, {
          type: PORTAL_IDENTITY_REQUEST
        });
      } catch (recoveryError) {
        console.error(
          "[Portal Extensão][background] Não foi possível consultar a identidade após injetar o bridge",
          {
            tabId: tab.id,
            error: recoveryError.message || String(recoveryError)
          }
        );
        continue;
      }
    }

    const userId =
      typeof response?.userId === "string" ? response.userId.trim() : "";
    const accessToken =
      typeof response?.accessToken === "string"
        ? response.accessToken.trim()
        : "";
    console.info(
      "[Portal Extensão][background] Resultado da consulta à sessão do portal",
      {
        tabId: tab.id,
        receivedResponse: response !== undefined,
        userId: userId || null,
        receivedJwt: Boolean(accessToken)
      }
    );
    if (userId) {
      return { userId, accessToken: accessToken || null };
    }
  }

  console.info(
    "[Portal Extensão][background] Consulta ao portal sem sessão",
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

    const portalSession = await consultarIdentidadePortal();
    if (portalSession?.userId) {
      await persistirIdentidade(portalSession.userId, {
        name: "portal_tab_recovery",
        accessToken: portalSession.accessToken
      });
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
let recoveredSessionStart = null;
let recoveredSessionBoundary = null;
let inactivityThresholdSeconds = null;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_TOLERANCE_MS = 5 * 60 * 1000;
const EXCEPTIONAL_TIMEOUT_MINUTES = 10;
const HEARTBEAT_ALARM = "portal-monitoring-heartbeat";
const SUPABASE_HEARTBEAT_ALARM = "portal-supabase-heartbeat";
const JOURNEY_SETTINGS_REFRESH_ALARM = "portal-journey-settings-refresh";
const EXCEPTIONAL_CONFIRMATION_ALARM = "portal-exceptional-confirmation";
const NOTIFICATION_ID = "portal-exceptional-work";
const DEFAULT_JOURNEY_SETTINGS = {
  workStart: "08:12",
  lunchStart: "12:00",
  lunchEnd: "13:00",
  workEnd: "18:00",
  workDays: [1, 2, 3, 4, 5],
  timezone: "America/Sao_Paulo",
  exceptionalToleranceMinutes: 10
};
let journeySettings = { ...DEFAULT_JOURNEY_SETTINGS };
let monitorState = {
  lastHeartbeatAt: null,
  lastSupabaseHeartbeatAt: null,
  lastSupabaseHeartbeatError: null,
  supabaseHeartbeatStatus: "disconnected",
  heartbeatFrequencySeconds: 30,
  lastInteractionAt: null,
  exceptionalStatus: "none",
  exceptionalPromptShownForSession: null,
  exceptionalConfirmedAt: null,
  exceptionalEndedAt: null,
  exceptionalEndReason: null,
  continuityInterruptedAt: null
};
let sessionOperation = Promise.resolve();
let sessionInitializationComplete = false;
let outboxDatabasePromise;
let synchronizationOperation = Promise.resolve();
let authenticationOperation = Promise.resolve();
let identityTransitionOperation = Promise.resolve();

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
  const requestBody = prepararBodyRequisicao(endpoint, body);
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
        body: requestBody,
        sortAt: requestBody.started_at || existing.sortAt,
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
      body: requestBody,
      createdAt: new Date().toISOString(),
      sortAt: requestBody.started_at || new Date().toISOString(),
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

function decodificarClaimsJwt(accessToken) {
  const encodedPayload = accessToken.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT da sessão do portal está malformado.");
  }

  try {
    const base64 = encodedPayload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(base64));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new Error("O payload do JWT não contém um objeto de claims.");
    }
    return claims;
  } catch (error) {
    throw new Error(`Não foi possível ler as claims do JWT: ${error.message}`);
  }
}

function converterExpiracaoToken(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue > 1_000_000_000_000
        ? numericValue
        : numericValue * 1000;
    }

    const parsedDate = Date.parse(value);
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
  }

  return null;
}

function validarSessaoPortal(userId, accessToken, expiresAt) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    typeof accessToken !== "string" ||
    !accessToken.trim()
  ) {
    return { status: "disconnected", expiresAt: null };
  }

  let claims;
  try {
    claims = decodificarClaimsJwt(accessToken);
  } catch {
    return { status: "disconnected", expiresAt: null };
  }

  const tokenExpiration = Number(claims.exp) * 1000;
  if (
    claims.role !== "authenticated" ||
    claims.sub !== userId ||
    !Number.isFinite(tokenExpiration)
  ) {
    return { status: "disconnected", expiresAt: null };
  }

  const suppliedExpiration = converterExpiracaoToken(expiresAt);
  const effectiveExpiration = suppliedExpiration
    ? Math.min(tokenExpiration, suppliedExpiration)
    : tokenExpiration;

  if (effectiveExpiration <= Date.now()) {
    return { status: "expired", expiresAt: effectiveExpiration };
  }

  return {
    status: "authenticated",
    expiresAt: effectiveExpiration
  };
}

function serializarAtualizacaoAutenticacao(callback) {
  const operation = authenticationOperation.then(callback);
  authenticationOperation = operation.catch((error) => {
    console.error(
      "[Portal Extensão][auth] Falha ao atualizar estado de autenticação",
      error
    );
  });
  return operation;
}

function agendarTransicaoDeIdentidade(userId) {
  identityTransitionOperation = identityTransitionOperation.then(() =>
    serializarOperacao(() => registrarTrocaDeIdentidade(userId))
  );
  return identityTransitionOperation;
}

async function gravarEstadoAutenticacao(
  status,
  userId = null,
  email = null,
  expiresAt = null
) {
  const authState = {
    status,
    userId,
    email,
    expiresAt,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({
    [PORTAL_AUTH_STATE_STORAGE_KEY]: authState
  });
  return authState;
}

async function removerCredenciaisPortal(
  status,
  email = null,
  expiresAt = null
) {
  await gravarEstadoAutenticacao(status, null, email, expiresAt);
  await chrome.storage.local.remove([
    PORTAL_USER_ID_STORAGE_KEY,
    PORTAL_ACCESS_TOKEN_STORAGE_KEY
  ]);
  await chrome.alarms.clear(PORTAL_AUTH_EXPIRY_ALARM);
}

async function atualizarSessaoAutenticacao({
  userId,
  accessToken,
  email,
  expiresAt,
  source
}) {
  const stored = await chrome.storage.local.get([
    PORTAL_USER_ID_STORAGE_KEY,
    PORTAL_ACCESS_TOKEN_STORAGE_KEY,
    PORTAL_AUTH_STATE_STORAGE_KEY
  ]);
  const currentUserId =
    typeof stored[PORTAL_USER_ID_STORAGE_KEY] === "string"
      ? stored[PORTAL_USER_ID_STORAGE_KEY].trim()
      : null;
  const previousState = stored[PORTAL_AUTH_STATE_STORAGE_KEY];

  if (userId === null) {
    await removerCredenciaisPortal("disconnected");
    if (currentUserId || currentSession?.userId) {
      void agendarTransicaoDeIdentidade(null);
    }
    console.info("[Portal Extensão][auth] Sessão do portal removida", {
      source,
      hadIdentity: Boolean(currentUserId)
    });
    return Boolean(currentUserId || previousState?.status !== "disconnected");
  }

  const validation = validarSessaoPortal(userId, accessToken, expiresAt);
  if (validation.status !== "authenticated") {
    await removerCredenciaisPortal(
      validation.status,
      typeof email === "string" ? email : null,
      validation.expiresAt
    );
    if (currentUserId || currentSession?.userId) {
      void agendarTransicaoDeIdentidade(null);
    }
    console.warn("[Portal Extensão][auth] Sessão inválida ou expirada", {
      source,
      status: validation.status
    });
    return false;
  }

  const normalizedUserId = userId.trim();
  const normalizedEmail =
    typeof email === "string" && email.trim() ? email.trim() : null;
  const normalizedToken = accessToken.trim();
  const authState = {
    status: "authenticated",
    userId: normalizedUserId,
    email: normalizedEmail,
    expiresAt: validation.expiresAt,
    updatedAt: new Date().toISOString()
  };
  const changed =
    currentUserId !== normalizedUserId ||
    stored[PORTAL_ACCESS_TOKEN_STORAGE_KEY] !== normalizedToken ||
    previousState?.status !== "authenticated" ||
    previousState?.expiresAt !== validation.expiresAt;

  await chrome.storage.local.set({
    [PORTAL_USER_ID_STORAGE_KEY]: normalizedUserId,
    [PORTAL_ACCESS_TOKEN_STORAGE_KEY]: normalizedToken,
    [PORTAL_AUTH_STATE_STORAGE_KEY]: authState
  });
  await chrome.alarms.create(PORTAL_AUTH_EXPIRY_ALARM, {
    when: validation.expiresAt
  });

  if (
    currentUserId !== normalizedUserId ||
    currentSession?.userId !== normalizedUserId
  ) {
    const transition = agendarTransicaoDeIdentidade(normalizedUserId);
    void transition.then(() => sincronizarOutbox());
  } else {
    void sincronizarOutbox();
  }

  console.info("[Portal Extensão][auth] Sessão do portal atualizada", {
    source,
    userId: normalizedUserId,
    hasJwt: true,
    expiresAt: new Date(validation.expiresAt).toISOString()
  });
  return changed;
}

async function validarSessaoPersistida() {
  return serializarAtualizacaoAutenticacao(async () => {
    const stored = await chrome.storage.local.get([
      PORTAL_USER_ID_STORAGE_KEY,
      PORTAL_ACCESS_TOKEN_STORAGE_KEY,
      PORTAL_AUTH_STATE_STORAGE_KEY
    ]);
    const userId =
      typeof stored[PORTAL_USER_ID_STORAGE_KEY] === "string"
        ? stored[PORTAL_USER_ID_STORAGE_KEY].trim()
        : null;
    const accessToken = stored[PORTAL_ACCESS_TOKEN_STORAGE_KEY];
    const previousState = stored[PORTAL_AUTH_STATE_STORAGE_KEY];
    const validation = validarSessaoPortal(
      userId,
      accessToken,
      previousState?.expiresAt
    );

    if (validation.status !== "authenticated") {
      const hadCredentials = Boolean(userId || accessToken);
      const status =
        !hadCredentials && previousState?.status === "expired"
          ? "expired"
          : validation.status;
      const stateChanged = previousState?.status !== status;
      if (stateChanged || hadCredentials) {
        await removerCredenciaisPortal(
          status,
          previousState?.email ?? null,
          validation.expiresAt
        );
      }
      if (userId || currentSession?.userId) {
        void agendarTransicaoDeIdentidade(null);
      }
      return {
        status,
        userId: null,
        email: previousState?.email ?? null,
        expiresAt: validation.expiresAt
      };
    }

    const authState = {
      status: "authenticated",
      userId,
      email: previousState?.email ?? null,
      expiresAt: validation.expiresAt,
      updatedAt: previousState?.updatedAt || new Date().toISOString()
    };
    if (
      previousState?.status !== "authenticated" ||
      previousState?.userId !== userId ||
      previousState?.expiresAt !== validation.expiresAt
    ) {
      await chrome.storage.local.set({
        [PORTAL_AUTH_STATE_STORAGE_KEY]: authState
      });
    }
    await chrome.alarms.create(PORTAL_AUTH_EXPIRY_ALARM, {
      when: validation.expiresAt
    });
    if (currentSession?.userId !== userId) {
      void agendarTransicaoDeIdentidade(userId);
    }
    return authState;
  });
}

function registrarRoleWebEvent(role) {
  console.info("[Portal Extensão][sync] Role da requisição web_events", {
    endpoint: "web_events",
    role
  });
  void atualizarStatusSincronizacao({ lastWebEventRole: role }).catch(
    (error) => {
      console.error(
        "[Portal Extensão][sync] Falha ao persistir diagnóstico da role web_events",
        error
      );
    }
  );
}

class SessaoPortalIndisponivelError extends Error {
  constructor() {
    super("A sessão autenticada do portal não está disponível.");
    this.name = "SessaoPortalIndisponivelError";
  }
}

class EventoIncompativelComSessaoError extends Error {
  constructor() {
    super("JWT do portal não corresponde ao user_id do evento.");
    this.name = "EventoIncompativelComSessaoError";
  }
}

async function enviarEventoPendente(event) {
  const body = prepararBodyRequisicao(event.endpoint, event.body);
  if (event.method === "POST" && !body.user_id) {
    body.user_id = await obterUserId();
    if (!body.user_id) {
      throw new SessaoPortalIndisponivelError();
    }
  }

  const tabelaDestino = event.endpoint.split("?")[0];
  // web_events e inactivity_events só aceitam escrita da role authenticated
  // (migrations 0028/0029 revogaram INSERT/UPDATE de anon).
  const exigeJwt =
    tabelaDestino === "web_events" || tabelaDestino === "inactivity_events";
  let authorization;
  if (exigeJwt) {
    const {
      [PORTAL_USER_ID_STORAGE_KEY]: portalUserId,
      [PORTAL_ACCESS_TOKEN_STORAGE_KEY]: accessToken
    } = await chrome.storage.local.get([
      PORTAL_USER_ID_STORAGE_KEY,
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    ]);

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      registrarRoleWebEvent("não enviada (JWT ausente)");
      throw new SessaoPortalIndisponivelError();
    }

    let claims;
    try {
      claims = decodificarClaimsJwt(accessToken);
    } catch (error) {
      registrarRoleWebEvent("não enviada (JWT inválido)");
      throw error;
    }
    const role =
      typeof claims.role === "string" ? claims.role : "desconhecida";
    if (role !== "authenticated") {
      registrarRoleWebEvent(`não enviada (JWT role=${role})`);
      throw new Error(
        `JWT do portal usa role=${role}; ${tabelaDestino} exige role authenticated.`
      );
    }

    // PATCH (ex.: fechar inactivity_events) não leva user_id no body:
    // nesse caso valida contra a identidade persistida do portal.
    const userIdEsperado = body.user_id ?? portalUserId;
    if (
      typeof body.user_id === "string" &&
      claims.sub === portalUserId &&
      body.user_id !== claims.sub
    ) {
      registrarRoleWebEvent("não enviada (JWT/user_id incompatíveis)");
      throw new EventoIncompativelComSessaoError();
    }

    if (
      typeof claims.sub !== "string" ||
      claims.sub !== userIdEsperado ||
      portalUserId !== userIdEsperado
    ) {
      registrarRoleWebEvent("não enviada (JWT/user_id incompatíveis)");
      throw new Error(
        `JWT do portal não corresponde ao user_id do evento; ${tabelaDestino} não será enviada.`
      );
    }

    authorization = `Bearer ${accessToken}`;
    registrarRoleWebEvent("authenticated");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${event.endpoint}`,
    {
      method: event.method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "apikey": SUPABASE_KEY,
        ...(authorization ? { "Authorization": authorization } : {}),
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
    const authState = await validarSessaoPersistida();
    if (authState.status !== "authenticated") {
      return;
    }
    await identityTransitionOperation;

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
      if (error instanceof SessaoPortalIndisponivelError) {
        return;
      }

      if (error instanceof EventoIncompativelComSessaoError) {
        await removerEventoEnviado(event);
        await atualizarStatusSincronizacao({
          lastError: null,
          lastErrorAt: null
        });
        console.warn(
          "[Portal Extensão][sync] Evento incompatível com a sessão descartado",
          { eventId: event.clientEventId, userId: event.body.user_id }
        );
        continue;
      }

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
  if (!sessionInitializationComplete) {
    return sessionReady.then(() => {
      if (sessionInitializationComplete) {
        return sincronizarOutbox();
      }
    });
  }

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

function parseTimeOfDay(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/^(\d{1,2})h(\d{2})$/i, "$1:$2");
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : fallback;
}

function minutesSinceMidnight(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function obterHorarioLocal(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: journeySettings.timezone || DEFAULT_JOURNEY_SETTINGS.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const value = {};
  for (const part of parts) value[part.type] = part.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: weekdays[value.weekday] ?? new Date(timestamp).getDay(),
    minutes: Number(value.hour) * 60 + Number(value.minute)
  };
}

function obterTipoJornada(timestamp = Date.now()) {
  const local = obterHorarioLocal(timestamp);
  if (!journeySettings.workDays.includes(local.day)) {
    return "outside";
  }
  const start = minutesSinceMidnight(journeySettings.workStart);
  const lunchStart = minutesSinceMidnight(journeySettings.lunchStart);
  const lunchEnd = minutesSinceMidnight(journeySettings.lunchEnd);
  const end = minutesSinceMidnight(journeySettings.workEnd);
  if (local.minutes >= start && local.minutes < lunchStart) return "regular";
  if (local.minutes >= lunchStart && local.minutes < lunchEnd) return "lunch";
  if (local.minutes >= lunchEnd && local.minutes < end) return "regular";
  if (local.minutes >= end) return "exceptional";
  return "outside";
}

function extrairConfiguracoesAdministrativas(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const map = new Map();
  for (const row of rows) {
    if (row?.key && Object.hasOwn(row, "value")) {
      map.set(String(row.key), row.value);
    }
  }
  if (!map.size) return null;

  const journey = map.get("work_journey");
  const journeyObject = journey && typeof journey === "object"
    ? journey
    : null;
  const effectiveFrom = typeof journeyObject?.effective_from === "string"
    ? journeyObject.effective_from
    : null;

  const inactivityMinutes = Number(map.get("inactivity_threshold_minutes"));
  const exceptionalMinutes = Number(map.get("post_work_inactivity_tolerance_minutes"));
  const heartbeatSeconds = Number(map.get("heartbeat_frequency_seconds"));

  return {
    journey: journeyObject,
    effectiveFrom,
    inactivityMinutes: Number.isFinite(inactivityMinutes) && inactivityMinutes > 0
      ? inactivityMinutes
      : 3,
    exceptionalToleranceMinutes: Number.isFinite(exceptionalMinutes) && exceptionalMinutes > 0
      ? exceptionalMinutes
      : 10,
    heartbeatFrequencySeconds: Number.isFinite(heartbeatSeconds) && heartbeatSeconds >= 5
      ? heartbeatSeconds
      : 30,
    activitiesModuleEnabled: map.get("activities_module_enabled") === true
  };
}

async function atualizarConfiguracoesAdministrativas() {
  try {
    const authState = await validarSessaoPersistida();
    if (authState.status !== "authenticated") {
      throw new Error("Autenticação indisponível para ler settings.");
    }
    const { portalAccessToken } = await chrome.storage.local.get(
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    );
    if (!portalAccessToken) {
      throw new Error("Token autenticado indisponível para ler settings.");
    }

    const keys = [
      "inactivity_threshold_minutes",
      "post_work_inactivity_tolerance_minutes",
      "heartbeat_frequency_seconds",
      "activities_module_enabled",
      "work_journey"
    ];
    const query = `select=key,value&key=in.(${keys.map(encodeURIComponent).join(",")})&limit=100`;
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?${query}`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${portalAccessToken}`
        }
      }
    );
    if (!response.ok) {
      throw new Error(`Leitura de settings falhou: ${response.status}`);
    }

    const settings = await response.json();
    const administrative = extrairConfiguracoesAdministrativas(settings);
    if (!administrative) {
      throw new Error("Nenhuma configuração administrativa válida retornada.");
    }

    const journeyObject = administrative.effectiveFrom
      ? administrative.journey
      : null;
    const canApplyJourney = !administrative.effectiveFrom ||
      administrative.effectiveFrom <= new Date().toISOString().slice(0, 10);
    if (journeyObject && canApplyJourney) {
      journeySettings = {
        workStart: parseTimeOfDay(journeyObject.entry, DEFAULT_JOURNEY_SETTINGS.workStart),
        lunchStart: parseTimeOfDay(journeyObject.lunch_start, DEFAULT_JOURNEY_SETTINGS.lunchStart),
        lunchEnd: parseTimeOfDay(journeyObject.lunch_end, DEFAULT_JOURNEY_SETTINGS.lunchEnd),
        workEnd: parseTimeOfDay(journeyObject.exit, DEFAULT_JOURNEY_SETTINGS.workEnd),
        workDays: Array.isArray(journeyObject.workdays)
          ? journeyObject.workdays
              .map(Number)
              .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          : [...DEFAULT_JOURNEY_SETTINGS.workDays],
        timezone: typeof journeyObject.timezone === "string"
          ? journeyObject.timezone
          : DEFAULT_JOURNEY_SETTINGS.timezone,
        exceptionalToleranceMinutes: administrative.exceptionalToleranceMinutes
      };
    } else if (journeyObject) {
      console.info(
        "[Portal Extensão][background] Jornada administrativa ainda não vigente",
        { effectiveFrom: administrative.effectiveFrom }
      );
    }
    if (!journeyObject) {
      journeySettings.exceptionalToleranceMinutes =
        administrative.exceptionalToleranceMinutes;
    }

    await aplicarLimiteInatividade(administrative.inactivityMinutes);
    monitorState.heartbeatFrequencySeconds =
      administrative.heartbeatFrequencySeconds;
    await chrome.storage.local.set({
      journeySettings,
      journeySettingsCacheUpdatedAt: new Date().toISOString(),
      inactivityThresholdMinutes: administrative.inactivityMinutes,
      postWorkInactivityToleranceMinutes: administrative.exceptionalToleranceMinutes,
      heartbeatFrequencySeconds: administrative.heartbeatFrequencySeconds,
      activitiesModuleEnabled: administrative.activitiesModuleEnabled,
      monitorState
    });
    await agendarHeartbeatSupabase(
      administrative.heartbeatFrequencySeconds
    );
  } catch (error) {
    console.warn(
      "[Portal Extensão][background] Configurações administrativas indisponíveis; usando último cache válido",
      error
    );
  }
}

async function persistirEstadoMonitoramento() {
  await chrome.storage.local.set({ monitorState });
}

async function confirmarHeartbeat(timestamp = Date.now()) {
  const heartbeatAt = new Date(timestamp).toISOString();
  monitorState.lastHeartbeatAt = heartbeatAt;
  if (currentSession) {
    currentSession.lastHeartbeatAt = heartbeatAt;
    await chrome.storage.local.set({
      monitorState,
      activeSession: currentSession
    });
  } else {
    await persistirEstadoMonitoramento();
  }
  await chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 0.5 });
}

async function agendarHeartbeatSupabase(frequencySeconds) {
  const seconds = Number(frequencySeconds);
  const safeSeconds = Number.isFinite(seconds) && seconds >= 5
    ? seconds
    : 30;
  monitorState.heartbeatFrequencySeconds = safeSeconds;
  await chrome.storage.local.set({ monitorState });
  await chrome.alarms.create(SUPABASE_HEARTBEAT_ALARM, {
    periodInMinutes: safeSeconds / 60
  });
}

async function enviarHeartbeatSupabase() {
  try {
    const authState = await validarSessaoPersistida();
    if (authState.status !== "authenticated" || !authState.userId) {
      monitorState.supabaseHeartbeatStatus = "disconnected";
      monitorState.lastSupabaseHeartbeatError =
        "Autenticação Supabase indisponível.";
      await persistirEstadoMonitoramento();
      return false;
    }

    const { portalAccessToken } = await chrome.storage.local.get(
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    );
    if (!portalAccessToken) {
      throw new Error("Access token autenticado indisponível.");
    }

    const extensionVersion = chrome.runtime.getManifest().version;
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/extension_heartbeats?on_conflict=user_id`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Authorization": `Bearer ${portalAccessToken}`,
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({
          user_id: authState.userId,
          extension_version: extensionVersion
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `Heartbeat Supabase falhou: ${response.status} ${await response.text()}`
      );
    }

    const confirmedAt = new Date().toISOString();
    monitorState.lastSupabaseHeartbeatAt = confirmedAt;
    monitorState.lastSupabaseHeartbeatError = null;
    monitorState.supabaseHeartbeatStatus = "connected";
    await persistirEstadoMonitoramento();
    await atualizarStatusSincronizacao({
      lastSupabaseHeartbeatAt: confirmedAt,
      supabaseConnectionStatus: "connected"
    }).catch((error) => {
      console.error(
        "[Portal Extensão][heartbeat] Falha ao persistir status de conexão",
        error
      );
    });
    return true;
  } catch (error) {
    monitorState.supabaseHeartbeatStatus = "disconnected";
    monitorState.lastSupabaseHeartbeatError =
      error.message || String(error);
    await persistirEstadoMonitoramento();
    await atualizarStatusSincronizacao({
      supabaseConnectionStatus: "disconnected",
      lastSupabaseHeartbeatError: monitorState.lastSupabaseHeartbeatError
    }).catch(() => {});
    console.warn(
      "[Portal Extensão][heartbeat] Falha na comunicação com Supabase",
      error
    );
    return false;
  }
}

function obterUltimoInstanteMonitorado(sessao = currentSession, now = Date.now()) {
  const persistedHeartbeat = Date.parse(monitorState.lastHeartbeatAt || "");
  const sessionHeartbeat = Date.parse(sessao?.lastHeartbeatAt || "");
  const heartbeatCandidates = [persistedHeartbeat, sessionHeartbeat]
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now);
  if (heartbeatCandidates.length) {
    return Math.min(...heartbeatCandidates);
  }

  const sessionEvidence = [
    sessao?.lastActivity,
    sessao?.intervalStart,
    sessao?.inicio
  ]
    .map((timestamp) => Date.parse(timestamp || ""))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now);
  return sessionEvidence.length ? Math.max(...sessionEvidence) : null;
}

async function validarContinuidade(now = Date.now()) {
  const previous = obterUltimoInstanteMonitorado(currentSession, now);
  const continuityUnconfirmed = Boolean(currentSession) &&
    ![monitorState.lastHeartbeatAt, currentSession.lastHeartbeatAt].some(
      (timestamp) => {
        const parsed = Date.parse(timestamp || "");
        return Number.isFinite(parsed) && parsed <= now;
      }
    );
  if (
    currentSession &&
    (continuityUnconfirmed ||
      (previous !== null && now - previous > HEARTBEAT_TOLERANCE_MS))
  ) {
    const sessionStart = Date.parse(currentSession.inicio || "");
    const confirmedEnd = previous ?? sessionStart;
    monitorState.continuityInterruptedAt = new Date(now).toISOString();
    if (Number.isFinite(confirmedEnd)) {
      await encerrarSessao(
        confirmedEnd,
        continuityUnconfirmed
          ? "monitoring_continuity_unconfirmed"
          : "monitoring_continuity_gap"
      );
    } else {
      console.warn(
        "[Portal Extensão][heartbeat] Sessão persistida descartada sem timestamp confiável",
        { reason: "monitoring_continuity_unconfirmed" }
      );
      currentSession = null;
      await persistirSessao();
      await chrome.alarms.clear(INACTIVITY_ALARM);
    }
    monitorState.exceptionalStatus = "none";
    await persistirEstadoMonitoramento();
  }
  if (
    obterTipoJornada(now) === "lunch" &&
    currentSession?.inactivityStartedAt
  ) {
    await finalizarEventoInatividade(now);
    currentSession.intervalStart = new Date(now).toISOString();
    currentSession.isActive = true;
    await persistirSessao();
    await chrome.alarms.clear(INACTIVITY_ALARM);
  }
  await confirmarHeartbeat(now);
  return true;
}

const sessionReady = chrome.storage.local
  .get([
    "activeSession",
    "inactivityThresholdMinutes",
    "postWorkInactivityToleranceMinutes",
    "heartbeatFrequencySeconds",
    "activitiesModuleEnabled",
    "journeySettings",
    "monitorState"
  ])
  .then(async ({
    activeSession,
    inactivityThresholdMinutes,
    postWorkInactivityToleranceMinutes,
    heartbeatFrequencySeconds,
    activitiesModuleEnabled,
    journeySettings: cachedJourney,
    monitorState: cachedMonitorState
  }) => {
    if (
      cachedJourney &&
      typeof cachedJourney === "object"
    ) {
      journeySettings = { ...DEFAULT_JOURNEY_SETTINGS, ...cachedJourney };
    }
    if (cachedMonitorState && typeof cachedMonitorState === "object") {
      monitorState = { ...monitorState, ...cachedMonitorState };
    }
    const cachedHeartbeatSeconds = Number(heartbeatFrequencySeconds);
    if (Number.isFinite(cachedHeartbeatSeconds) && cachedHeartbeatSeconds >= 5) {
      monitorState.heartbeatFrequencySeconds = cachedHeartbeatSeconds;
    }
    const cachedExceptionalMinutes =
      Number(postWorkInactivityToleranceMinutes);
    if (
      Number.isFinite(cachedExceptionalMinutes) &&
      cachedExceptionalMinutes > 0
    ) {
      journeySettings.exceptionalToleranceMinutes = cachedExceptionalMinutes;
    }
    currentSession = activeSession
      ? {
          ...activeSession,
          intervalStart: activeSession.intervalStart || activeSession.inicio,
          isActive: activeSession.isActive !== false
        }
      : null;

    recoveredSessionStart = currentSession?.inicio || null;
    recoveredSessionBoundary = obterUltimoInstanteMonitorado(
      currentSession,
      Date.now()
    );
    await validarContinuidade();

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
    await chrome.alarms.create(HEARTBEAT_ALARM, {
      periodInMinutes: 0.5
    });
    await agendarHeartbeatSupabase(
      monitorState.heartbeatFrequencySeconds || 30
    );
    void enviarHeartbeatSupabase();
    await chrome.alarms.create(JOURNEY_SETTINGS_REFRESH_ALARM, {
      periodInMinutes: 5
    });
    if (currentSession?.inactivityStartedAt && currentSession.inactivityClientEventId) {
      await enviarEventoInatividade(
        currentSession,
        currentSession.inactivityStartedAt,
        currentSession.inactivityEndedAt
      );
      await persistirSessao();
    }
    await validarSessaoPersistida();
    sessionInitializationComplete = true;
    void sincronizarOutbox();
    void atualizarLimiteInatividade();
    void atualizarConfiguracoesAdministrativas();
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
  if (!currentSession || !currentSession.isActive) {
    await chrome.alarms.clear(INACTIVITY_ALARM);
    return;
  }
  const jornada = obterTipoJornada();
  await chrome.alarms.clear(INACTIVITY_ALARM);
  if (jornada === "regular") {
    if (inactivityThresholdSeconds === null) {
      return;
    }
    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      inactivityThresholdSeconds * 1000;
    await chrome.alarms.create(INACTIVITY_ALARM, { when: deadline });
  } else if (jornada === "exceptional") {
    const toleranceMinutes =
      journeySettings.exceptionalToleranceMinutes ||
      EXCEPTIONAL_TIMEOUT_MINUTES;
    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      toleranceMinutes * 60 * 1000;
    await chrome.alarms.create(INACTIVITY_ALARM, { when: deadline });
  }
}

async function encerrarSessao(endTime = Date.now(), reason = "unknown") {
  if (!currentSession) {
    return;
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
    await validarContinuidade();

    if (!tab.active) {
      return;
    }

    if (!tab.url || tab.url.startsWith("chrome://")) {
      await encerrarSessao(Date.now(), "tab_change");
      return;
    }
    if (currentSession?.tabId === tabId && currentSession.url === tab.url) {
      return;
    }
    await encerrarSessao(Date.now(), "tab_change");
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

async function mostrarNotificacaoEncerramento() {
  if (!chrome.notifications) return false;
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: "basic",
    title: "Encerramento do expediente",
    message:
      "Seu horário regular de trabalho foi encerrado. Você ainda está realizando atividades profissionais?",
    buttons: [
      { title: "Sim, continuar monitoramento" },
      { title: "Não, encerrar expediente" }
    ],
    requireInteraction: true
  });
  return true;
}

async function confirmarContinuacaoExcepcional() {
  monitorState.exceptionalStatus = "confirmed";
  monitorState.exceptionalConfirmedAt = new Date().toISOString();
  if (!currentSession) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(
      (item) => item.url && !item.url.startsWith("chrome://")
    );
    if (tab) {
      await iniciarSessao(tab, Date.now());
    }
  } else {
    const now = Date.now();
    currentSession.lastActivity = new Date(now).toISOString();
    await persistirSessao();
    await agendarEncerramento();
  }
  await persistirEstadoMonitoramento();
  await chrome.notifications?.clear(NOTIFICATION_ID);
}

async function encerrarExcepcional(reason = "user_manual") {
  monitorState.exceptionalStatus = "ended";
  monitorState.exceptionalEndedAt = new Date().toISOString();
  monitorState.exceptionalEndReason = reason;
  monitorState.exceptionalPromptShownForSession =
    monitorState.exceptionalPromptShownForSession || "ended";
  await encerrarSessao(Date.now(), reason);
  await persistirEstadoMonitoramento();
  await chrome.notifications?.clear(NOTIFICATION_ID);
}

async function registrarInteracao(
  tabId,
  interaction = "unknown",
  windowTitle = null,
  screenName = null,
  screenContext = null
) {
  await validarContinuidade();
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    return;
  }

  const now = Date.now();
  monitorState.lastInteractionAt = new Date(now).toISOString();
  const jornada = obterTipoJornada(now);
  if (jornada === "outside") {
    await persistirEstadoMonitoramento();
    return;
  }
  if (jornada === "exceptional") {
    if (monitorState.exceptionalStatus === "ended") {
      monitorState.exceptionalStatus = "pending";
      monitorState.exceptionalPromptShownForSession =
        String(now);
      if (currentSession) {
        currentSession.lastActivity = new Date(now).toISOString();
        await persistirSessao();
        await agendarEncerramento();
      }
      await mostrarNotificacaoEncerramento();
      await persistirEstadoMonitoramento();
      return;
    }
    if (monitorState.exceptionalStatus === "pending") {
      if (currentSession) {
        currentSession.lastActivity = new Date(now).toISOString();
        await persistirSessao();
        await agendarEncerramento();
      }
      await persistirEstadoMonitoramento();
      return;
    }
    if (monitorState.exceptionalStatus === "none") {
      monitorState.exceptionalStatus = "pending";
      monitorState.exceptionalPromptShownForSession =
        String(currentSession?.inicio || now);
      await mostrarNotificacaoEncerramento();
    }
    if (
      monitorState.exceptionalStatus === "ended"
    ) {
      await persistirEstadoMonitoramento();
      return;
    }
  }

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

  if (
    currentSession.isActive &&
    obterTipoJornada(now) === "regular" &&
    inactivityThresholdSeconds !== null
  ) {
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
  await enfileirarRequisicao({
    clientEventId: sessao.inactivityClientEventId,
    endpoint: "inactivity_events?on_conflict=client_event_id",
    body: {
      client_event_id: sessao.inactivityClientEventId,
      user_id: sessao.inactivityUserId,
      started_at: startedAtIso,
      ended_at: endedAtIso,
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
  const startedAtMs = Date.parse(startedAt);
  const requestedEndMs = Number(endedAt);
  const previouslyRecordedEndMs = Date.parse(
    currentSession.inactivityEndedAt || ""
  );
  const cappedEndMs = Number.isFinite(previouslyRecordedEndMs)
    ? Math.min(previouslyRecordedEndMs, requestedEndMs)
    : requestedEndMs;
  const endedAtIso = new Date(
    Math.max(
      Number.isFinite(startedAtMs) ? startedAtMs : 0,
      Number.isFinite(cappedEndMs) ? cappedEndMs : Date.now()
    )
  ).toISOString();
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
        ended_at: endedAtIso
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
        if (currentSession?.tabId === tabId) {
          const pageUrl = tab?.url || changeInfo.url || currentSession.url;
          currentSession.url = pageUrl;
          currentSession.titulo =
            obterTituloSeguro(pageUrl, tab?.title || currentSession.titulo) || "";
          await persistirSessao();
        }
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
    void sessionReady.then(() => sincronizarOutbox());
    return;
  }

  if (alarm.name === HEARTBEAT_ALARM) {
    void serializarOperacao(() => validarContinuidade());
    return;
  }

  if (alarm.name === SUPABASE_HEARTBEAT_ALARM) {
    void enviarHeartbeatSupabase();
    return;
  }

  if (alarm.name === JOURNEY_SETTINGS_REFRESH_ALARM) {
    void serializarOperacao(() => atualizarConfiguracoesAdministrativas());
    return;
  }

  if (alarm.name === PORTAL_AUTH_EXPIRY_ALARM) {
    void validarSessaoPersistida()
      .then((authState) => {
        if (authState.status === "authenticated") {
          void sincronizarOutbox();
        }
      })
      .catch((error) => {
        console.error(
          "[Portal Extensão][auth] Falha ao verificar expiração da sessão",
          error
        );
      });
    return;
  }

  if (alarm.name === INACTIVITY_SETTINGS_REFRESH_ALARM) {
    void serializarOperacao(() => atualizarConfiguracoesAdministrativas());
    return;
  }

  if (alarm.name !== INACTIVITY_ALARM) {
    return;
  }

  void serializarOperacao(async () => {
    const lastConfirmedHeartbeat = obterUltimoInstanteMonitorado(
      currentSession,
      Date.now()
    );
    await validarContinuidade();
    if (!currentSession) {
      return;
    }
    if (
      Number.isFinite(alarm.scheduledTime) &&
      Date.now() - alarm.scheduledTime > HEARTBEAT_TOLERANCE_MS
    ) {
      await encerrarSessao(
        Math.min(
          lastConfirmedHeartbeat ?? Date.now(),
          alarm.scheduledTime
        ),
        "delayed_inactivity_alarm"
      );
      return;
    }
    const jornada = obterTipoJornada(Date.now());
    if (jornada === "lunch" || jornada === "outside") {
      await chrome.alarms.clear(INACTIVITY_ALARM);
      return;
    }
    if (jornada === "regular") {
      if (inactivityThresholdSeconds === null) {
        await chrome.alarms.clear(INACTIVITY_ALARM);
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
      return;
    }
    const toleranceMinutes =
      journeySettings.exceptionalToleranceMinutes ||
      EXCEPTIONAL_TIMEOUT_MINUTES;

    const deadline =
      new Date(currentSession.lastActivity).getTime() +
      toleranceMinutes * 60 * 1000;

    if (Date.now() < deadline) {
      await agendarEncerramento();
      return;
    }
    await encerrarExcepcional("exceptional_timeout_no_interaction");
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
    await validarContinuidade();
    if (!currentSession?.isActive) {
      return;
    }
    if (obterTipoJornada(Date.now()) !== "regular") {
      await chrome.alarms.clear(INACTIVITY_ALARM);
      return;
    }
    await registrarInatividade(Date.now());
  });
});

chrome.runtime.onStartup.addListener(() => {
  void serializarOperacao(async () => {
    if (
      !currentSession ||
      !recoveredSessionStart ||
      currentSession.inicio !== recoveredSessionStart
    ) {
      return;
    }
    if (currentSession) {
      await encerrarSessao(
        recoveredSessionBoundary ?? Date.parse(currentSession.lastActivity),
        "browser_startup"
      );
    }
    monitorState.exceptionalStatus = "none";
    monitorState.exceptionalPromptShownForSession = null;
    await persistirEstadoMonitoramento();
  });
});

if (chrome.notifications) {
  chrome.notifications.onButtonClicked.addListener(
    (notificationId, buttonIndex) => {
      if (notificationId !== NOTIFICATION_ID) return;
      void serializarOperacao(async () => {
        if (buttonIndex === 0) {
          await confirmarContinuacaoExcepcional();
        } else if (buttonIndex === 1) {
          await encerrarExcepcional("exceptional_manual_close");
        }
      });
    }
  );
  chrome.notifications.onClosed.addListener((notificationId) => {
    if (notificationId !== NOTIFICATION_ID) return;
  });
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message?.type === "PORTAL_GET_AUTH_STATE") {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false });
        return;
      }

      void validarSessaoPersistida()
        .then((authState) => sendResponse({ ok: true, authState }))
        .catch((error) => {
          console.error(
            "[Portal Extensão][auth] Falha ao consultar estado de autenticação",
            error
          );
          sendResponse({
            ok: false,
            error: error.message || String(error)
          });
        });
      return true;
    }

    if (message?.type === "PORTAL_GET_MONITOR_STATUS") {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({
        ok: true,
        status: {
          session: currentSession,
          monitorState,
          journeySettings,
          journeyType: obterTipoJornada(),
          inactivityThresholdSeconds
        }
      });
      return;
    }

    if (
      message?.type === "PORTAL_EXCEPTIONAL_CONFIRM" ||
      message?.type === "PORTAL_EXCEPTIONAL_END"
    ) {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false });
        return;
      }
      void serializarOperacao(async () => {
        if (message.type === "PORTAL_EXCEPTIONAL_CONFIRM") {
          await confirmarContinuacaoExcepcional();
        } else {
          await encerrarExcepcional("exceptional_manual_close_popup");
        }
        sendResponse({ ok: true });
      });
      return true;
    }

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
        receivedJwt:
          typeof message.accessToken === "string" &&
          Boolean(message.accessToken.trim()),
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
    const accessToken =
      typeof message.accessToken === "string"
        ? message.accessToken.trim()
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

    if (
      message.accessToken !== undefined &&
      message.accessToken !== null &&
      (typeof message.accessToken !== "string" || !accessToken)
    ) {
      console.error(
        "[Portal Extensão][background] Sessão rejeitada: accessToken inválido"
      );
      sendResponse({
        ok: false,
        stage: "validation"
      });
      return;
    }

    if (
      message.email !== undefined &&
      message.email !== null &&
      typeof message.email !== "string"
    ) {
      sendResponse({ ok: false, stage: "validation" });
      return;
    }

    if (
      message.expiresAt !== undefined &&
      message.expiresAt !== null &&
      (
        (typeof message.expiresAt !== "number" &&
          typeof message.expiresAt !== "string") ||
        converterExpiracaoToken(message.expiresAt) === null
      )
    ) {
      sendResponse({ ok: false, stage: "validation" });
      return;
    }

    void persistirIdentidade(userId, {
      name: "portal_identity_message",
      accessToken,
      email: message.email ?? null,
      expiresAt: message.expiresAt ?? null
    })
      .then(async (changed) => {
        const { [PORTAL_AUTH_STATE_STORAGE_KEY]: authState } =
          await chrome.storage.local.get(PORTAL_AUTH_STATE_STORAGE_KEY);
        sendResponse({
          ok:
            userId === null
              ? authState?.status === "disconnected"
              : authState?.status === "authenticated",
          stage: changed ? "storage" : "unchanged",
          authState
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