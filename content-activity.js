(() => {
  const backgroundMessageType = "PORTAL_USER_ACTIVITY";
  const minimumIntervalMs = 5000;
  let lastSentAt = 0;

  function reportActivity(event) {
    if (
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastSentAt < minimumIntervalMs) {
      return;
    }

    lastSentAt = now;

    try {
      chrome.runtime.sendMessage(
        {
          type: backgroundMessageType,
          interaction: event.type
        },
        () => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            console.error(
              "[Portal Extensão][activity] Falha ao enviar interação",
              runtimeError.message
            );
          }
        }
      );
    } catch (error) {
      console.error(
        "[Portal Extensão][activity] Erro ao enviar interação",
        error
      );
    }
  }

  [
    "mousemove",
    "keydown",
    "scroll",
    "wheel",
    "click",
    "pointerdown"
  ].forEach((eventName) => {
    document.addEventListener(eventName, reportActivity, {
      capture: true,
      passive: true
    });
  });
})();
