(() => {
  const backgroundMessageType = "PORTAL_USER_ACTIVITY";
  const minimumIntervalMs = 5000;
  const knownProtheusScreens = [
    "Pedidos de Venda",
    "Orçamentos",
    "Clientes",
    "CRM",
    "Faturamento",
    "Estoque"
  ];
  let lastSentAt = 0;

  function readProtheusScreenName() {
    const hostname = location.hostname.toLowerCase();
    if (!hostname.includes("totvs") && !hostname.includes("protheus")) {
      return null;
    }

    const normalize = (value) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .replace(/[:\s]+$/g, "")
        .toLowerCase();

    const captions = Array.from(
      document.querySelectorAll("wa-text-view[caption]")
    )
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.getAttribute("caption")?.trim())
      .filter(Boolean);

    return knownProtheusScreens.find((screenName) =>
      captions.some((caption) => normalize(caption) === normalize(screenName))
    ) || null;
  }

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
    const screenName = readProtheusScreenName();

    console.info(
      "[Portal Extensão][activity] Enviando atividade para background",
      {
        interaction: event.type,
        hostname: location.hostname,
        screenName,
        timestamp: new Date().toISOString(),
      }
    );

    try {
      chrome.runtime.sendMessage(
        {
          type: backgroundMessageType,
          interaction: event.type,
          hostname: location.hostname,
          windowTitle: document.title || null,
          screenName,
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