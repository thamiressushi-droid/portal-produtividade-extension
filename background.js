const SUPABASE_URL = "https://lqiftfrbdtqcrfxcthao.supabase.co";
const SUPABASE_KEY = "sb_publishable_a1G3noc-lXu2NWCBO7k6Yg_xi7-5fBB";

async function obterUserId() {
  const dados = await chrome.storage.local.get([
    "portalUserId",
    "user_id"
  ]);

  console.log("📦 Storage:", dados);

  if (dados.portalUserId) {
    console.log(
      "✅ Usuário recebido do portal:",
      dados.portalUserId
    );

    return dados.portalUserId;
  }

  if (dados.user_id) {
    return dados.user_id;
  }

  console.warn(
    "⚠️ Nenhum usuário recebido do portal. Usando UUID temporário."
  );

  return "662bb8f3-684f-4a31-a34d-98195f226109";
}

let currentTab = null;
let startTime = null;

/**
 * Envia registro para o Supabase
 */
async function enviarParaSupabase(registro) {
  try {
    const userId = await obterUserId();

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
          user_id: userId,
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

      console.error(
        "❌ Erro Supabase:",
        response.status,
        erro
      );

      return;
    }

    console.log(
      "✅ Enviado para Supabase:",
      registro.hostname
    );

  } catch (error) {
    console.error(
      "❌ Falha ao enviar:",
      error
    );
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
        (agora.getTime() - new Date(startTime).getTime()) / 1000
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

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      message?.type !==
      "PORTAL_IDENTITY_CHANGED"
    ) {
      return;
    }

    console.info(
      "[Portal Extensão] Mensagem recebida",
      {
        senderUrl: sender?.url,
        hasUserId:
          typeof message.userId === "string",
        userIdIsNull:
          message.userId === null
      }
    );

    if (
      message.userId !== null &&
      typeof message.userId !== "string"
    ) {
      console.error(
        "[Portal Extensão][background] Identidade rejeitada: userId deve ser string ou null"
      );
      sendResponse({
        ok: false,
        stage: "validation"
      });
      return;
    }

    console.info(
      "[Portal Extensão][background] Iniciando gravação no chrome.storage.local",
      {
        operation:
          message.userId === null ? "remove" : "set"
      }
    );

    const operation =
      message.userId === null
        ? chrome.storage.local.remove("portalUserId")
        : chrome.storage.local.set({
            portalUserId: message.userId
          });

    void operation
      .then(async () => {
        const stored = await chrome.storage.local.get("portalUserId");
        const persisted =
          message.userId === null
            ? !Object.hasOwn(stored, "portalUserId")
            : stored.portalUserId === message.userId;

        if (!persisted) {
          console.error(
            "[Portal Extensão][background] Storage não confirmou o valor esperado"
          );
          sendResponse({
            ok: false,
            stage: "storage_verification"
          });
          return;
        }

        console.info(
          "[Portal Extensão][background] Identidade persistida e verificada"
        );
        sendResponse({
          ok: true,
          stage: "storage"
        });
      })
      .catch((error) => {
        console.error(
          "[Portal Extensão][background] Erro ao atualizar chrome.storage.local",
          error
        );
        sendResponse({
          ok: false,
          stage: "storage"
        });
      });

    return true;
  }
);

console.info(
  "[Portal Extensão][background] Listener PORTAL_IDENTITY_CHANGED registrado"
);

console.log("🚀 Portal Produtividade iniciado!");