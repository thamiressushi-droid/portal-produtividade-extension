(() => {
  const bridgeGlobalKey = "__portalIdentityBridgeLoaded";
  if (globalThis[bridgeGlobalKey]) {
    console.info(
      "[Portal Extensão][content] Bridge de identidade já estava ativo"
    );
    return;
  }
  globalThis[bridgeGlobalKey] = true;

  const pageIdentityMessageType = "identity";
  const backgroundIdentityMessageType = "PORTAL_IDENTITY_CHANGED";
  const backgroundIdentityRequestType = "PORTAL_GET_AUTHENTICATED_USER";
  const supabaseAuthStorageKey = "sb-lqiftfrbdtqcrfxcthao-auth-token";
  let lastReportedIdentity;

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
      const userId =
        session?.user?.id ||
        session?.session?.user?.id ||
        session?.currentSession?.user?.id ||
        session?.data?.user?.id ||
        session?.data?.session?.user?.id;
      const accessToken =
        session?.access_token ||
        session?.session?.access_token ||
        session?.currentSession?.access_token ||
        session?.data?.session?.access_token;

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
      return { userId: normalizedUserId, accessToken: normalizedAccessToken };
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

  function notifyBackground(userId, accessToken = null) {
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
    const identityKey = `${userId || ""}:${normalizedAccessToken || ""}`;
    if (
      lastReportedIdentity !== undefined &&
      identityKey === lastReportedIdentity
    ) {
      return;
    }

    lastReportedIdentity = identityKey;
    chrome.runtime.sendMessage(
      {
        type: backgroundIdentityMessageType,
        userId,
        accessToken: normalizedAccessToken
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError) {
          lastReportedIdentity = undefined;
          console.error(
            "[Portal Extensão][content] Falha ao persistir identidade",
            runtimeError.message
          );
          return;
        }

        if (!response?.ok) {
          lastReportedIdentity = undefined;
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
    expectedMessageType: pageIdentityMessageType
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

    if (messageType !== pageIdentityMessageType) {
      console.info(
        "[Portal Extensão][content] postMessage ignorado: tipo inesperado",
        {
          expectedMessageType: pageIdentityMessageType,
          receivedMessageType: messageType
        }
      );
      return;
    }

    const userId = Object.hasOwn(data, "userId")
      ? data.userId
      : data.user?.id ?? data.session?.user?.id;
    const authSession = getAuthSession();

    if (userId === undefined) {
      console.error(
        "[Portal Extensão][content] Identidade ignorada: userId ausente"
      );
      return;
    }

    if (typeof userId !== "string" || !userId.trim()) {
      if (userId === null) {
        notifyBackground(null, null);
        return;
      }

      console.error(
        "[Portal Extensão][content] Identidade ignorada: userId inválido",
        { receivedType: typeof userId }
      );
      return;
    }

    const normalizedUserId = userId.trim();
    notifyBackground(
      normalizedUserId,
      authSession.userId === normalizedUserId
        ? authSession.accessToken
        : null
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
    const authSession = getAuthSession();
    if (authSession.userId) {
      notifyBackground(authSession.userId, authSession.accessToken);
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
            notifyBackground(currentSession.userId, currentSession.accessToken);
            return;
          }

          console.info(
            "[Portal Extensão][content] Logout confirmado pela remoção da sessão",
            { userId: null }
          );
          notifyBackground(null, null);
        }, 1_000);
      } else {
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