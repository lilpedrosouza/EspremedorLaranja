# 🍊 Espremedor de Laranja — pedidos da copa

Cada pessoa entra, escolhe os sabores e a quantidade de caixas. Quem tem o perfil
de **comprador** vê tudo somado numa lista só, com o quanto cada um deve.

Sem banco de dados e sem dependências: só Node.js 18 ou mais novo. Tudo fica em
arquivos JSON dentro da pasta `dados/`.

> **Este projeto precisa de um servidor Node rodando.** Ele não funciona no
> GitHub Pages, que só serve arquivos estáticos e não executa `servidor.js` —
> sem ele não há login, pedido nem fechamento. Para deixar no ar pela internet,
> veja [Publicar na internet](#publicar-na-internet).

## Subir o sistema

```bash
node servidor.js
```

O terminal mostra os endereços de acesso, por exemplo:

```
  http://localhost:3000
  http://192.168.0.42:3000     <- é esse que você passa pro pessoal
```

Para trocar a porta: `PORTA=8080 node servidor.js`.

**O primeiro acesso criado vira o comprador.** Cadastre-se antes de divulgar o
link. Depois, na aba *Pessoas*, você pode promover outra pessoa, redefinir senhas
ou remover acessos.

## Se o pessoal não conseguir abrir pela rede

O firewall do seu Ubuntu costuma ser a causa:

```bash
sudo ufw allow 3000/tcp
```

Também vale confirmar que a máquina está na mesma rede e que o IP não mudou
(vale pedir um IP fixo pro pessoal de rede, ou usar o nome da máquina).

## Deixar rodando sempre (opcional)

Crie `/etc/systemd/system/espremedor.service`:

```ini
[Unit]
Description=Espremedor de Laranja - pedidos da copa
After=network.target

[Service]
ExecStart=/usr/bin/node /caminho/para/EspremedorLaranja/servidor.js
WorkingDirectory=/caminho/para/EspremedorLaranja
Restart=always
User=SEU_USUARIO

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now espremedor
```

## Publicar na internet

O GitHub Pages **não serve** para este projeto: ele publica arquivos estáticos e
não executa Node. A tela até abriria, mas toda chamada `/api/*` daria erro e nada
funcionaria. É preciso uma hospedagem que rode `node servidor.js`.

O repositório já vem com [`render.yaml`](render.yaml) pronto para o
[Render](https://render.com): *New* → *Blueprint* → aponte para este repositório.
Serve igual para Railway ou Fly.io — o que importa é rodar Node e ter disco.

### O disco é a parte que importa

Os pedidos ficam em arquivos JSON. Em hospedagem, o sistema de arquivos padrão é
**efêmero**: some a cada deploy. No plano free do Render some também toda vez que
o serviço acorda depois de 15 minutos parado — junto com todos os cadastros e a
rodada em andamento.

Por isso o `render.yaml` monta um disco e aponta a variável `DIR_DADOS` para ele:

```yaml
envVars:
  - key: DIR_DADOS
    value: /var/espremedor/dados
disk:
  mountPath: /var/espremedor
```

Disco persistente exige plano pago (~US$ 7/mês). Rodar no free sem disco
funciona para experimentar, mas **perde os dados** — não use para uma rodada de
verdade.

### Antes de divulgar o link

Num endereço público, qualquer pessoa que abrir o site pode criar um acesso pela
aba *Criar acesso* e ver o catálogo e a rodada. O cadastro é aberto: não há
convite nem código. Na rede interna isso não era problema; na internet, é.

O lado bom é que a hospedagem serve por HTTPS, então as senhas param de trafegar
em texto puro — o servidor já marca o cookie de sessão como `Secure` quando
percebe que veio por HTTPS.

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

Se a rede da empresa bloquear a saída para o site, a atualização automática
simplesmente falha e o catálogo atual continua valendo — a aba *Catálogo* mostra
o motivo. Nesse caso você pode rodar `node scripts/atualizar-produtos.js` em casa
e copiar o `dados/produtos.json`, ou ajustar preços direto na tela.

### Como a leitura é feita

O site é uma loja Magento e fica atrás de um CDN (Akamai) que barra robôs. Por
isso a leitura tenta dois caminhos, nesta ordem:

1. **A API GraphQL da própria loja** (`/graphql`) — é o caminho normal e o que
   funciona hoje. Vem tudo pronto: nome, preço cheio e com desconto, foto,
   estoque e as categorias de verdade do site. É daí que saem as imagens.
2. **A página `/sabores`**, como reserva, com as três leituras antigas (blocos de
   produto, dados estruturados e texto puro). Essa página é a mais protegida: o
   CDN compara até a "impressão digital" do TLS, que a do Node não imita, então
   ela costuma dar 403. Quando isso acontece, o programa tenta de novo pelo
   `curl` do sistema, que usa o TLS do próprio sistema operacional.

O `robots.txt` do site libera `/sabores` e `/media/catalog/product/*`, então a
leitura é permitida. A busca é leve: uma vez ao subir e a cada 12 horas, com
pausa entre as páginas.

Duas travas evitam que uma leitura ruim estrague o catálogo:

- se o CDN devolver a **página de verificação** (responde 200, mas só tem
  JavaScript), ela é recusada em vez de virar produto de mentira;
- se a leitura reconhecer **menos de 60%** do que já se conhecia, ninguém é
  marcado como *saiu do site* — o aviso de leitura incompleta aparece no lugar.

Se os dois caminhos falharem, a atualização é recusada e o catálogo continua
como estava.

### Fotos dos sabores

O site da Nescafé bloqueia leitura automática (proteção anti-robô — devolve
"site temporariamente indisponível" mesmo pedindo com um navegador de
verdade), então as fotos não vêm sozinhas pela sincronização. Pra cada sabor
ter foto, cole o link da imagem na aba **Catálogo**, coluna **Imagem**: abra o
sabor no site pelo navegador normal, copie o endereço da foto (botão direito →
*copiar endereço da imagem*) e cole ali. Fica salvo e aparece no lugar do
círculo colorido na tela de pedido. Se o link parar de funcionar depois, o
círculo volta a aparecer sozinho.

## O dia a dia

1. Você abre uma rodada e dá um nome a ela (*Fechamento* → *Rodada*). Dá para
   deixar um recado que aparece na tela de todo mundo, tipo "peça até sexta, 12h".
2. O pessoal entra, escolhe e envia. Cada um pode mudar o próprio pedido enquanto
   a rodada estiver aberta.
3. Você abre *Fechamento*, confere a lista somada, usa **Copiar lista** (sai
   pronta para colar no grupo do WhatsApp) ou **Baixar planilha** (CSV que abre no
   Excel com `;` e vírgula decimal).
4. Compra no site e clica em **Fechar rodada e começar outra**. A rodada antiga
   vira histórico, com a planilha guardada.

## Os arquivos

```
servidor.js                  servidor HTTP e regras
render.yaml                  deploy na hospedagem (disco persistente)
lib/catalogo-nescafe.js      leitura do site da Nescafé
scripts/atualizar-produtos.js  atualização pelo terminal
publico/                     a tela (HTML, CSS e JavaScript)
dados-iniciais/produtos.json catálogo de partida
dados/                       criado no primeiro uso
  usuarios.json              nomes, perfis e senhas (scrypt, com sal)
  produtos.json              catálogo em uso
  rodadas.json               rodadas e pedidos
  sessoes.json               quem está logado
  sincronizacao.json         resultado da última leitura do site
```

Backup é copiar a pasta `dados/`. Para zerar tudo, apague a pasta e suba de novo.

A pasta `dados/` está no `.gitignore` **de propósito**: ela guarda nomes de
colegas, hashes de senha e sessões abertas. Não tire de lá.

## Sobre segurança

Isto foi feito para uma rede interna entre colegas. Rodando localmente o acesso é
por HTTP simples, sem criptografia no caminho: as senhas ficam guardadas com
scrypt e sal, mas viajam em texto puro dentro da rede. Combine com o pessoal para
não reaproveitar senha de outro sistema.

Publicando numa hospedagem com HTTPS esse problema do caminho some, mas aparece
outro: o cadastro é aberto a quem tiver o link. Veja
[Antes de divulgar o link](#antes-de-divulgar-o-link).
