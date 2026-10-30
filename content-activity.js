(() => {
  const backgroundMessageType = "PORTAL_USER_ACTIVITY";
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

  function isProtheusHost(hostname) {
    const normalizedHostname = hostname.toLowerCase();
    return (
      normalizedHostname.includes("totvs") ||
      normalizedHostname.includes("protheus")
    );
  }

  function getVisibleCaption(element) {
    if (!element.getClientRects().length) {
      return null;
    }

    const caption = element.getAttribute("caption")
      ?.replace(/[:：]\s*$/, "")
      .trim();

    return caption && caption.length <= 120 ? caption : null;
  }

  function readProtheusScreen() {
    if (!isProtheusHost(location.hostname)) {
      return { screenName: null, screenContext: null };
    }

    const activeTab = Array.from(
      document.querySelectorAll("wa-tab-button[active]")
    ).find((element) => element.getClientRects().length > 0);
    const activeTabText = activeTab
      ? (activeTab.innerText || activeTab.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\s+-\s+\d{2}\/\d{2}\s+\[[^\]]+\]\s*$/, "")
          .trim()
      : "";

    const captions = Array.from(
      document.querySelectorAll("wa-text-view[caption]")
    )
      .map((element) => ({
        caption: getVisibleCaption(element),
        element
      }))
      .filter(({ caption }) => caption)
      .sort((left, right) => {
        const leftFontSize =
          Number.parseFloat(getComputedStyle(left.element).fontSize) || 0;
        const rightFontSize =
          Number.parseFloat(getComputedStyle(right.element).fontSize) || 0;
        return rightFontSize - leftFontSize;
      });

    return {
      screenName: activeTabText.slice(0, 120) || captions[0]?.caption || null,
      screenContext: captions[0]?.caption || null
    };
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
    const protheusScreen = privateApplicationName
      ? { screenName: privateApplicationName, screenContext: null }
      : readProtheusScreen();
    const screenName = protheusScreen.screenName;

    console.info(
      "[Portal Extensão][activity] Enviando atividade para background",
      {
        interaction: event.type,
        hostname: location.hostname,
        screenName,
        screenContext: protheusScreen.screenContext,
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
          screenContext: protheusScreen.screenContext,
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