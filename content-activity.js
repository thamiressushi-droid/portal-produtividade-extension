(() => {
  const backgroundMessageType = "PORTAL_USER_ACTIVITY";
  const minimumIntervalMs = 5000;
  let lastSentAt = 0;

  function reportActivity(event) {
    console.info(
      "[Portal Extensão][activity] Atividade detectada",
      {
        event: event.type,
        visible: document.visibilityState,
        focused: document.hasFocus(),
        hostname: location.hostname,
        timestamp: new Date().toISOString(),
      }
    );

    if (
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      console.warn(
        "[Portal Extensão][activity] Ignorada por falta de foco",
        {
          visible: document.visibilityState,
          focused: document.hasFocus(),
        }
      );
      return;
    }

    const now = Date.now();

    if (now - lastSentAt < minimumIntervalMs) {
      console.info(
        "[Portal Extensão][activity] Ignorada pelo throttle",
        {
          event: event.type,
          diffMs: now - lastSentAt,
        }
      );
      return;
    }

    lastSentAt = now;

    console.info(
      "[Portal Extensão][activity] Enviando atividade para background",
      {
        interaction: event.type,
        hostname: location.hostname,
        timestamp: new Date().toISOString(),
      }
    );

    try {
      chrome.runtime.sendMessage(
        {
          type: backgroundMessageType,
          interaction: event.type,
          hostname: location.hostname,
          timestamp: new Date().toISOString(),
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;

          if (runtimeError) {
            console.error(
              "[Portal Extensão][activity] Falha ao enviar interação",
              runtimeError.message
            );
            return;
          }

          console.info(
            "[Portal Extensão][activity] Background respondeu",
            response
          );
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
    "pointerdown",
  ].forEach((eventName) => {
    document.addEventListener(eventName, reportActivity, {
      capture: true,
      passive: true,
    });
  });

  console.info(
    "[Portal Extensão][activity] Monitor de atividade iniciado",
    {
      hostname: location.hostname,
      timestamp: new Date().toISOString(),
    }
  );
})();