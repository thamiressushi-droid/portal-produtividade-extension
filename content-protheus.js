(() => {
  const screenEvent = "PORTAL_PROTHEUS_SCREEN";
  const normalizedHostname = location.hostname.toLowerCase();

  if (
    !normalizedHostname.includes("totvs") &&
    !normalizedHostname.includes("protheus")
  ) {
    return;
  }

  function querySelectorAllDeep(selector) {
    const elements = [];

    function search(root) {
      elements.push(...root.querySelectorAll(selector));
      root.querySelectorAll("*").forEach((element) => {
        if (element.shadowRoot) {
          search(element.shadowRoot);
        }
      });
    }

    search(document);
    return elements;
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

  function readScreen() {
    const activeTab = querySelectorAllDeep("wa-tab-button[active]").find(
      (element) => element.getClientRects().length > 0
    );
    const activeTabText = activeTab
      ? (activeTab.innerText || activeTab.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\s+-\s+\d{2}\/\d{2}\s+\[[^\]]+\]\s*$/, "")
          .trim()
      : "";
    const captions = querySelectorAllDeep("wa-text-view[caption]")
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

  let currentScreen = { screenName: null, screenContext: null };
  let debounceTimer;

  function publishScreen() {
    const nextScreen = readScreen();
    if (
      nextScreen.screenName === currentScreen.screenName &&
      nextScreen.screenContext === currentScreen.screenContext
    ) {
      return;
    }

    currentScreen = nextScreen;
    window.dispatchEvent(
      new CustomEvent(screenEvent, { detail: currentScreen })
    );
    console.info(
      "[Portal Extensão][protheus] Tela capturada",
      {
        hostname: location.hostname,
        screen_name: currentScreen.screenName,
        screen_context: currentScreen.screenContext
      }
    );
  }

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(publishScreen, 300);
  });
  observer.observe(document.documentElement || document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["active", "caption"]
  });

  publishScreen();
  setInterval(publishScreen, 2000);
})();
