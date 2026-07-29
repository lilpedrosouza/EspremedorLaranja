# 🍊 Espremedor de Laranja — pedidos de cápsulas

Cada pessoa entra, escolhe os sabores e a quantidade de caixas. Quem tem o perfil
de **comprador** vê tudo somado numa lista só, com o quanto cada um deve.

Os dados ficam num Postgres (Supabase) e o servidor é Node puro, sem framework.

## Publicar — o caminho curto

Três passos. O terceiro é opcional.

### 1. Banco no Supabase

1. Crie um projeto em [supabase.com](https://supabase.com) (plano free serve).
2. Vá em **Project Settings → Database → Connection string → URI**.
3. Copie a string do **pooler** (*Session pooler* ou *Transaction pooler*), não a
   *Direct connection* — a direta só atende por IPv6 e a Railway não alcança.
4. Troque `[YOUR-PASSWORD]` pela senha do banco.

Não precisa criar tabela: o servidor roda [`banco/schema.sql`](banco/schema.sql)
sozinho ao subir, e na primeira vez já grava o catálogo de partida.

### 2. Backend na Railway

1. Em [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**
   e escolha este repositório.
2. Em **Variables**, adicione `DATABASE_URL` com a string do passo 1.
3. Em **Settings → Networking → Generate Domain**, para ganhar um endereço público.

Pronto — abrindo esse endereço o sistema já funciona inteiro, porque o próprio
backend também serve a tela. **Se parar por aqui, está publicado.**

### 3. Front separado — só se você quiser

Serve para deixar a tela num endereço mais bonitinho e de graça (GitHub Pages,
Netlify, Cloudflare Pages). Custa duas configurações a mais:

1. Em [`publico/config.js`](publico/config.js), ponha o endereço da Railway:
   ```js
   window.API = 'https://seu-app.up.railway.app';
   ```
2. Na Railway, adicione a variável `ORIGENS_PERMITIDAS` com o endereço do front:
   ```
   ORIGENS_PERMITIDAS=https://lilpedrosouza.github.io
   ```
   Sem isso o navegador bloqueia as chamadas por CORS.

Para o GitHub Pages já existe um workflow pronto:
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publica a pasta
`publico/` a cada push na `main`.

**A origem precisa estar em Actions:** vá em **Settings → Pages → Source** e
escolha **GitHub Actions**. Se ficar em *"Deploy from a branch"*, o Pages serve a
raiz do repositório pelo Jekyll — o que vai no ar é o README renderizado, e não a
tela. Dá para perceber pelo título da aba trazer `| EspremedorLaranja` no fim.

O endereço fica `https://SEUUSUARIO.github.io/EspremedorLaranja/` — repare na
pasta no fim, que é o padrão de repositório de projeto.

> Vale lembrar: sem o passo 2 nada disso é necessário. Um deploy só é mais
> simples de manter que dois.

## Rodar na sua máquina

```bash
npm install
cp .env.example .env      # e preencha a DATABASE_URL
node servidor.js
```

Pode apontar para o mesmo banco do Supabase — só lembre que aí você mexe nos
dados de verdade. Para uma rodada de teste, crie um segundo projeto no Supabase.

## As variáveis

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | **Obrigatória.** Conexão do Postgres/Supabase (use a do pooler). |
| `ORIGENS_PERMITIDAS` | Endereços do front hospedado à parte, separados por vírgula. Vazio = só o front servido pelo próprio backend. |
| `PORT` / `PORTA` | Porta. A Railway define sozinha. |
| `SEM_SINCRONIA` | `1` desliga a leitura do site da Nescafé ao subir. |

Local elas saem do `.env` (que o Git ignora). Na Railway, do painel.

## O dia a dia

1. **O primeiro acesso criado vira o comprador.** Cadastre-se antes de divulgar
   o link.
2. Você abre uma rodada e dá um nome a ela (*Fechamento* → *Rodada*). Dá para
   deixar um recado que aparece na tela de todo mundo, tipo "peça até sexta, 12h".
3. O pessoal entra, escolhe e envia. Cada um pode mudar o próprio pedido enquanto
   a rodada estiver aberta.
4. Você abre *Fechamento*, confere a lista somada, usa **Copiar lista** (sai
   pronta para colar no grupo do WhatsApp) ou **Baixar planilha** (CSV que abre no
   Excel com `;` e vírgula decimal).
5. Compra no site e clica em **Fechar rodada e começar outra**. A rodada antiga
   vira histórico.

## Segurança — leia antes de divulgar o link

**O cadastro é aberto.** Qualquer pessoa com o endereço pode criar um acesso e
ver o catálogo e a rodada. Numa rede interna isso não importava; num endereço
público, importa. Não há convite nem código de acesso — se quiser isso, é
preciso implementar.

O que já está resolvido: a hospedagem serve por HTTPS, então senha não trafega
em texto puro; as senhas ficam guardadas com scrypt e sal; e o token de sessão
vale 30 dias e morre no *Sair*.

Ainda assim, combine com o pessoal para não reaproveitar senha de outro sistema.

## De onde vêm os sabores

O catálogo já vem preenchido com os sabores lidos da página
`nescafe-dolcegusto.com.br/sabores`.

A partir daí o servidor relê a página **ao subir e a cada 12 horas**, ajustando
preços, novidades e o que ficou sem estoque. Nada é apagado: se um sabor sai do
site, ele fica marcado como *saiu do site* na aba **Catálogo** para você decidir.

Na mão, quando quiser:

- pela tela: aba **Catálogo** → *Atualizar do site agora*;
- pelo terminal: `node scripts/atualizar-produtos.js` (ou `--simular` para só ver
  o que mudaria).

Se a rede bloquear a saída para o site, a atualização falha e o catálogo atual
continua valendo — a aba *Catálogo* mostra o motivo.

### Como a leitura é feita

O site é uma loja Magento atrás de um CDN (Akamai) que barra robôs. A leitura
tenta dois caminhos, nesta ordem:

1. **A API GraphQL da própria loja** (`/graphql`) — é o caminho normal e o que
   funciona hoje. Vem tudo pronto: nome, preço cheio e com desconto, foto,
   estoque e as categorias de verdade do site.
2. **A página `/sabores`**, como reserva. Essa é a mais protegida: o CDN compara
   até a "impressão digital" do TLS, que a do Node não imita, então costuma dar
   403. Quando isso acontece, o programa tenta pelo `curl` do sistema.

O `robots.txt` do site libera `/sabores` e `/media/catalog/product/*`, então a
leitura é permitida. A busca é leve: uma vez ao subir e a cada 12 horas.

Duas travas evitam que uma leitura ruim estrague o catálogo:

- se o CDN devolver a **página de verificação** (responde 200, mas só tem
  JavaScript), ela é recusada em vez de virar produto de mentira;
- se a leitura reconhecer **menos de 60%** do que já se conhecia, ninguém é
  marcado como *saiu do site*.

### Cápsula avulsa × caixa

O site lista o mesmo sabor duas vezes: `CAFÉ AU LAIT` é **uma cápsula**
(R$ 1,79) e `CAFÉ AU LAIT 10 CÁPSULAS` é **a caixa** (R$ 17,90). Aqui se pede
por caixa, então só o que tem a contagem de cápsulas no nome entra marcado na
tela de pedido — senão bastaria alguém clicar no item errado para o fechamento
cobrar dez vezes menos do que a compra custou.

Nada é apagado: o avulso continua no catálogo, apenas desmarcado. Combos,
acessórios e os pacotes "PARA NEGÓCIOS" (20 e 30 caixas) seguem a mesma regra.
Se quiser algum deles na lista, marque "na lista" na aba **Catálogo** — a
sincronização não desfaz essa escolha.

### Fotos dos sabores

Quando a leitura vem pela API da loja, as fotos vêm junto. Se faltar alguma,
cole o link da imagem na aba **Catálogo**, coluna **Imagem**: abra o sabor no
site pelo navegador, copie o endereço da foto (botão direito → *copiar endereço
da imagem*) e cole ali. Se o link parar de funcionar, o círculo colorido volta a
aparecer sozinho.

## Os arquivos

```
servidor.js                    servidor HTTP e regras
banco/schema.sql               estrutura das tabelas (roda sozinho ao subir)
lib/banco.js                   o único lugar que fala SQL
lib/catalogo-nescafe.js        leitura do site da Nescafé
lib/ambiente.js                lê o .env quando você roda local
scripts/atualizar-produtos.js  atualização do catálogo pelo terminal
publico/                       a tela (HTML, CSS e JavaScript)
  config.js                    endereço da API, só se o front for hospedado à parte
dados-iniciais/produtos.json   catálogo de partida
railway.json                   configuração do deploy do backend
.github/workflows/pages.yml    publica publico/ no GitHub Pages
```

Backup é o do próprio Supabase (**Database → Backups**).

A pasta `dados/`, se existir aí na sua máquina, é do sistema antigo, quando tudo
ficava em arquivos JSON. Ela não é mais lida e está no `.gitignore` porque tem
nomes, hashes de senha e sessões de gente de verdade.
