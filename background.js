let currentTab = null;
let startTime = null;

/**
 * Identifica aplicação automaticamente
 */
function identificarAplicacao(url, hostname, titulo = "") {
  const urlLower = url.toLowerCase();
  const hostLower = hostname.toLowerCase();
  const tituloLower = titulo.toLowerCase();

  // Microsoft
  if (hostLower.includes("teams")) {
    return {
      empresa: "Microsoft",
      aplicacao: "Teams",
      categoria: "Reuniao"
    };
  }

  if (
    hostLower.includes("outlook") ||
    hostLower.includes("office")
  ) {
    return {
      empresa: "Microsoft",
      aplicacao: "Outlook",
      categoria: "Email"
    };
  }

  if (hostLower.includes("sharepoint")) {
    return {
      empresa: "Microsoft",
      aplicacao: "SharePoint",
      categoria: "Documentos"
    };
  }

  if (hostLower.includes("onedrive")) {
    return {
      empresa: "Microsoft",
      aplicacao: "OneDrive",
      categoria: "Armazenamento"
    };
  }

  // Google
  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/spreadsheets/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Sheets",
      categoria: "Planilha"
    };
  }

  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/document/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Docs",
      categoria: "Documento"
    };
  }

  if (
    hostLower.includes("docs.google.com") &&
    urlLower.includes("/presentation/")
  ) {
    return {
      empresa: "Google",
      aplicacao: "Google Slides",
      categoria: "Apresentacao"
    };
  }

  if (hostLower.includes("drive.google")) {
    return {
      empresa: "Google",
      aplicacao: "Google Drive",
      categoria: "Armazenamento"
    };
  }

  if (hostLower.includes("meet.google")) {
    return {
      empresa: "Google",
      aplicacao: "Google Meet",
      categoria: "Reuniao"
    };
  }

  if (hostLower.includes("mail.google")) {
    return {
      empresa: "Google",
      aplicacao: "Gmail",
      categoria: "Email"
    };
  }

  // GitHub
  if (hostLower.includes("github")) {
    return {
      empresa: "GitHub",
      aplicacao: "GitHub",
      categoria: "Desenvolvimento"
    };
  }

  // GitLab
  if (hostLower.includes("gitlab")) {
    return {
      empresa: "GitLab",
      aplicacao: "GitLab",
      categoria: "Desenvolvimento"
    };
  }

  // IA
  if (
    hostLower.includes("chatgpt") ||
    hostLower.includes("openai")
  ) {
    return {
      empresa: "OpenAI",
      aplicacao: "ChatGPT",
      categoria: "IA"
    };
  }

  if (hostLower.includes("claude")) {
    return {
      empresa: "Anthropic",
      aplicacao: "Claude",
      categoria: "IA"
    };
  }

  if (hostLower.includes("copilot")) {
    return {
      empresa: "Microsoft",
      aplicacao: "Copilot",
      categoria: "IA"
    };
  }

  // Comunicação
  if (hostLower.includes("whatsapp")) {
    return {
      empresa: "Meta",
      aplicacao: "WhatsApp",
      categoria: "Comunicacao"
    };
  }

  if (hostLower.includes("slack")) {
    return {
      empresa: "Slack",
      aplicacao: "Slack",
      categoria: "Comunicacao"
    };
  }

  if (hostLower.includes("discord")) {
    return {
      empresa: "Discord",
      aplicacao: "Discord",
      categoria: "Comunicacao"
    };
  }

  // CRM
  if (hostLower.includes("salesforce")) {
    return {
      empresa: "Salesforce",
      aplicacao: "Salesforce",
      categoria: "CRM"
    };
  }

  if (hostLower.includes("hubspot")) {
    return {
      empresa: "HubSpot",
      aplicacao: "HubSpot",
      categoria: "CRM"
    };
  }

  // ERP
  if (
    hostLower.includes("totvs") ||
    tituloLower.includes("totvs")
  ) {
    return {
      empresa: "TOTVS",
      aplicacao: "TOTVS",
      categoria: "ERP"
    };
  }

  return {
    empresa: "Desconhecida",
    aplicacao: hostname,
    categoria: "Nao Classificado"
  };
}

/**
 * Extrai informações da URL
 */
function obterDadosUrl(url) {
  try {
    const parsed = new URL(url);

    return {
      url: parsed.href,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      protocolo: parsed.protocol
    };
  } catch {
    return {
      url,
      hostname: "desconhecido",
      pathname: "",
      protocolo: ""
    };
  }
}

async function salvarRegistro(registro) {
  try {
    const storage = await chrome.storage.local.get("registros");

    const registros = storage.registros || [];

    registros.push(registro);

    await chrome.storage.local.set({
      registros
    });

    console.log("Registro salvo:", registro);

  } catch (error) {
    console.error("Erro ao salvar registro:", error);
  }
}

async function registrarTroca(tabId) {
  try {

    const tab = await chrome.tabs.get(tabId);

    if (!tab.url || tab.url.startsWith("chrome://")) {
      return;
    }

    const agora = new Date();

    if (currentTab && startTime) {

      const duracaoSegundos = Math.floor(
        (
          agora.getTime() -
          new Date(startTime).getTime()
        ) / 1000
      );

      if (duracaoSegundos >= 5) {

        const dados = obterDadosUrl(currentTab.url);

        const info = identificarAplicacao(
          currentTab.url,
          dados.hostname,
          currentTab.title
        );

        const registro = {
          url: dados.url,
          hostname: dados.hostname,
          pathname: dados.pathname,
          protocolo: dados.protocolo,

          empresa: info.empresa,
          aplicacao: info.aplicacao,
          categoria: info.categoria,

          titulo: currentTab.title,

          inicio: startTime,
          fim: agora.toISOString(),

          duracaoSegundos
        };

        await salvarRegistro(registro);
      }
    }

    currentTab = {
      url: tab.url,
      title: tab.title
    };

    startTime = agora.toISOString();

    const dadosAtuais = obterDadosUrl(tab.url);

    console.log(
      `Monitorando: ${dadosAtuais.hostname}`
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