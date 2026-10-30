(() => {
  const backgroundMessageType = "PORTAL_USER_ACTIVITY";
  const protheusScreenEvent = "PORTAL_PROTHEUS_SCREEN";
  const minimumIntervalMs = 5000;
  const privateApplications = [
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
  let lastSentAt = 0;
  let protheusScreen = { screenName: null, screenContext: null };

  window.addEventListener(protheusScreenEvent, (event) => {
    const { screenName, screenContext } = event.detail || {};
    protheusScreen = {
      screenName: typeof screenName === "string" ? screenName : null,
      screenContext: typeof screenContext === "string" ? screenContext : null
    };
  });

  function getPrivateApplicationName(hostname) {
    const normalizedHostname = hostname.toLowerCase();

    return privateApplications.find(({ domains }) =>
      domains.some(
        (domain) =>
          normalizedHostname === domain ||
          normalizedHostname.endsWith(`.${domain}`)
      )
    )?.name || null;
  }

  function reportCaptureDiagnostics(event) {
    const privateApplicationName = getPrivateApplicationName(
      location.hostname
    );
    const capturedScreen = privateApplicationName
      ? { screenName: privateApplicationName, screenContext: null }
      : protheusScreen;
    const diagnostics = {
      url: location.href,
      tab_title: document.title || null,
      window_title: document.title || null,
      screen_name: capturedScreen.screenName,
      screen_context: capturedScreen.screenContext,
      capturedAt: new Date().toISOString(),
      interaction: event.type
    };

    chrome.storage.local.set({ captureDiagnostics: diagnostics }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.error(
          "[Portal Extensão][activity] Falha ao salvar diagnóstico da captura",
          runtimeError.message
        );
        return;
      }

      console.info(
        "[Portal Extensão][activity] Diagnóstico da captura atualizado",
        diagnostics
      );
    });
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
    const privateApplicationName = getPrivateApplicationName(
      location.hostname
    );
    const capturedScreen = privateApplicationName
      ? { screenName: privateApplicationName, screenContext: null }
      : protheusScreen;
    const screenName = capturedScreen.screenName;

    console.info(
      "[Portal Extensão][activity] Enviando atividade para background",
      {
        interaction: event.type,
        hostname: location.hostname,
        screenName,
        screenContext: capturedScreen.screenContext,
        timestamp: new Date().toISOString(),
      }
    );

    try {
      chrome.runtime.sendMessage(
        {
          type: backgroundMessageType,
          interaction: event.type,
          hostname: location.hostname,
          windowTitle: privateApplicationName || document.title || null,
          screenName,
          screenContext: capturedScreen.screenContext,
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
  document.addEventListener("click", reportCaptureDiagnostics, {
    capture: true,
    passive: true
  });

  console.info(
    "[Portal Extensão][activity] Monitor de atividade iniciado",
    {
      hostname: location.hostname,
      timestamp: new Date().toISOString(),
    }
  );
})();