(() => {
  const bridgeGlobalKey = "__portalIdentityBridgeLoaded";
  if (globalThis[bridgeGlobalKey]) {
    console.info(
      "[Portal Extensão][content] Bridge de identidade já estava ativo"
    );
    return;
  }
  globalThis[bridgeGlobalKey] = true;

  const portalAuthMessageSource = "portal-produtividade-auth";
  const backgroundIdentityMessageType = "PORTAL_IDENTITY_CHANGED";
  const backgroundIdentityRequestType = "PORTAL_GET_AUTHENTICATED_USER";
  const supabaseAuthStorageKey = "sb-lqiftfrbdtqcrfxcthao-auth-token";
  let lastReportedIdentity;
  let portalSessionCleared = false;
  let authenticationState = "disconnected";

  function getAuthSession() {
    try {
      let serializedSession = window.localStorage.getItem(
        supabaseAuthStorageKey
      );

      if (!serializedSession) {
        console.info("[Portal Extensão][content] Leitura da identidade", {
          found: false,
          storageKey: supabaseAuthStorageKey
        });
        return { userId: null, accessToken: null };
      }

      if (serializedSession.startsWith("base64-")) {
        const binary = atob(serializedSession.slice(7));
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0)
        );
        serializedSession = new TextDecoder().decode(bytes);
      }

      const session = JSON.parse(serializedSession);
      const sessionUser =
        session?.user ||
        session?.session?.user ||
        session?.currentSession?.user ||
        session?.data?.user ||
        session?.data?.session?.user;
      const userId =
        sessionUser?.id;
      const accessToken =
        session?.access_token ||
        session?.session?.access_token ||
        session?.currentSession?.access_token ||
        session?.data?.session?.access_token;
      const expiresAt =
        session?.expires_at ||
        session?.session?.expires_at ||
        session?.currentSession?.expires_at ||
        session?.data?.session?.expires_at;

      const normalizedUserId =
        typeof userId === "string" && userId.trim()
          ? userId.trim()
          : null;
      const normalizedAccessToken =
        typeof accessToken === "string" && accessToken.trim()
          ? accessToken.trim()
          : null;
      console.info("[Portal Extensão][content] Leitura da sessão", {
        userId: normalizedUserId,
        receivedJwt: Boolean(normalizedAccessToken),
        storageKey: supabaseAuthStorageKey
      });
      return {
        userId: normalizedUserId,
        accessToken: normalizedAccessToken,
        email: typeof sessionUser?.email === "string" ? sessionUser.email : null,
        expiresAt: expiresAt ?? null
      };
    } catch (error) {
      console.warn(
        "[Portal Extensão][content] Não foi possível ler a sessão Supabase",
        error
      );
      console.info("[Portal Extensão][content] Leitura da sessão", {
        found: false,
        storageKey: supabaseAuthStorageKey,
        failed: true
      });
      return { userId: null, accessToken: null };
    }
  }

  function notifyBackground(
    userId,
    accessToken = null,
    { email = null, expiresAt = null } = {}
  ) {
    if (
      userId !== null &&
      (typeof userId !== "string" || !userId.trim())
    ) {
      return;
    }

    const normalizedAccessToken =
      typeof accessToken === "string" && accessToken.trim()
        ? accessToken.trim()
        : null;
    const identityKey = JSON.stringify([
      userId,
      normalizedAccessToken,
      email,
      expiresAt
    ]);
    if (
      lastReportedIdentity !== undefined &&
      identityKey === lastReportedIdentity
    ) {
      return;
    }

    lastReportedIdentity = identityKey;
    authenticationState =
      userId && normalizedAccessToken ? "authenticated" : "disconnected";
    chrome.runtime.sendMessage(
      {
        type: backgroundIdentityMessageType,
        userId,
        accessToken: normalizedAccessToken,
        email,
        expiresAt
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError) {
          lastReportedIdentity = undefined;
          authenticationState = "disconnected";
          console.error(
            "[Portal Extensão][content] Falha ao persistir identidade",
            runtimeError.message
          );
          return;
        }

        if (response?.authState?.status) {
          authenticationState = response.authState.status;
        }

        if (!response?.ok) {
          if (!response?.authState) {
            lastReportedIdentity = undefined;
          }
          console.error(
            "[Portal Extensão][content] Background não confirmou a identidade",
            response
          );
        }
      }
    );
  }

  console.info("[Portal Extensão][content] Bridge carregado", {
    pageUrl: window.location.href,
    expectedMessageSource: portalAuthMessageSource
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    const messageType =
      typeof data === "object" && data !== null
        ? data.type
        : undefined;

    console.info("[Portal Extensão][content] postMessage recebido", {
      origin: event.origin,
      fromPage: event.source === window,
      messageType
    });

    if (event.source !== window) {
      console.warn(
        "[Portal Extensão][content] postMessage ignorado: origem não é a janela da página"
      );
      return;
    }

    if (
      typeof data === "object" &&
      data !== null &&
      data.source === portalAuthMessageSource
    ) {
      if (data.type === "SESSION_CLEARED") {
        portalSessionCleared = true;
        authenticationState = "disconnected";
        lastReportedIdentity = undefined;
        notifyBackground(null, null);
        return;
      }

      if (data.type === "SESSION_SYNC") {
        if (
          typeof data.userId !== "string" ||
          !data.userId.trim() ||
          typeof data.accessToken !== "string" ||
          !data.accessToken.trim()
        ) {
          console.error(
            "[Portal Extensão][content] Sessão ignorada: userId ou accessToken inválido"
          );
          return;
        }

        portalSessionCleared = false;
        lastReportedIdentity = undefined;
        notifyBackground(data.userId.trim(), data.accessToken.trim(), {
          email: typeof data.email === "string" ? data.email : null,
          expiresAt: data.expiresAt ?? null
        });
        console.info("[Portal Extensão][content] Sincronização de sessão recebida", {
          authenticationState,
          userId: data.userId.trim(),
          receivedJwt: true
        });
        return;
      }

      console.info(
        "[Portal Extensão][content] postMessage ignorado: tipo de autenticação inesperado",
        { messageType }
      );
      return;
    }

    console.info(
      "[Portal Extensão][content] postMessage ignorado: source inesperado",
      { receivedSource: data?.source ?? null }
    );
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== backgroundIdentityRequestType) {
      return;
    }

    const authSession = getAuthSession();
    console.info(
      "[Portal Extensão][content] Sessão consultada pelo background",
      {
        userId: authSession.userId,
        receivedJwt: Boolean(authSession.accessToken)
      }
    );
    sendResponse(authSession);
  });

  function refreshAuthIdentity() {
    if (portalSessionCleared) {
      return;
    }

    const authSession = getAuthSession();
    if (authSession.userId) {
      notifyBackground(authSession.userId, authSession.accessToken, {
        email: authSession.email,
        expiresAt: authSession.expiresAt
      });
    }
  }

  refreshAuthIdentity();
  window.addEventListener("storage", (event) => {
    if (event.key === supabaseAuthStorageKey) {
      if (event.newValue === null) {
        console.info(
          "[Portal Extensão][content] Remoção da sessão detectada; confirmando antes de apagar portalUserId"
        );
        window.setTimeout(() => {
          const currentSession = getAuthSession();
          if (currentSession.userId) {
            console.info(
              "[Portal Extensão][content] Sessão restaurada; identidade preservada",
              { userId: currentSession.userId }
            );
            notifyBackground(currentSession.userId, currentSession.accessToken, {
              email: currentSession.email,
              expiresAt: currentSession.expiresAt
            });
            return;
          }

          console.info(
            "[Portal Extensão][content] Logout confirmado pela remoção da sessão",
            { userId: null }
          );
          portalSessionCleared = true;
          notifyBackground(null, null);
        }, 1_000);
      } else {
        portalSessionCleared = false;
        refreshAuthIdentity();
      }
    }
  });
  window.addEventListener("focus", refreshAuthIdentity);
  window.addEventListener("pageshow", refreshAuthIdentity);
  window.setInterval(refreshAuthIdentity, 5_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshAuthIdentity();
    }
  });
})();