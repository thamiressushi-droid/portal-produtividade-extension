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
  let lastReportedUserId;

  function getAuthUserId() {
    try {
      let serializedSession = window.localStorage.getItem(
        supabaseAuthStorageKey
      );

      if (!serializedSession) {
        console.info("[Portal Extensão][content] Leitura da identidade", {
          found: false,
          storageKey: supabaseAuthStorageKey
        });
        return null;
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

      const normalizedUserId =
        typeof userId === "string" && userId.trim()
          ? userId.trim()
          : null;
      console.info("[Portal Extensão][content] Leitura da identidade", {
        userId: normalizedUserId,
        storageKey: supabaseAuthStorageKey
      });
      return normalizedUserId;
    } catch (error) {
      console.warn(
        "[Portal Extensão][content] Não foi possível ler user.id da sessão Supabase",
        error
      );
      console.info("[Portal Extensão][content] Leitura da identidade", {
        found: false,
        storageKey: supabaseAuthStorageKey,
        failed: true
      });
      return null;
    }
  }

  function notifyBackground(userId) {
    if (
      userId !== null &&
      (typeof userId !== "string" || !userId.trim())
    ) {
      return;
    }

    if (
      lastReportedUserId !== undefined &&
      userId === lastReportedUserId
    ) {
      return;
    }

    lastReportedUserId = userId;
    chrome.runtime.sendMessage(
      {
        type: backgroundIdentityMessageType,
        userId
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError) {
          lastReportedUserId = undefined;
          console.error(
            "[Portal Extensão][content] Falha ao persistir identidade",
            runtimeError.message
          );
          return;
        }

        if (!response?.ok) {
          lastReportedUserId = undefined;
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

    if (userId === undefined) {
      console.error(
        "[Portal Extensão][content] Identidade ignorada: userId ausente"
      );
      return;
    }

    if (typeof userId !== "string" || !userId.trim()) {
      if (userId === null) {
        notifyBackground(null);
        return;
      }

      console.error(
        "[Portal Extensão][content] Identidade ignorada: userId inválido",
        { receivedType: typeof userId }
      );
      return;
    }

    notifyBackground(userId.trim());
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== backgroundIdentityRequestType) {
      return;
    }

    const userId = getAuthUserId();
    console.info(
      "[Portal Extensão][content] Identidade consultada pelo background",
      { userId }
    );
    sendResponse({ userId });
  });

  function refreshAuthIdentity() {
    const userId = getAuthUserId();
    if (userId) {
      notifyBackground(userId);
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
          const currentUserId = getAuthUserId();
          if (currentUserId) {
            console.info(
              "[Portal Extensão][content] Sessão restaurada; identidade preservada",
              { userId: currentUserId }
            );
            notifyBackground(currentUserId);
            return;
          }

          console.info(
            "[Portal Extensão][content] Logout confirmado pela remoção da sessão",
            { userId: null }
          );
          notifyBackground(null);
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