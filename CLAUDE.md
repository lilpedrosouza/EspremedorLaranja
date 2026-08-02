# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Idioma

Todo o projeto é em português do Brasil: nomes de variáveis e funções, comentários,
mensagens de erro, tela e mensagens de commit. Escreva código novo no mesmo idioma
(`requisicao`, `resposta`, `falha`, `consulta`, `desenharX`, `carregarX`). As mensagens
de commit são em pt-BR, no imperativo e **sem acentos** (veja `git log`).

## Comandos

```bash
npm install
node servidor.js                          # ou npm start — sobe em PORT/PORTA (padrão 3000)
npm run testar-banco                      # confere a DATABASE_URL e explica a falha em português
npm run atualizar-catalogo                # lê o site da Nescafé e grava; --simular só mostra
npm run configurar-pix "<chave>" "<nome>" ["<cidade>"]   # --mostrar | --apagar
```

Não há suíte de testes, linter nem etapa de build — nem no repositório nem no deploy.
Verificação é rodar o servidor e exercitar a tela.

Para rodar local sem esperar (e sem depender da) leitura do site da Nescafé, use
`SEM_SINCRONIA=1` no `.env`. `DATABASE_URL` é obrigatória: sem ela `lib/banco.js` mata o
processo na carga do módulo. Apontar para o banco de produção mexe em dados de verdade —
para testar, crie um segundo projeto no Supabase.

## Arquitetura

Node puro, sem framework. As únicas dependências são `pg` e `qrcode`. O mesmo processo
serve a API e a tela estática de `publico/`.

**`servidor.js`** — HTTP, sessões e regras de negócio. `tratarApi()` é uma cadeia linear
de `if (rota === ... && metodo === ...)`; rota nova entra como mais um `if` antes do 404
final. A autorização é feita por dois fechamentos, `exigeLogin()` e `exigeComprador()`,
chamados no começo de cada rota — eles já respondem 401/403 e devolvem `false`, daí o
padrão `if (!exigeComprador()) return;`.

**`lib/banco.js`** — o único arquivo que fala SQL. Traduz `coluna_do_banco` ↔
`campoDoJavaScript` nas funções `paraProduto` / `paraRodada` / `paraPedido` / `paraUsuario`.
Campo novo exige mexer em quatro lugares: `banco/schema.sql`, o mapper `paraX`, a lista de
`valoresDoProduto` (ou o upsert correspondente) e a rota que expõe.

**`banco/schema.sql`** roda inteiro a cada `banco.iniciar()`, ou seja, a cada boot. É
todo `if not exists`, e migração de coluna é uma linha
`alter table X add column if not exists ...` acrescentada ao fim do bloco da tabela.
Não existe ferramenta de migração. Com a tabela `produtos` vazia, o boot grava
`dados-iniciais/produtos.json` como catálogo de partida.

**`lib/catalogo-nescafe.js`** — leitura do catálogo da Nescafé, com cascata de fallbacks:
GraphQL da loja → HTML de `/sabores` (três parsers, o de mais resultados vence) → `curl`
do sistema quando o `fetch` do Node leva 403 por impressão digital do TLS. Três travas
protegem o catálogo de uma leitura ruim: `pareceBloqueio()` recusa a página de desafio do
CDN, `RESIDUO_DE_MARCACAO` descarta nome com sobra de HTML, e `leituraParcial` (menos de
60% do conhecido reconhecido) impede marcar produto como *saiu do site*. Nada é apagado —
o que sumiu vira `foraDoSite`.

**`lib/precos.js`** — análise do histórico de preço. Só contas, sem SQL e sem HTTP,
como `lib/pix.js`. Duas ideias sustentam o módulo: a média é **ponderada pelo tempo**
(cada preço pesa quanto tempo ficou valendo, senão uma promoção de dois dias entraria
com o mesmo peso de um semestre), e a análise por dia da semana roda sobre uma **série
diária reconstruída** (`serieDiaria` arrasta o último preço conhecido dia a dia, porque
só os dias de mudança diriam qual dia o site mexe no preço, não qual dia é barato). Toda
função devolve um estado de "ainda não sei" — `situacao: 'sem-dados'`, `suficiente: false`
— em vez de concluir com pouca amostra.

**`lib/pix.js`** — monta o BR Code (EMV®QRCPS) com CRC16/CCITT-FALSE. Sem dependência
externa; o QR em SVG sai do `qrcode` em `servidor.js`.

**`publico/`** — página única em JavaScript de navegador puro, sem build nem framework.
Um objeto global `estado`, funções `desenharX()` que reconstroem HTML e `trocarAba()` que
carrega os dados da aba. As abas são `loja`, `rastreio`, `fechamento`, `catalogo`,
`pessoas`; as duas do meio só existem para o comprador (classe `.so-comprador`).

## Modelo de domínio

- **Papéis**: `comprador` e `colega`. O primeiro cadastro do banco vira comprador
  automaticamente; depois só um comprador promove alguém, e o sistema não deixa ficar sem
  nenhum.
- **Rodada**: só pode haver uma aberta. Quem garante é o índice parcial
  `rodada_aberta_unica`, e `garantirRodadaAberta()` conta com o `on conflict do nothing`
  para que duas requisições simultâneas não criem duas rodadas.
- **Pedido**: chave primária composta `(rodada_id, usuario_id)`, gravado por upsert — não
  há ler-modificar-gravar. `itens` é `jsonb` de propósito: é uma fotografia com nome e
  preço congelados no momento do pedido, e não uma referência ao catálogo.
- **Pagamento**: duas marcações independentes. `pago_em` é a pessoa avisando; `confirmado_em`
  é o comprador confirmando que caiu. Alterar o pedido zera as duas (o valor mudou).
- **Dívida sobrevive ao fechamento**: `/api/minhas-rodadas` (para quem deve) e
  `/api/pendencias` (para o comprador) leem pedidos de rodadas já fechadas com
  `confirmado_em is null`.
- **Histórico de preço**: a tabela `precos` ganha uma linha **só quando o preço muda**
  — a conferência está no próprio `insert` (`SQL_REGISTRAR_PRECO`), não em código. Cada
  linha vale até a próxima, então quem lê reconstrói o preço de qualquer dia. A gravação
  entra na mesma transação de `salvarCatalogo`, e `atualizarProduto` também registra: preço
  corrigido na mão é história de preço igual. A janela de análise é de 180 dias
  (`JANELA_PRECOS_DIAS`), que é o que segura o tamanho da consulta — a tabela cresce para
  sempre.
- **Cápsula avulsa × caixa**: o site vende os dois com o mesmo nome-base. Só o item com
  contagem de cápsulas no nome (`pareceCaixa`) entra `ativo`, senão o fechamento cobraria
  dez vezes menos. `esconderPrecoDeUnidade()` reforça isso a cada sincronização, mas nunca
  mexe em produto de `origem: 'manual'` — a escolha feita na aba Catálogo é preservada.

## Armadilhas conhecidas

- **`PORT` ganha de `PORTA`.** Inverter a precedência derruba o deploy da Railway inteiro.
- **Autenticação é `Authorization: Bearer`, nunca cookie**, porque o front pode estar em
  outro domínio (GitHub Pages) e cookie de terceiro não é confiável. O token fica no
  `localStorage`.
- **CORS**: `aplicarCors()` só ecoa origem que esteja em `ORIGENS_PERMITIDAS`. O
  `Access-Control-Expose-Headers: Content-Disposition` é necessário para o front em outro
  domínio ler o nome do arquivo da planilha. O CSV é baixado por `fetch` + blob, não por
  link simples, porque precisa do cabeçalho de autorização.
- **Tipos de parâmetro do `pg`**: em `update` com valor possivelmente `null`, escreva o
  cast (`$2::text`, `$3::timestamptz`) — sem ele o Postgres recusa com "could not determine
  data type of parameter".
- **Dia da semana é calculado em UTC-3 fixo** (`FUSO_BRASIL_MS`), não no fuso do
  servidor. A Railway roda em UTC, e um preço gravado à 01:00 de terça em UTC ainda é
  segunda à noite aqui — usar `getDay()` direto jogaria a amostra no dia errado. O Brasil
  não tem horário de verão desde 2019, então o deslocamento fixo serve.
- **A chave Pix mora no banco** (tabela `configuracao`), nunca no código: costuma ser CPF e
  o repositório é público. `.env` e `dados/` (do sistema antigo em JSON, com hashes de senha
  reais) são ignorados pelo Git e devem continuar assim.
- **O cadastro é aberto** — qualquer pessoa com o endereço cria acesso. É uma decisão
  consciente, documentada no README; não "corrija" isso sem pedir.

## Deploy

Backend na Railway (`railway.json`, healthcheck em `/api/sessao`), banco no Supabase
(use a string do *pooler*, não a *Direct connection*, que só atende IPv6). O backend já
serve `publico/`, então um deploy só basta. Publicar o front à parte no GitHub Pages
(`.github/workflows/pages.yml`) exige preencher `publico/config.js` com `window.API` e
listar esse endereço em `ORIGENS_PERMITIDAS` no backend.

O README traz o passo a passo operacional completo, em linguagem de usuário.
