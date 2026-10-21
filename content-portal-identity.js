(() => {
console.log("🔥🔥🔥 VERSAO NOVA DA EXTENSAO 🔥🔥🔥");
  const pageIdentityMessageType = "identity";
  const backgroundIdentityMessageType = "PORTAL_IDENTITY_CHANGED";

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

    const userId =
      typeof data.userId === "string" ? data.userId.trim() : data.userId;

    if (userId !== null && (typeof userId !== "string" || !userId)) {
      console.error(
        "[Portal Extensão][content] Identidade ignorada: userId ausente ou inválido",
        { receivedType: typeof data.userId }
      );
      return;
    }

    console.info(
      "[Portal Extensão][content] Encaminhando identidade ao background",
      { userId }
    );

    try {
      console.info(
        "[Portal Extensão][content] Chamando chrome.runtime.sendMessage"
      );
      chrome.runtime.sendMessage(
        {
          type: backgroundIdentityMessageType,
          userId
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;

          if (runtimeError) {
            console.error(
              "[Portal Extensão][content] Falha em chrome.runtime.sendMessage",
              runtimeError.message
            );
            return;
          }

          if (!response?.ok) {
            console.error(
              "[Portal Extensão][content] Background não confirmou a persistência",
              response
            );
            return;
          }

          console.info(
            "[Portal Extensão][content] Background confirmou identidade persistida",
            { userId }
          );
        }
      );
    } catch (error) {
      console.error(
        "[Portal Extensão][content] Erro síncrono em chrome.runtime.sendMessage",
        error
      );
    }
  });
})();