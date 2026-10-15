const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";

// TEMPORÁRIO
// Depois vamos obter automaticamente do usuário logado
const USER_ID = "662bb8f3-684f-4a31-a34d-98195f226109";

let currentTab = null;
let startTime = null;

/**
 * Envia registro para o Supabase
 */
async function enviarParaSupabase(registro) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/web_events`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
   body: JSON.stringify({
  user_id: USER_ID,
  domain: registro.hostname,
  started_at: registro.inicio,
  ended_at: registro.fim,
  is_active: false,
  source: "chrome-extension"
})
      }
    );

    if (!response.ok) {
      const erro = await response.text();
      console.error("❌ Erro Supabase:", erro);
      return;
    }

    console.log("✅ Enviado para Supabase:", registro.hostname);

  } catch (error) {
    console.error("❌ Falha ao enviar:", error);
  }
}

/**
 * Identifica aplicação automaticamente
 */
function identificarAplicacao(url, hostname, titulo = "") {
  const urlLower = url.toLowerCase();
  const hostLower = hostname.toLowerCase();
  const tituloLower = titulo.toLowerCase();

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

  if (hostLower.includes("github")) {
    return {
      empresa: "GitHub",
      aplicacao: "GitHub",
      categoria: "Desenvolvimento"
    };
  }

  if (hostLower.includes("gitlab")) {
    return {
      empresa: "GitLab",
      aplicacao: "GitLab",
      categoria: "Desenvolvimento"
    };
  }

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
 * Extrai dados da URL
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

/**
 * Salva localmente e envia ao Supabase
 */
async function salvarRegistro(registro) {
  try {
    const storage = await chrome.storage.local.get("registros");

    const registros = storage.registros || [];

    registros.push(registro);

    await chrome.storage.local.set({
      registros
    });

    console.log("Registro salvo:", registro);

    await enviarParaSupabase(registro);

  } catch (error) {
    console.error("Erro ao salvar:", error);
  }
}

/**
 * Registra troca de abas
 */
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

console.log("🚀 Portal Produtividade iniciado!");