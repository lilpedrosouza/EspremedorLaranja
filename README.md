# 🍊 Espremedor de Laranja — pedidos de cápsulas

Cada pessoa entra, escolhe os sabores e a quantidade de caixas. Quem tem o perfil
de **espremedor** vê tudo somado numa lista só, com o quanto cada um deve.

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
| `BREVO_API_KEY` | Chave da API do Brevo, para mandar o e-mail de "esqueci minha senha". Vazia = o fluxo cai no código de recuperação. |
| `EMAIL_REMETENTE` | O endereço remetente, já verificado em Brevo → Senders. |
| `EMAIL_REMETENTE_NOME` | Nome que aparece como remetente. Padrão: *Espremedor de Laranja*. |
| `ENDERECO_DO_SITE` | Endereço público **da tela**, para montar o link do e-mail. Vazio = o primeiro de `ORIGENS_PERMITIDAS`. |

Local elas saem do `.env` (que o Git ignora). Na Railway, do painel.

## O dia a dia

1. **O primeiro acesso criado vira o espremedor.** Cadastre-se antes de divulgar
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

## Pagamento por Pix

Quem envia o pedido vê na hora o QR Code do espremedor, **já com o valor exato
que aquela pessoa deve** — mais o "copia e cola" e a chave escrita na tela.
Depois de pagar, ela marca *Já paguei*; o espremedor confere no **Fechamento** e
marca *Recebi o dinheiro*. São duas marcações separadas de propósito: uma coisa
é a pessoa avisar, outra é o dinheiro ter caído.

O Fechamento mostra a situação de cada um (*não pagou* · *avisou que pagou* ·
*pago*) e os totais **Recebido** e **A receber**.

Mexeu no pedido depois de pagar? As duas marcações caem e o QR passa a valer o
novo valor — senão alguém pagaria a conta errada.

### Fechar a rodada não apaga a dívida

Dá para fechar a rodada e adiantar a compra mesmo com gente devendo. Quem não
pagou continua vendo, na coluna **Rodadas anteriores**, o que pediu e o QR
daquela rodada, e pode pagar depois. O espremedor acompanha em *Fechamento* →
**Ficou devendo de rodadas anteriores**, que lista pessoa, rodada e valor até
ele confirmar o recebimento.

### Configurar a chave

```bash
node scripts/configurar-pix.js "000.000.000-00" "Nome De Quem Recebe" "Sao Paulo"
node scripts/configurar-pix.js --mostrar    # confere o que está gravado
node scripts/configurar-pix.js --apagar     # tira o QR da tela
```

Serve CPF, CNPJ, telefone, e-mail ou chave aleatória.

**A chave fica no banco, nunca no código.** Chave Pix costuma ser CPF, que é
dado pessoal, e este repositório é público — commitar isso exporia o CPF a
qualquer pessoa na internet, para sempre. No banco, ela só chega a quem está
logado no sistema.

Sem chave configurada nada quebra: a tela avisa para combinar o pagamento com o
espremedor, e o resto segue funcionando.

## Rastreio da entrega

A aba **Rastreio** mostra uma linha por rodada com o código da entrega e um
botão que abre o acompanhamento em `ondeestameupedido.com.br`.

Quem escreve o código é o espremedor, depois da compra. Todo mundo vê — quem
pediu tem interesse em saber onde as cápsulas estão.

Dá para colar **só o código** (`FR260730GKSEI`) ou **o endereço inteiro**
(`https://ondeestameupedido.com.br/FR260730GKSEI`): o sistema fica só com o
código nos dois casos, porque guardar a URL inteira faria o link virar
`.../https://...` e não abrir. Deixar o campo vazio e salvar tira o código.

O código fica preso à rodada: fechar a rodada não o apaga, e a rodada nova
começa sem código.

## Preço: está caro ou barato?

Toda vez que o servidor lê o site da Nescafé, ele guarda o preço de quem mudou.
Com isso cada sabor passa a ter um preço *normal*, e a tela consegue dizer se o
de hoje foge dele.

Na tela de sabores, o cartão ganha um selo — *12% abaixo da média*, *5% acima da
média* ou *no preço de sempre* — e um botão **histórico**, que abre o gráfico com
cada mudança de preço e o dia em que ela aconteceu. A linha tracejada é a média,
e abaixo do gráfico há a mesma informação em tabela.

O gráfico é feito em degraus de propósito: preço não sobe aos poucos entre uma
leitura e outra, ele fica parado e pula de uma vez.

### A média é ponderada pelo tempo

Um sabor que passou cinco meses a R$ 25 e dois dias em promoção a R$ 18 tem preço
normal de ~R$ 24,90, e não de R$ 21,50. A média simples contaria a promoção de
dois dias como se fosse metade do semestre, e aí quase todo dia pareceria caro.

### Melhor dia para comprar

No **Fechamento** aparece o bloco *Quando comprar*, com duas coisas:

- **o momento**: se a lista desta rodada está acima ou abaixo do que ela costuma
  custar — a resposta prática para "fecho agora ou espero?";
- **o dia da semana** que costuma sair mais barato, com a régua dos sete dias
  para você conferir a diferença entre eles.

Cada sabor entra pela variação em relação à média dele mesmo, e não em reais:
senão as cápsulas caras decidiriam a resposta sozinhas, só por serem caras.

**Enquanto não houver dado, a tela diz que não sabe.** São necessárias umas três
semanas de histórico e algumas mudanças de preço antes de apontar um dia; e se os
sete dias saírem praticamente iguais, ela diz isso também, em vez de eleger um
vencedor no ruído. É de propósito: um "melhor dia" tirado de duas semanas de
dados seria um palpite com cara de conclusão.

O histórico começa a ser gravado a partir da instalação desta versão — não há
como recuperar preço de antes. Nos primeiros dias, portanto, é normal a tela
mostrar tudo como "sem histórico ainda". A análise olha os últimos 180 dias.

## Entrar, e o que fazer quando esquecer a senha

O acesso é nome + senha. Quem digita o nome errado ouve *"não encontrei esse nome"*
com um atalho para criar o acesso; quem erra a senha ouve isso e ganha o atalho
para recuperar. Cinco tentativas erradas seguidas travam aquele nome por um
minuto, para ninguém ficar chutando senha dos outros.

### O link por e-mail

O caminho principal. Quem cria acesso agora **informa um e-mail**, e é para lá que
vai o link de redefinição.

Na tela de entrada: **Esqueci minha senha** → escreva seu nome *ou* seu e-mail →
o link chega na sua caixa. Ele **vale por uma hora e funciona uma vez só**; ao
abri-lo você escolhe a senha nova e já entra. Pedir um link novo derruba o
anterior, então o e-mail antigo na caixa de entrada não serve mais para nada.

A resposta da tela é sempre a mesma — *"se houver um acesso com esse nome ou
e-mail, o link foi enviado"* — exista a conta ou não. É diferente do que acontece
ao entrar, onde a tela diz que não achou o nome, e é de propósito: o nome já era
descobrível tentando criar um acesso, mas "este e-mail pertence a alguém daqui"
não, e é dado de gente que talvez nem use o sistema.

**Quem já tinha conta não tem e-mail cadastrado.** É só ir em *Minha conta* →
**Meu e-mail**, preencher e confirmar a senha.

#### Ligar o envio (uma vez só)

Sem isto configurado, o botão de e-mail nem aparece e a tela oferece direto o
código de recuperação. Nada quebra.

1. Crie conta em [brevo.com](https://www.brevo.com) (o plano gratuito manda 300
   e-mails por dia, para sempre).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: ponha seu
   e-mail mesmo e clique no link de confirmação que chega nele.
3. **SMTP & API → API Keys → Generate a new API key**.
4. Na Railway, em *Variables*:

   ```
   BREVO_API_KEY=xkeysib-...
   EMAIL_REMETENTE=voce@gmail.com
   ENDERECO_DO_SITE=https://lilpedrosouza.github.io/EspremedorLaranja
   ```

O `ENDERECO_DO_SITE` é o endereço **da tela**, que é para onde o link tem de
levar — se o front está no GitHub Pages, é o de lá, e não o da Railway.

### O código de recuperação

O caminho reserva, para quem não cadastrou e-mail ou não recebeu o link. **Ao
criar o acesso você também recebe um código** parecido com

```
K7HP-3QMD-XW9F-BTRJ
```

Ele aparece **uma única vez**. Anote no papel, no bloco de notas do celular, onde
quiser — é ele que devolve seu acesso depois. Guardamos só o resumo embaralhado
dele, então nem quem abre o banco consegue lê-lo.

Esqueceu a senha? Na tela de entrada, **Esqueci minha senha** → nome + código +
senha nova, e você já entra. O código gasto deixa de valer na hora e um novo
aparece na tela para você anotar no lugar do antigo.

**Quem já tinha conta antes disso não tem código.** É só ir em *Minha conta* →
**Código de recuperação**, confirmar a senha e gerar o seu. Vale fazer hoje: sem
código, esquecer a senha vira problema de outra pessoa resolver.

### Perdi o e-mail e o código

Aí é no braço: qualquer espremedor abre *Minha conta* → **Quem tem acesso** e
clica em **Redefinir senha** ao lado do seu nome. A própria tela de recuperação
mostra a quem pedir.

Trocar de senha por qualquer um desses caminhos **desconecta os outros
aparelhos** — quem estava logado no seu nome em outro lugar cai fora. Quem trocou
continua na tela normalmente.

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
lib/precos.js                  média, "está caro?" e melhor dia da semana
lib/pix.js                     monta o BR Code do Pix (copia e cola / QR)
lib/ambiente.js                lê o .env quando você roda local
scripts/atualizar-produtos.js  atualização do catálogo pelo terminal
scripts/configurar-pix.js      define a chave Pix de quem recebe
scripts/testar-banco.js        confere a conexão com o banco
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
