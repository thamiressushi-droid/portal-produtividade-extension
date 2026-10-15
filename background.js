let currentTab = null;
let startTime = null;

async function salvarRegistro(registro) {
  try {
    const storage = await chrome.storage.local.get("registros");

    const registros = storage.registros || [];

    registros.push(registro);

    await chrome.storage.local.set({
      registros,
    });

    console.log("Registro salvo:", registro);
  } catch (error) {
    console.error("Erro ao salvar registro:", error);
  }
}

async function registrarTroca(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    // Ignora páginas internas do Chrome
    if (!tab.url || tab.url.startsWith("chrome://")) {
      return;
    }

    const agora = new Date();

    // Salva o registro anterior
    if (currentTab && startTime) {
      const duracaoSegundos = Math.floor(
        (agora.getTime() - new Date(startTime).getTime()) / 1000
      );

      const registro = {
        domain: new URL(currentTab.url).hostname,
        titulo: currentTab.title,
        inicio: startTime,
        fim: agora.toISOString(),
        duracaoSegundos,
      };

      // Ignora registros muito curtos
      if (duracaoSegundos >= 5) {
        await salvarRegistro(registro);
      }
    }

    // Atualiza a aba atual
    currentTab = {
      url: tab.url,
      title: tab.title,
    };

    startTime = agora.toISOString();

    console.log(
      `Monitorando: ${new URL(tab.url).hostname}`
    );
  } catch (error) {
    console.error("Erro:", error);
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  registrarTroca(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    registrarTroca(tabId);
  }
});

console.log("Portal Produtividade iniciado!");