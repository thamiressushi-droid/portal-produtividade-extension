let currentTab = null;
let startTime = null;

async function registrarTroca(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab.url || tab.url.startsWith("chrome://")) {
      return;
    }

    const agora = new Date();

    if (currentTab) {
      const registro = {
        domain: new URL(currentTab.url).hostname,
        titulo: currentTab.title,
        inicio: startTime,
        fim: agora.toISOString(),
        duracaoSegundos: Math.floor(
          (agora.getTime() - new Date(startTime).getTime()) / 1000
        )
      };

      console.log("Registro capturado:");
      console.log(registro);
    }

    currentTab = {
      url: tab.url,
      title: tab.title
    };

    startTime = agora.toISOString();

    console.log(
      `Monitorando: ${new URL(tab.url).hostname}`
    );

  } catch (error) {
    console.error(error);
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  registrarTroca(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    registrarTroca(tabId);
  }
});