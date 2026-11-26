# portal-produtividade-extension
Plugin do navegador

Versão final desta integração: **1.2.0**.

## Monitoramento inteligente

### Mecanismos independentes

1. **Inatividade humana:** `inactivity_threshold_minutes` permanece
   administrativo e atualmente configurado em 3 minutos. Durante o expediente
   regular, esse limite cria eventos de inatividade, mas não encerra a sessão.
2. **Encerramento excepcional:** após o horário configurado de saída, a
   ausência consecutiva de interação encerra a sessão após 10 minutos. Esse
   prazo não usa nem altera o limite de 3 minutos.
3. **Heartbeat:** confirma continuidade técnica a cada 30 segundos. Heartbeats
   não são atividade humana e gaps maiores que cinco minutos encerram apenas até
   o último instante confirmado, sem retroatividade.

A extensão mantém uma confirmação local a cada 30 segundos e persiste o último
heartbeat válido. Uma lacuna maior que cinco minutos encerra o segmento apenas
até o último instante confirmado; não estima atividade ou inatividade durante
a lacuna. Alarmes atrasados e suspensão do service worker não são presumidos
como hibernação, apenas a tolerância temporal define a interrupção.

A jornada usa cache local e carrega periodicamente as configurações reais da
tabela `settings` com o JWT autenticado da extensão: `work_journey`,
`inactivity_threshold_minutes`, `post_work_inactivity_tolerance_minutes`,
`heartbeat_frequency_seconds` e `activities_module_enabled`. O fallback local
inicial é entrada 08:12, almoço 12:00–13:00, saída 18:00, segunda a sexta,
America/Sao_Paulo, inatividade de 3 minutos e tolerância excepcional de 10
minutos. O campo `effective_from` da jornada é respeitado.

Após o horário de saída, uma interação abre uma confirmação via notificação ou
pelas ações do popup. Sem confirmação, a extensão encerra o segmento após a
tolerância excepcional e não presume automaticamente atividade contínua.
Trocas automáticas de página e aba não iniciam monitoramento por si só.

Os contratos de banco utilizados continuam em `web_events`,
`inactivity_events`, `settings` e `extension_heartbeats`. O heartbeat do
Supabase é enviado autenticado com o JWT do usuário e a versão do manifest,
sem histórico retroativo. O último heartbeat confirmado pelo servidor é
diferenciado da confirmação técnica local.

Os intervalos de navegação são registrados como ativos enquanto houver
interação recente do usuário (mouse, teclado, rolagem ou clique). O limite de
inatividade é lido da tabela `settings`, na chave
`inactivity_threshold_minutes`, e atualizado periodicamente. Ao atingir o
limite, a extensão registra o intervalo em `web_events` e abre um evento em
`inactivity_events`; ao retornar a atividade, finaliza esse evento. O último
limite válido fica em cache local para uso temporário se o Supabase estiver
indisponível. Uma sessão pendente é recuperada sem contabilizar o período em que
o navegador esteve fechado.

No Protheus/TOTVS, o módulo `content-protheus.js` identifica a rotina pela aba
ativa (`wa-tab-button[active]`) e o contexto visível pelo atributo `caption` de
`wa-text-view`, inclusive dentro de shadow roots, sem uma lista fixa de telas.
Ele envia esses valores para `content-activity.js`, que os inclui nos campos
`screen_name` e `screen_context` de `web_events`. A captura padrão dos demais
sites permanece inalterada. A migração em
`supabase/migrations` adiciona a coluna `screen_context`. Em ferramentas de
conversa e e-mail reconhecidas (Copilot, ChatGPT, Claude, Gemini, WhatsApp,
Teams, Outlook, Gmail, Slack e Discord), os títulos são substituídos pelo nome
do aplicativo e o contexto da tela não é coletado.

Todos os `web_events` e `inactivity_events` são gravados primeiro em um outbox
persistente do IndexedDB da extensão. A sincronização envia um evento por vez,
na ordem de captura, e só o remove após uma resposta de sucesso. Falhas de rede,
indisponibilidade do Supabase ou ausência de identidade mantêm os eventos na
fila para novas tentativas. O alarme periódico retoma o envio após reiniciar o
navegador; IDs idempotentes e a migration
`20261030140000_add_client_event_ids.sql` evitam duplicações no servidor.
Ao trocar de conta, eventos pendentes cujo `user_id` não corresponde ao JWT da
sessão atual são descartados individualmente quando a identidade salva e o JWT
confirmam a nova sessão; os demais eventos continuam sendo processados.

A identidade autenticada é persistida em `chrome.storage.local` e recuperada
após reiniciar o navegador. Se ela ainda não estiver salva, o background
consulta as abas abertas do portal; a ausência de uma sessão numa aba não apaga
uma identidade já persistida. Um logout explícito remove a identidade. Eventos
já enfileirados mantêm a identidade que tinham no momento da captura. O popup
mostra a contagem de eventos pendentes, o último envio bem-sucedido e o último
erro.

O bridge também lê o `access_token` da sessão Supabase do portal e o persiste
em `chrome.storage.local`. As gravações em `web_events` enviam esse JWT no
cabeçalho `Authorization: Bearer` e só são feitas quando ele declara a role
`authenticated` e corresponde ao `user_id` do evento; sem isso, a requisição é
mantida no outbox em vez de usar a role `anon`. A role usada ou o motivo do
bloqueio aparece nos logs da extensão e no status do popup. As demais chamadas
Supabase permanecem inalteradas.

O content script escuta mensagens `postMessage` estruturadas do portal com
`source: "portal-produtividade-auth"`. O portal deve emitir `SESSION_SYNC`
com `accessToken` e `userId` para `SIGNED_IN`, `TOKEN_REFRESHED` e
`INITIAL_SESSION` com sessão válida, e `SESSION_CLEARED` quando a sessão for
nula ou ocorrer `SIGNED_OUT`. Por exemplo, registre este listener no código do
portal depois de criar o cliente Supabase:

```js
supabase.auth.onAuthStateChange((event, session) => {
  if (!session) {
    window.postMessage(
      { source: "portal-produtividade-auth", type: "SESSION_CLEARED" },
      window.location.origin
    );
    return;
  }

  if (
    ["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION"].includes(event) &&
    session.access_token &&
    session.user?.id
  ) {
    window.postMessage(
      {
        source: "portal-produtividade-auth",
        type: "SESSION_SYNC",
        accessToken: session.access_token,
        userId: session.user.id,
        email: session.user.email ?? null,
        expiresAt: session.expires_at ?? null
      },
      window.location.origin
    );
  }
});
```

O evento `INITIAL_SESSION` sincroniza automaticamente uma sessão já ativa
quando o listener de autenticação é registrado; o bridge da extensão é
carregado em `document_start` para estar pronto para recebê-lo. Mensagens da
página sem o `source` esperado são ignoradas; a leitura de `localStorage` e a
consulta do background continuam disponíveis como recuperação da sessão.

O background centraliza o estado em `portalAuthState`, persiste a nova
identidade e o JWT juntos, e só retoma o outbox depois de confirmar a troca de
usuário. `SESSION_CLEARED` remove as credenciais e pausa o envio. A validade é
verificada pelos claims `role`, `sub` e `exp` do JWT, além de `expiresAt` quando
informado pelo portal; um alarme marca a sessão expirada mesmo com o popup
fechado, e a fila revalida o estado antes de cada envio. O popup mostra
`⚠️ Sessão desconectada ou expirada` se não houver uma sessão válida e permite
focar uma aba existente ou abrir o Portal pelo botão `Conectar ao Portal`.

As gravações e atualizações de `inactivity_events` também usam o JWT autenticado.
A migration `20261030193200_reconcile_inactivity_event_permissions.sql`
concede os privilégios de tabela necessários à role `authenticated`, substitui
as policies anteriores por regras próprias para `SELECT`, `INSERT` e `UPDATE`,
e limita o acesso às linhas cujo `user_id` corresponde a `auth.uid()`. A role,
o método, o `user_id` enviado e a correspondência com o `sub` do JWT aparecem
nos logs; a role ou o motivo do bloqueio aparece separadamente no popup.
