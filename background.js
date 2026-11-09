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

async function persistirIdentidade(userId, { name, accessToken = null }) {
  const {
    [PORTAL_USER_ID_STORAGE_KEY]: portalUserId,
    [PORTAL_ACCESS_TOKEN_STORAGE_KEY]: portalAccessToken
  } = await chrome.storage.local.get([
    PORTAL_USER_ID_STORAGE_KEY,
    PORTAL_ACCESS_TOKEN_STORAGE_KEY
  ]);
  const currentUserId =
    typeof portalUserId === "string" ? portalUserId.trim() : "";
  const currentAccessToken =
    typeof portalAccessToken === "string" ? portalAccessToken : "";
  const normalizedAccessToken =
    typeof accessToken === "string" && accessToken.trim()
      ? accessToken.trim()
      : null;

  if (userId !== null) {
    if (!normalizedAccessToken) {
      throw new Error("A identidade do portal não veio acompanhada do JWT.");
    }

    const claims = decodificarClaimsJwt(normalizedAccessToken);
    if (claims.sub !== userId || claims.role !== "authenticated") {
      throw new Error(
        "A identidade recebida não corresponde ao usuário autenticado do JWT."
      );
    }
  } else if (normalizedAccessToken) {
    throw new Error("Logout do portal não pode incluir um JWT.");
  }

  console.info("[Portal Extensão][background] Leitura para persistência", {
    source: name,
    portalUserId: currentUserId || null,
    found: Boolean(currentUserId),
    receivedJwt: Boolean(normalizedAccessToken)
  });

  if (userId === null) {
    await chrome.storage.local.remove([
      PORTAL_USER_ID_STORAGE_KEY,
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    ]);
    const stored = await chrome.storage.local.get([
      PORTAL_USER_ID_STORAGE_KEY,
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    ]);
    if (
      stored[PORTAL_USER_ID_STORAGE_KEY] !== undefined ||
      stored[PORTAL_ACCESS_TOKEN_STORAGE_KEY] !== undefined
    ) {
      throw new Error("Storage não confirmou a remoção da identidade.");
    }

    console.info("[Portal Extensão][background] Identidade removida", {
      source: name,
      portalUserId: null,
      hadIdentity: Boolean(currentUserId)
    });
  } else {
    const identityChanged = currentUserId !== userId;
    const tokenChanged =
      normalizedAccessToken !== null &&
      normalizedAccessToken !== currentAccessToken;
    if (!identityChanged && !tokenChanged) {
      console.info("[Portal Extensão][background] Identidade já persistida", {
        source: name,
        portalUserId: currentUserId,
        hasIdentity: true,
        hasJwt: Boolean(currentAccessToken)
      });
      return false;
    }

    await chrome.storage.local.set({
      [PORTAL_USER_ID_STORAGE_KEY]: userId,
      ...(normalizedAccessToken
        ? { [PORTAL_ACCESS_TOKEN_STORAGE_KEY]: normalizedAccessToken }
        : {})
    });
    const stored = await chrome.storage.local.get([
      PORTAL_USER_ID_STORAGE_KEY,
      PORTAL_ACCESS_TOKEN_STORAGE_KEY
    ]);
    if (
      stored[PORTAL_USER_ID_STORAGE_KEY] !== userId ||
      (normalizedAccessToken &&
        stored[PORTAL_ACCESS_TOKEN_STORAGE_KEY] !== normalizedAccessToken)
    ) {
      throw new Error("Storage não confirmou a identidade esperada.");
    }

    console.info("[Portal Extensão][background] Identidade gravada", {
      source: name,
      portalUserId: userId,
      hasIdentity: true,
      hasJwt: Boolean(stored[PORTAL_ACCESS_TOKEN_STORAGE_KEY])
    });
  }

  if ((currentUserId || null) !== userId) {
    void serializarOperacao(() => registrarTrocaDeIdentidade(userId));
  }
  if (userId !== null && normalizedAccessToken) {
    void sincronizarOutbox();
  }
  return true;
}

async function consultarIdentidadePortal() {
  let portalTabs;
  let receivedIdentityResponse = false;
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

    receivedIdentityResponse ||= response !== undefined;
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
    {
      userId: null,
      receivedIdentityResponse
    }
  );
  return receivedIdentityResponse
    ? { userId: null, accessToken: null }
    : null;
}

async function obterIdentidadePortalAtual() {
  const portalSession = await consultarIdentidadePortal();
  if (portalSession === null) {
    const persistedUserId = await lerUserIdPersistido();
    console.warn(
      "[Portal Extensão][background] Sessão do portal indisponível; identidade local não será usada como fonte de autenticação",
      { storedUserId: persistedUserId }
    );
    return null;
  }

  if (!portalSession.userId) {
    console.info(
      "[Portal Extensão][background] Portal respondeu sem sessão autenticada",
      { storedUserId: await lerUserIdPersistido() }
    );
    return null;
  }

  if (!portalSession.accessToken) {
    throw new Error(
      "A sessão atual do portal não forneceu um JWT; a identidade não será usada."
    );
  }

  const claims = decodificarClaimsJwt(portalSession.accessToken);
  if (
    claims.sub !== portalSession.userId ||
    claims.role !== "authenticated"
  ) {
    throw new Error(
      "A sessão atual do portal e o usuário autenticado do JWT não correspondem."
    );
  }

  await persistirIdentidade(portalSession.userId, {
    name: "portal_active_session",
    accessToken: portalSession.accessToken
  });
  const storedUserId = await lerUserIdPersistido();
  console.info(
    "[Portal Extensão][background] Identidade ativa validada",
    {
      portalUserId: portalSession.userId,
      jwtSub: claims.sub,
      storedUserId,
      storedMatchesPortal: storedUserId === portalSession.userId
    }
  );
  return { ...portalSession, claims };
}

async function obterUserId() {
  try {
    const identity = await obterIdentidadePortalAtual();
    console.info("[Portal Extensão][background] Resultado de obterUserId()", {
      userId: identity?.userId ?? null,
      source: identity ? "portal_active_session" : "no_active_portal_session"
    });
    return identity?.userId ?? null;
  } catch (error) {
    console.error("[Portal Extensão][background] obterUserId() falhou", error);
    throw error;
  }
}

const INACTIVITY_SETTINGS_KEY = "inactivity_threshold_minutes";
const INACTIVITY_SETTINGS_REFRESH_ALARM = "portal-inactivity-settings-refresh";
const INACTIVITY_ALARM = "portal-session-inactivity";
const EXTENSION_HEARTBEAT_ALARM = "portal-extension-heartbeat";
const EXTENSION_HEARTBEAT_STORAGE_KEY = "extensionHeartbeatAt";
const EXTENSION_HEARTBEAT_INTERVAL_MINUTES = 1;
const EXTENSION_HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;
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
      const isInactivityEvent =
        endpoint.split("?")[0] === "inactivity_events" &&
        existing.endpoint.split("?")[0] === "inactivity_events";
      const existingBody = existing.body || {};
      const mergedBody = isInactivityEvent
        ? {
            ...existingBody,
            ...requestBody,
            started_at: requestBody.started_at ?? existingBody.started_at,
            ended_at: requestBody.ended_at ?? existingBody.ended_at
          }
        : requestBody;

      store.put({
        ...existing,
        endpoint,
        method,
        body: mergedBody,
        sortAt: mergedBody.started_at || existing.sortAt,
        revision: (existing.revision || 0) + 1,
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

async function obterProximoEventoPendente(userId) {
  const database = await abrirOutboxDatabase();
  const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
  const completion = aguardarTransacao(transaction);
  const cursorRequest = transaction
    .objectStore(OUTBOX_STORE_NAME)
    .index("chronological")
    .openCursor();
  const event = await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve(null);
        return;
      }

      const candidate = cursor.value;
      const eventUserId = candidate.body?.user_id;
      const isUnattributed = !eventUserId;
      if (
        (eventUserId && eventUserId !== userId) ||
        isUnattributed ||
        candidate.nextAttemptAt > Date.now()
      ) {
        if (
          (eventUserId && eventUserId !== userId) ||
          isUnattributed
        ) {
          console.info(
            "[Portal Extensão][sync] Evento mantido no outbox para outra identidade",
            {
              eventId: candidate.clientEventId,
              endpoint: candidate.endpoint.split("?")[0],
              eventUserId: eventUserId || null,
              activeUserId: userId,
              reason: isUnattributed
                ? "missing_source_user"
                : "different_user"
            }
          );
        }
        cursor.continue();
        return;
      }

      resolve(candidate);
    };
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

function registrarRoleRequisicao(tabelaDestino, role) {
  const statusKey =
    tabelaDestino === "inactivity_events"
      ? "lastInactivityEventRole"
      : "lastWebEventRole";
  console.info("[Portal Extensão][sync] Role da requisição", {
    endpoint: tabelaDestino,
    role
  });
  void atualizarStatusSincronizacao({ [statusKey]: role }).catch(
    (error) => {
      console.error(
        "[Portal Extensão][sync] Falha ao persistir diagnóstico da role",
        error
      );
    }
  );
}

async function enviarEventoPendente(event) {
  const body = prepararBodyRequisicao(event.endpoint, event.body);
  const tabelaDestino = event.endpoint.split("?")[0];
  // web_events e inactivity_events só aceitam escrita da role authenticated
  // (migrations 0028/0029 revogaram INSERT/UPDATE de anon).
  const exigeJwt =
    tabelaDestino === "web_events" || tabelaDestino === "inactivity_events";
  let authorization;
  let portalIdentity = null;
  if (exigeJwt || (event.method === "POST" && !body.user_id)) {
    portalIdentity = await obterIdentidadePortalAtual();
  }

  if (exigeJwt && event.method === "POST" && !body.user_id) {
    registrarRoleRequisicao(tabelaDestino, "não enviada (user_id ausente)");
    throw new Error(
      `Evento de ${tabelaDestino} sem identidade de origem; não será atribuído à sessão atual.`
    );
  }

  if (exigeJwt) {
    if (!portalIdentity?.userId || !portalIdentity.accessToken) {
      registrarRoleRequisicao(tabelaDestino, "não enviada (JWT ausente)");
      throw new Error(
        `Sessão autenticada atual do portal indisponível; ${tabelaDestino} não será enviada como anon.`
      );
    }

    if (
      event.method === "PATCH" &&
      tabelaDestino === "inactivity_events" &&
      !body.user_id
    ) {
      registrarRoleRequisicao(
        tabelaDestino,
        "não enviada (user_id ausente no PATCH)"
      );
      throw new Error(
        "PATCH de inactivity_events sem user_id de origem; evento mantido na fila."
      );
    }

    const claims = portalIdentity.claims;
    const role =
      typeof claims.role === "string" ? claims.role : "desconhecida";
    if (role !== "authenticated") {
      registrarRoleRequisicao(
        tabelaDestino,
        `não enviada (JWT role=${role})`
      );
      throw new Error(
        `JWT do portal usa role=${role}; ${tabelaDestino} exige role authenticated.`
      );
    }

    // PATCH (ex.: fechar inactivity_events) não leva user_id no body.
    const userIdEsperado = body.user_id ?? portalIdentity.userId;
    if (
      typeof claims.sub !== "string" ||
      claims.sub !== userIdEsperado ||
      portalIdentity.userId !== userIdEsperado
    ) {
      registrarRoleRequisicao(
        tabelaDestino,
        "não enviada (JWT/user_id incompatíveis)"
      );
      console.error(
        "[Portal Extensão][sync] Identidade do evento diverge da sessão autenticada atual",
        {
          endpoint: tabelaDestino,
          method: event.method,
          eventUserId: body.user_id ?? null,
          portalUserId: portalIdentity.userId,
          authUid: claims.sub ?? null,
          matches: false
        }
      );
      throw new Error(
        `JWT do portal não corresponde ao user_id do evento; ${tabelaDestino} não será enviada.`
      );
    }

    console.info(
      "[Portal Extensão][sync] Identidade validada para evento",
      {
        endpoint: tabelaDestino,
        method: event.method,
        eventUserId: body.user_id ?? null,
        portalUserId: portalIdentity.userId,
        authUid: claims.sub,
        matches: true
      }
    );
    authorization = `Bearer ${portalIdentity.accessToken}`;
    registrarRoleRequisicao(tabelaDestino, "authenticated");
  }

  console.info("[Portal Extensão][sync] Enviando evento ao Supabase", {
    endpoint: tabelaDestino,
    method: event.method,
    eventId: event.clientEventId,
    userId: body.user_id ?? portalIdentity?.userId ?? null
  });
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
    const responseBody = await response.text();
    console.error("[Portal Extensão][sync] Supabase rejeitou evento", {
      endpoint: tabelaDestino,
      method: event.method,
      eventId: event.clientEventId,
      status: response.status,
      responseBody
    });
    throw new Error(
      `Sincronização de ${event.endpoint} falhou: ${response.status} ${responseBody}`
    );
  }

  console.info("[Portal Extensão][sync] Supabase aceitou evento", {
    endpoint: tabelaDestino,
    method: event.method,
    eventId: event.clientEventId,
    status: response.status,
    userId: body.user_id ?? portalIdentity?.userId ?? null
  });
}

async function processarOutbox() {
  while (true) {
    const portalIdentity = await obterIdentidadePortalAtual();
    const event = await obterProximoEventoPendente(
      portalIdentity?.userId ?? null
    );
    if (!event) {
      await atualizarStatusSincronizacao();
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

    if (currentSession && !currentSession.isActive) {
      try {
        await processarEstadoIdle(await consultarEstadoIdle());
      } catch (error) {
        console.error(
          "[Portal Extensão][background] Falha ao reconciliar a sessão após atualizar o limite de inatividade",
          error
        );
      }
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
    await chrome.alarms.create(EXTENSION_HEARTBEAT_ALARM, {
      periodInMinutes: EXTENSION_HEARTBEAT_INTERVAL_MINUTES
    });
    if (currentSession) {
      await restaurarEventoInatividadeSessao();
    }

    const absenceDetected = await atualizarHeartbeat();
    if (currentSession && !absenceDetected && !currentSession.isActive) {
      try {
        await processarEstadoIdle(await consultarEstadoIdle());
      } catch (error) {
        console.error(
          "[Portal Extensão][background] Não foi possível reconciliar a sessão com o estado atual do sistema",
          error
        );
      }
    }

    if (currentSession) {
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

function serializarOperacao(callback = () => {}) {
  sessionOperation = sessionOperation
    .then(() => sessionReady)
    .then(async () => {
      await atualizarHeartbeat();
      return callback();
    })
    .catch((error) => {
      console.error("Erro ao atualizar sessão:", error);
    });

  return sessionOperation;
}

async function atualizarHeartbeat(timestamp = Date.now()) {
  const { [EXTENSION_HEARTBEAT_STORAGE_KEY]: storedHeartbeat } =
    await chrome.storage.local.get(EXTENSION_HEARTBEAT_STORAGE_KEY);
  const parsedHeartbeat =
    typeof storedHeartbeat === "string" ? Date.parse(storedHeartbeat) : NaN;
  const hasPreviousHeartbeat = Number.isFinite(parsedHeartbeat);
  const heartbeatGap = hasPreviousHeartbeat &&
    timestamp - parsedHeartbeat > EXTENSION_HEARTBEAT_TIMEOUT_MS;
  const missingPreviousHeartbeat =
    !hasPreviousHeartbeat && Boolean(currentSession);
  const absenceDetected = heartbeatGap || missingPreviousHeartbeat;

  if (storedHeartbeat && !hasPreviousHeartbeat) {
    console.warn(
      "[Portal Extensão][background] Heartbeat persistido inválido; a sessão será encerrada no último instante conhecido",
      { storedHeartbeat }
    );
  }

  if (absenceDetected && currentSession) {
    const knownTimes = [
      parsedHeartbeat,
      Date.parse(currentSession.lastActivity),
      Date.parse(currentSession.intervalStart || currentSession.inicio),
      Date.parse(currentSession.inicio)
    ].filter(Number.isFinite);
    const lastKnownPresence = Math.min(
      timestamp,
      knownTimes.length ? Math.max(...knownTimes) : timestamp
    );

    console.warn(
      "[Portal Extensão][background] Ausência detectada por lacuna no heartbeat; encerrando o período no último instante conhecido",
      {
        lastHeartbeatAt: hasPreviousHeartbeat
          ? new Date(parsedHeartbeat).toISOString()
          : null,
        absenceDurationMs: hasPreviousHeartbeat
          ? timestamp - parsedHeartbeat
          : null,
        endedAt: new Date(lastKnownPresence).toISOString()
      }
    );
    await encerrarSessao(
      lastKnownPresence,
      hasPreviousHeartbeat ? "heartbeat_timeout" : "heartbeat_unavailable"
    );
  }

  await chrome.storage.local.set({
    [EXTENSION_HEARTBEAT_STORAGE_KEY]: new Date(timestamp).toISOString()
  });
  return absenceDetected;
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

async function recuperarEventoInatividadeDoOutbox({
  clientEventId = null,
  startedAt = null,
  userId = null
} = {}) {
  try {
    const database = await abrirOutboxDatabase();
    const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
    const completion = aguardarTransacao(transaction);
    const request = transaction.objectStore(OUTBOX_STORE_NAME).getAll();
    const events = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () =>
        reject(request.error || new Error("Falha ao consultar o outbox."));
    });
    await completion;

    const matches = events.filter((event) => {
      if (event.endpoint?.split("?")[0] !== "inactivity_events") {
        return false;
      }

      const body = event.body || {};
      if (clientEventId) {
        return (
          event.clientEventId === clientEventId ||
          body.client_event_id === clientEventId
        );
      }

      return (
        startedAt &&
        body.started_at === new Date(startedAt).toISOString() &&
        (!userId || body.user_id === userId)
      );
    });
    const distinctIds = [...new Set(matches.map((event) =>
      event.body?.client_event_id || event.clientEventId
    ).filter(Boolean))];

    if (distinctIds.length !== 1) {
      if (distinctIds.length > 1) {
        console.error(
          "[Portal Extensão][background] Recuperação de inatividade ambígua no outbox",
          { startedAt, clientEventId, matchCount: distinctIds.length }
        );
      }
      return null;
    }

    return matches.find((event) =>
      (event.body?.client_event_id || event.clientEventId) === distinctIds[0]
    ) || null;
  } catch (error) {
    console.error(
      "[Portal Extensão][background] Falha ao recuperar inatividade do outbox",
      error
    );
    return null;
  }
}

async function restaurarEventoInatividadeSessao() {
  if (!currentSession) {
    return;
  }

  const session = currentSession;
  let hasStartedAt = Boolean(session.inactivityStartedAt);
  let hasClientEventId = Boolean(session.inactivityClientEventId);
  let hasServerEventId = Boolean(session.inactivityEventId);
  let hasInactivityMetadata =
    hasStartedAt ||
    hasClientEventId ||
    hasServerEventId ||
    Boolean(session.inactivityEndedAt);

  if (
    hasInactivityMetadata &&
    !hasServerEventId &&
    (!hasStartedAt || !hasClientEventId)
  ) {
    const pendingEvent = await recuperarEventoInatividadeDoOutbox({
      clientEventId: session.inactivityClientEventId || null,
      startedAt: session.inactivityStartedAt || null,
      userId: session.inactivityUserId || session.userId || null
    });

    if (pendingEvent) {
      const pendingBody = pendingEvent.body || {};
      const pendingClientEventId =
        pendingBody.client_event_id || pendingEvent.clientEventId;
      if (
        !session.inactivityClientEventId ||
        session.inactivityClientEventId === pendingClientEventId
      ) {
        session.inactivityClientEventId = pendingClientEventId;
        session.inactivityStartedAt =
          session.inactivityStartedAt || pendingBody.started_at || null;
        session.inactivityEndedAt =
          session.inactivityEndedAt || pendingBody.ended_at || null;
        session.inactivityUserId =
          session.inactivityUserId || pendingBody.user_id || null;
      } else {
        console.error(
          "[Portal Extensão][background] ID do evento no outbox diverge da sessão; a referência local foi preservada",
          {
            sessionClientEventId: session.inactivityClientEventId,
            outboxClientEventId: pendingClientEventId
          }
        );
      }
    }
  }

  hasStartedAt = Boolean(session.inactivityStartedAt);
  hasClientEventId = Boolean(session.inactivityClientEventId);
  hasServerEventId = Boolean(session.inactivityEventId);
  hasInactivityMetadata =
    hasStartedAt ||
    hasClientEventId ||
    hasServerEventId ||
    Boolean(session.inactivityEndedAt);

  if (!hasInactivityMetadata) {
    if (!session.isActive) {
      console.warn(
        "[Portal Extensão][background] Sessão restaurada como IDLE sem referência de evento; retornando para ACTIVE",
        { tabId: session.tabId }
      );
      session.isActive = true;
      session.intervalStart = new Date().toISOString();
      session.lastActivity = session.intervalStart;
    }
    return;
  }

  if (session.inactivityEndedAt) {
    session.isActive = true;
    await finalizarEventoInatividade(
      new Date(session.inactivityEndedAt).getTime()
    );
    return;
  }

  if (hasStartedAt && (hasClientEventId || hasServerEventId)) {
    // O marcador local do evento é autoritativo durante a restauração.
    // A próxima interação encerrará o evento; o ID não é regenerado.
    session.isActive = false;
    if (hasClientEventId) {
      try {
        await enviarEventoInatividade(
          session,
          session.inactivityStartedAt,
          null
        );
      } catch (error) {
        console.error(
          "[Portal Extensão][background] Evento aberto restaurado, mas não foi possível reenfileirá-lo",
          error
        );
      }
    }
    return;
  }

  console.error(
    "[Portal Extensão][background] Sessão restaurada com metadados de inatividade incompletos; mantendo o usuário ACTIVE sem criar outro evento",
    {
      hasStartedAt,
      hasClientEventId,
      hasServerEventId
    }
  );
  session.isActive = true;
  if (hasClientEventId || hasServerEventId) {
    session.inactivityEndedAt = new Date().toISOString();
    await finalizarEventoInatividade(
      new Date(session.inactivityEndedAt).getTime()
    );
  } else {
    // Sem qualquer identificador, manter o marcador em quarentena evita
    // abrir outro evento para um período cuja referência pode ter sido perdida.
    session.inactivityEndedAt = new Date().toISOString();
  }
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
  await chrome.alarms.clear(INACTIVITY_ALARM);

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
    try {
      await finalizarEventoInatividade(
        new Date(currentSession.inactivityEndedAt).getTime()
      );
    } catch (error) {
      console.error(
        "[Portal Extensão][background] Falha ao retomar encerramento pendente; a sessão continuará ativa",
        error
      );
    }
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
    await retomarSessaoAposInatividade(now, "user_interaction");
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

async function retomarSessaoAposInatividade(timestamp, reason) {
  if (!currentSession || currentSession.isActive) {
    return;
  }

  await salvarIntervalo(
    currentSession,
    currentSession.intervalStart,
    timestamp,
    false
  );

  const finalized = await finalizarEventoInatividade(timestamp);
  if (!finalized) {
    console.warn(
      "[Portal Extensão][background] Sessão retomada com encerramento de inatividade pendente; será tentado novamente",
      { tabId: currentSession.tabId, reason }
    );
  }

  const resumedAt = new Date(timestamp).toISOString();
  currentSession.intervalStart = resumedAt;
  currentSession.lastActivity = resumedAt;
  currentSession.isActive = true;
  await persistirSessao();
  await agendarEncerramento();

  console.info(
    "[Portal Extensão][background] Sessão retomada após inatividade",
    { tabId: currentSession.tabId, timestamp: resumedAt, reason }
  );
}

async function processarEstadoIdle(state, timestamp = Date.now()) {
  if (state === "active") {
    if (
      currentSession?.isActive &&
      inactivityThresholdSeconds !== null &&
      timestamp >=
        new Date(currentSession.lastActivity).getTime() +
          inactivityThresholdSeconds * 1000
    ) {
      const deadline =
        new Date(currentSession.lastActivity).getTime() +
        inactivityThresholdSeconds * 1000;
      await registrarInatividade(deadline);
    }

    await retomarSessaoAposInatividade(timestamp, "system_active");
    return;
  }

  if (
    (state === "idle" || state === "locked") &&
    currentSession?.isActive &&
    inactivityThresholdSeconds !== null
  ) {
    await registrarInatividade(timestamp);
  }
}

function consultarEstadoIdle() {
  const detectionInterval = Math.max(
    15,
    inactivityThresholdSeconds || 60
  );

  return new Promise((resolve, reject) => {
    chrome.idle.queryState(detectionInterval, (state) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(state);
    });
  });
}

async function enviarEventoInatividade(sessao, startedAt, endedAt = null) {
  if (!sessao.inactivityClientEventId) {
    console.error(
      "[Portal Extensão][background] Envio de inatividade cancelado: client_event_id ausente"
    );
    return false;
  }
  if (!sessao.inactivityUserId) {
    sessao.inactivityUserId = await obterUserId();
  }

  const startedAtIso = startedAt ? new Date(startedAt).toISOString() : null;
  const endedAtIso = endedAt ? new Date(endedAt).toISOString() : null;
  await enfileirarRequisicao({
    clientEventId: sessao.inactivityClientEventId,
    endpoint: "inactivity_events?on_conflict=client_event_id",
    body: {
      client_event_id: sessao.inactivityClientEventId,
      user_id: sessao.inactivityUserId,
      ...(startedAtIso ? { started_at: startedAtIso } : {}),
      ended_at: endedAtIso,
      classification: "inactive",
      ...(startedAtIso ? { created_at: startedAtIso } : {})
    }
  });

  return true;
}

async function criarEventoInatividade(startedAt) {
  if (!currentSession) {
    return;
  }

  const hasExistingInactivity =
    Boolean(currentSession.inactivityStartedAt) ||
    Boolean(currentSession.inactivityClientEventId) ||
    Boolean(currentSession.inactivityEventId) ||
    Boolean(currentSession.inactivityEndedAt);

  if (hasExistingInactivity) {
    if (
      !currentSession.inactivityClientEventId &&
      !currentSession.inactivityEventId &&
      currentSession.inactivityStartedAt
    ) {
      const pendingEvent = await recuperarEventoInatividadeDoOutbox({
        startedAt: currentSession.inactivityStartedAt,
        userId: currentSession.inactivityUserId || currentSession.userId || null
      });
      if (pendingEvent) {
        currentSession.inactivityClientEventId =
          pendingEvent.body?.client_event_id || pendingEvent.clientEventId;
      }
    }

    if (
      currentSession.inactivityStartedAt &&
      currentSession.inactivityClientEventId
    ) {
      try {
        await enviarEventoInatividade(
          currentSession,
          currentSession.inactivityStartedAt,
          currentSession.inactivityEndedAt
        );
        await persistirSessao();
      } catch (error) {
        console.error(
          "[Portal Extensão][background] Abertura já existente não foi substituída; falha ao reenfileirar",
          error
        );
      }
      return;
    }

    console.error(
      "[Portal Extensão][background] Nova abertura de inatividade bloqueada para preservar referência existente",
      {
        hasStartedAt: Boolean(currentSession.inactivityStartedAt),
        hasClientEventId: Boolean(currentSession.inactivityClientEventId),
        hasServerEventId: Boolean(currentSession.inactivityEventId),
        hasEndedAt: Boolean(currentSession.inactivityEndedAt)
      }
    );
    await persistirSessao();
    return;
  }

  currentSession.inactivityStartedAt = new Date(startedAt).toISOString();
  currentSession.inactivityEndedAt = null;
  currentSession.inactivityEventId = null;
  currentSession.inactivityClientEventId = criarIdEvento();
  currentSession.inactivityUserId = currentSession.userId || null;
  await persistirSessao();

  try {
    if (!currentSession.inactivityUserId) {
      currentSession.inactivityUserId = await obterUserId();
    }
    await enviarEventoInatividade(
      currentSession,
      currentSession.inactivityStartedAt
    );
    await persistirSessao();
  } catch (error) {
    // O ID e o início já foram persistidos; sessionReady poderá retomar o envio.
    console.error(
      "[Portal Extensão][background] Evento de inatividade aberto localmente, mas não foi possível enfileirar a sincronização",
      {
        clientEventId: currentSession.inactivityClientEventId,
        error: error.message || String(error)
      }
    );
  }
}

async function finalizarEventoInatividade(endedAt) {
  if (!currentSession) {
    return true;
  }

  const session = currentSession;
  const hasStartedAt = Boolean(session.inactivityStartedAt);
  const hasClientEventId = Boolean(session.inactivityClientEventId);
  const hasServerEventId = Boolean(session.inactivityEventId);

  if (!hasStartedAt && !hasClientEventId && !hasServerEventId) {
    if (session.inactivityEndedAt) {
      console.warn(
        "[Portal Extensão][background] Removendo ended_at sem referência de evento",
        { tabId: session.tabId }
      );
      session.inactivityEndedAt = null;
      await persistirSessao();
    }
    return true;
  }

  if (
    !session.inactivityClientEventId &&
    !session.inactivityEventId &&
    session.inactivityStartedAt
  ) {
    const pendingEvent = await recuperarEventoInatividadeDoOutbox({
      startedAt: session.inactivityStartedAt,
      userId: session.inactivityUserId || session.userId || null
    });
    if (pendingEvent) {
      session.inactivityClientEventId =
        pendingEvent.body?.client_event_id || pendingEvent.clientEventId;
      session.inactivityUserId =
        session.inactivityUserId || pendingEvent.body?.user_id || null;
    }
  }

  const startedAt = session.inactivityStartedAt || null;
  const endedAtIso = session.inactivityEndedAt ||
    new Date(endedAt).toISOString();
  session.inactivityEndedAt = endedAtIso;
  await persistirSessao();

  try {
    if (session.inactivityClientEventId && startedAt) {
      await enviarEventoInatividade(session, startedAt, endedAtIso);
    } else if (session.inactivityClientEventId) {
      // Reutiliza o ID em um upsert parcial: se a abertura ainda estiver
      // pendente no outbox, ela será mesclada e não substituída por um PATCH.
      await enviarEventoInatividade(session, null, endedAtIso);
    } else if (session.inactivityEventId) {
      // Chave estável do outbox para o caminho legado; não é UUID do evento.
      await enfileirarRequisicao({
        clientEventId: `legacy-inactivity-${session.inactivityEventId}`,
        endpoint: `inactivity_events?id=eq.${encodeURIComponent(session.inactivityEventId)}&ended_at=is.null`,
        method: "PATCH",
        body: {
          user_id: session.inactivityUserId || session.userId || null,
          ended_at: endedAtIso
        }
      });
    } else {
      console.error(
        "[Portal Extensão][background] Não foi possível identificar o evento para encerramento; referência mantida para recuperação",
        {
          startedAt,
          hasClientEventId: Boolean(session.inactivityClientEventId)
        }
      );
      return false;
    }
  } catch (error) {
    // ended_at fica persistido para retry após atividade ou reinício do worker.
    console.error(
      "[Portal Extensão][background] Encerramento não foi persistido no outbox; referência mantida para retry",
      {
        clientEventId: session.inactivityClientEventId || null,
        serverEventId: session.inactivityEventId || null,
        error: error.message || String(error)
      }
    );
    return false;
  }

  session.inactivityStartedAt = null;
  session.inactivityEndedAt = null;
  session.inactivityEventId = null;
  session.inactivityClientEventId = null;
  session.inactivityUserId = null;
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
  if (alarm.name === EXTENSION_HEARTBEAT_ALARM) {
    void serializarOperacao();
    return;
  }

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
    if (!currentSession || !currentSession.isActive) {
      return;
    }

    if (inactivityThresholdSeconds === null) {
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
  void serializarOperacao(() => processarEstadoIdle(state));
});

chrome.runtime.onStartup.addListener(() => {
  void serializarOperacao(async () => {
    if (!currentSession) {
      return;
    }

    // Close active usage at its last interaction; close pending inactivity on startup.
    await encerrarSessao(
      currentSession.isActive
        ? new Date(currentSession.lastActivity).getTime()
        : Date.now(),
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

    void persistirIdentidade(userId, {
      name: "portal_identity_message",
      accessToken
    })
      .then(async (changed) => {
        await sessionOperation;
        const storedUserId = await lerUserIdPersistido();
        console.info(
          "[Portal Extensão][background] PORTAL_IDENTITY_CHANGED aplicado",
          {
            receivedUserId: userId,
            storedUserId,
            matches: storedUserId === userId,
            sessionUserId: currentSession?.userId ?? null
          }
        );
        sendResponse({
          ok: true,
          stage: changed ? "applied" : "unchanged",
          userId
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