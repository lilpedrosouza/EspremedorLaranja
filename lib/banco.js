'use strict';

/**
 * Acesso ao Postgres (Supabase).
 *
 * Este arquivo é o único lugar que fala SQL. O resto do programa continua
 * trabalhando com os mesmos objetos de antes ({ precoDe, foraDoSite, ... }),
 * então as funções aqui traduzem coluna_do_banco <-> campoDoJavaScript.
 *
 * Precisa da variável DATABASE_URL. No Supabase ela está em
 * Project Settings → Database → Connection string → URI.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const URL_BANCO = process.env.DATABASE_URL || '';
const DIR_SEMENTE = path.join(__dirname, '..', 'dados-iniciais');
const ARQ_SCHEMA = path.join(__dirname, '..', 'banco', 'schema.sql');

if (!URL_BANCO) {
  console.error('\n  Falta a variável DATABASE_URL — sem ela não há onde guardar os pedidos.');
  console.error('  Pegue em: Supabase → Project Settings → Database → Connection string → URI');
  console.error('  Local:  crie um arquivo .env  (veja .env.example)\n');
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(URL_BANCO);

const pool = new Pool({
  connectionString: URL_BANCO,
  // O Supabase exige TLS. O certificado é de uma CA própria, que o Node não traz
  // na lista padrão — por isso a verificação de cadeia fica desligada aqui.
  ssl: local ? false : { rejectUnauthorized: false },
  max: Number(process.env.BANCO_MAX_CONEXOES || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000
});

pool.on('error', (falha) => console.error('[banco] conexão ociosa caiu:', falha.message));

function consulta(texto, valores) {
  return pool.query(texto, valores);
}

async function uma(texto, valores) {
  const { rows } = await pool.query(texto, valores);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ */
/* Tradução banco <-> aplicação                                        */
/* ------------------------------------------------------------------ */

const iso = (valor) => (valor instanceof Date ? valor.toISOString() : valor || null);
const numero = (valor) => (valor === null || valor === undefined ? null : Number(valor));

function paraProduto(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    descricao: linha.descricao,
    categoria: linha.categoria,
    intensidade: linha.intensidade,
    capsulas: linha.capsulas,
    preco: numero(linha.preco) || 0,
    precoDe: numero(linha.preco_de),
    disponivel: linha.disponivel,
    ativo: linha.ativo,
    origem: linha.origem,
    foraDoSite: linha.fora_do_site,
    imagem: linha.imagem,
    url: linha.url
  };
}

function paraRodada(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    observacao: linha.observacao,
    aberta: linha.aberta,
    criadaEm: iso(linha.criada_em),
    fechadaEm: iso(linha.fechada_em),
    fechadaPor: linha.fechada_por,
    rastreio: linha.rastreio,
    rastreioEm: iso(linha.rastreio_em)
  };
}

function paraPedido(linha) {
  if (!linha) return null;
  return {
    usuarioId: linha.usuario_id,
    nome: linha.nome,
    itens: linha.itens || [],
    observacao: linha.observacao,
    atualizadoEm: iso(linha.atualizado_em),
    pagoEm: iso(linha.pago_em),
    confirmadoEm: iso(linha.confirmado_em)
  };
}

function paraUsuario(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    chave: linha.chave,
    senha: linha.senha,
    papel: linha.papel,
    criadoEm: iso(linha.criado_em)
  };
}

/* ------------------------------------------------------------------ */
/* Partida                                                             */
/* ------------------------------------------------------------------ */

async function iniciar(criarRodadaPadrao) {
  await consulta(fs.readFileSync(ARQ_SCHEMA, 'utf8'));

  const { rows } = await consulta('select count(*)::int as total from produtos');
  if (rows[0].total === 0) {
    const semente = JSON.parse(fs.readFileSync(path.join(DIR_SEMENTE, 'produtos.json'), 'utf8'));
    await salvarCatalogo(semente.map((p) => ({ ...p, origem: 'site', foraDoSite: false })));
    console.log(`  [banco] catálogo de partida gravado: ${semente.length} itens.`);
  }

  await garantirRodadaAberta(criarRodadaPadrao);
}

/* ------------------------------------------------------------------ */
/* Usuários                                                            */
/* ------------------------------------------------------------------ */

async function contarUsuarios() {
  const linha = await uma('select count(*)::int as total from usuarios');
  return linha.total;
}

async function listarUsuarios() {
  const { rows } = await consulta('select * from usuarios order by nome');
  return rows.map(paraUsuario);
}

async function usuarioPorChave(chave) {
  return paraUsuario(await uma('select * from usuarios where chave = $1', [chave]));
}

async function usuarioPorId(id) {
  return paraUsuario(await uma('select * from usuarios where id = $1', [id]));
}

/** Devolve null quando o nome já está em uso — é assim que a rota responde 409. */
async function criarUsuario(usuario) {
  const linha = await uma(
    `insert into usuarios (id, nome, chave, senha, papel)
     values ($1, $2, $3, $4, $5)
     on conflict (chave) do nothing
     returning *`,
    [usuario.id, usuario.nome, usuario.chave, usuario.senha, usuario.papel]
  );
  // Sob conflito o Postgres não devolve linha nenhuma. A conferência do id é
  // rede de segurança: se algum dia vier a linha que já existia, não podemos
  // tratar como cadastro novo — seria entregar a conta de outra pessoa.
  if (!linha || linha.id !== usuario.id) return null;
  return paraUsuario(linha);
}

async function trocarPapel(id, papel) {
  return paraUsuario(await uma('update usuarios set papel = $2 where id = $1 returning *', [id, papel]));
}

async function trocarSenha(id, senha) {
  return paraUsuario(await uma('update usuarios set senha = $2 where id = $1 returning *', [id, senha]));
}

async function removerUsuario(id) {
  const linha = await uma('delete from usuarios where id = $1 returning id', [id]);
  return Boolean(linha);
}

async function contarCompradores() {
  const linha = await uma("select count(*)::int as total from usuarios where papel = 'comprador'");
  return linha.total;
}

/* ------------------------------------------------------------------ */
/* Sessões                                                             */
/* ------------------------------------------------------------------ */

async function abrirSessao(token, usuarioId) {
  await consulta('insert into sessoes (token, usuario_id) values ($1, $2)', [token, usuarioId]);
}

// O corte de validade é calculado aqui e vai como timestamp pronto. Fazer a
// conta em SQL exigiria multiplicar número por interval, cuja resolução de tipo
// varia — e uma sessão que não valida deixa todo mundo de fora.
function corteDeValidade(duracaoMs) {
  return new Date(Date.now() - duracaoMs);
}

async function usuarioPorToken(token, duracaoMs) {
  const linha = await uma(
    `select u.* from sessoes s
       join usuarios u on u.id = s.usuario_id
      where s.token = $1 and s.criada_em > $2`,
    [token, corteDeValidade(duracaoMs)]
  );
  return paraUsuario(linha);
}

async function fecharSessao(token) {
  await consulta('delete from sessoes where token = $1', [token]);
}

async function limparSessoesVencidas(duracaoMs) {
  await consulta('delete from sessoes where criada_em < $1', [corteDeValidade(duracaoMs)]);
}

/* ------------------------------------------------------------------ */
/* Produtos                                                            */
/* ------------------------------------------------------------------ */

async function listarProdutos({ soAtivos = false } = {}) {
  const { rows } = await consulta(
    `select * from produtos ${soAtivos ? 'where ativo' : ''} order by nome`
  );
  return rows.map(paraProduto);
}

async function produtoPorId(id) {
  return paraProduto(await uma('select * from produtos where id = $1', [id]));
}

/** Devolve null quando já existe produto com esse id (o id vem do nome). */
async function criarProduto(produto) {
  if (await produtoPorId(produto.id)) return null;
  const linha = await uma(
    `insert into produtos
       (id, nome, descricao, categoria, intensidade, capsulas, preco, preco_de,
        disponivel, ativo, origem, fora_do_site, imagem, url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (id) do nothing
     returning *`,
    valoresDoProduto(produto)
  );
  return paraProduto(linha);
}

function valoresDoProduto(p) {
  return [
    p.id,
    p.nome,
    p.descricao || '',
    p.categoria || 'Outros',
    p.intensidade ?? null,
    p.capsulas ?? 10,
    p.preco ?? 0,
    p.precoDe ?? null,
    p.disponivel !== false,
    p.ativo !== false,
    p.origem || 'site',
    Boolean(p.foraDoSite),
    p.imagem || null,
    p.url || null
  ];
}

/**
 * Guarda o preço de vários produtos de uma vez, cada um só se for diferente do
 * último guardado dele. O `left join lateral` busca esse último preço; o `where`
 * descarta quem não mudou. Assim a leitura do site, que roda de 12 em 12 horas e
 * quase sempre traz o mesmo preço, não deixa linha repetida na tabela.
 *
 * **Uma instrução para o lote inteiro, e não uma por produto.** A diferença não é
 * estética: medido contra o Supabase, 196 produtos um a um levam 28 segundos
 * (cada ida ao banco custa ~144 ms), e numa instrução só, 149 ms. Como isto roda
 * dentro da transação que grava o catálogo, os 28 segundos ficavam segurando uma
 * conexão do pool e martelando o banco — tempo em que `/api/sessao` não respondia
 * e a Railway, que usa essa rota como healthcheck, derrubava o contêiner.
 *
 * O `executor` existe para a gravação poder entrar na mesma transação do
 * catálogo. Sem ele, vale o pool.
 *
 * Os casts (`::text`, `::numeric`) são obrigatórios: o VALUES está dentro de uma
 * subconsulta, e não como alvo direto do insert, então o Postgres não tem de onde
 * inferir o tipo dos parâmetros.
 */
async function registrarPrecos(produtos, executor = pool) {
  // Produto sem preço (leitura que não achou o valor) não vira ponto no
  // histórico: entraria como R$ 0,00 e puxaria a média de todo mundo para baixo.
  const comPreco = produtos.filter((produto) => Number(produto.preco) > 0);
  if (!comPreco.length) return;

  const valores = [];
  const marcadores = comPreco.map((produto) => {
    valores.push(produto.id, Number(produto.preco));
    return `($${valores.length - 1}::text, $${valores.length}::numeric)`;
  });

  await executor.query(
    `insert into precos (produto_id, preco)
     select novo.produto_id, novo.preco
       from (values ${marcadores.join(',')}) as novo(produto_id, preco)
       left join lateral (
         select p.preco
           from precos p
          where p.produto_id = novo.produto_id
          order by p.registrado_em desc, p.id desc
          limit 1
       ) ultimo on true
      where ultimo.preco is null or ultimo.preco <> novo.preco`,
    valores
  );
}

/** Um produto só — o caso do preço corrigido na mão na aba Catálogo. */
async function registrarPreco(produtoId, preco, executor = pool) {
  await registrarPrecos([{ id: produtoId, preco }], executor);
}

/**
 * Tira pontos seguidos com o mesmo preço.
 *
 * A gravação já recusa repetir o último preço, mas duas sincronizações ao mesmo
 * tempo furam a trava: um deploy pegando o contêiner anterior ainda no ar, ou o
 * botão "Atualizar do site agora" no meio da leitura automática. As duas leem o
 * último preço antes de qualquer uma gravar, nenhuma vê a linha da outra (que
 * ainda não commitou) e as duas gravam.
 *
 * O ponto repetido não mexe na média, porque o preço é o mesmo — mas contaria
 * como "mais uma mudança de preço" na hora de decidir se já existe amostra para
 * apontar o melhor dia da semana. Limpar na leitura resolve para as linhas que
 * já entraram e para as que ainda possam entrar.
 */
function semRepetidosSeguidos(pontos) {
  return pontos.filter((ponto, indice) => indice === 0 || ponto.preco !== pontos[indice - 1].preco);
}

/** Pontos de preço de um produto, do mais antigo para o mais novo. */
async function historicoDoProduto(produtoId, desde) {
  const { rows } = await consulta(
    `select preco, registrado_em from precos
      where produto_id = $1 and registrado_em >= $2
      order by registrado_em, id`,
    [produtoId, desde]
  );
  return semRepetidosSeguidos(rows.map((linha) => ({ preco: Number(linha.preco), em: iso(linha.registrado_em) })));
}

/**
 * Os pontos de todos os produtos na janela, já agrupados por produto.
 *
 * Vem de uma consulta só porque a tela de sabores precisa do selo "abaixo da
 * média" em cada cartão — uma consulta por produto seria uma ida ao banco por
 * sabor a cada carregamento da tela.
 */
async function historicoDeTodos(desde) {
  const { rows } = await consulta(
    `select produto_id, preco, registrado_em from precos
      where registrado_em >= $1
      order by produto_id, registrado_em, id`,
    [desde]
  );
  const porProduto = new Map();
  for (const linha of rows) {
    if (!porProduto.has(linha.produto_id)) porProduto.set(linha.produto_id, []);
    porProduto.get(linha.produto_id).push({ preco: Number(linha.preco), em: iso(linha.registrado_em) });
  }
  for (const [id, pontos] of porProduto) porProduto.set(id, semRepetidosSeguidos(pontos));
  return porProduto;
}

/** Só mexe nos campos presentes em `mudancas` — o resto fica como está. */
async function atualizarProduto(id, mudancas) {
  const colunas = {
    ativo: 'ativo',
    disponivel: 'disponivel',
    preco: 'preco',
    descricao: 'descricao',
    categoria: 'categoria',
    imagem: 'imagem'
  };
  const partes = [];
  const valores = [id];
  for (const [campo, coluna] of Object.entries(colunas)) {
    if (mudancas[campo] === undefined) continue;
    valores.push(mudancas[campo]);
    partes.push(`${coluna} = $${valores.length}`);
  }
  if (!partes.length) return produtoPorId(id);
  const produto = paraProduto(
    await uma(`update produtos set ${partes.join(', ')} where id = $1 returning *`, valores)
  );
  // Preço corrigido na mão pelo comprador também é história de preço — senão o
  // que ele digita fica de fora da média e o selo do cartão passa a mentir.
  if (produto && mudancas.preco !== undefined) await registrarPreco(produto.id, produto.preco);
  return produto;
}

async function removerProduto(id) {
  const linha = await uma('delete from produtos where id = $1 returning id', [id]);
  return Boolean(linha);
}

/**
 * Quantos produtos por instrução. O Postgres aceita 65535 parâmetros por
 * consulta e cada produto ocupa 14, então 200 por vez deixa folga de sobra e
 * mantém a transação em poucas idas ao banco.
 */
const PRODUTOS_POR_LOTE = 200;

/** Grava um lote de produtos numa instrução só. Ver o comentário de salvarCatalogo. */
async function gravarLoteDeProdutos(lote, executor) {
  const valores = [];
  const marcadores = lote.map((produto) => {
    const linha = valoresDoProduto(produto);
    const posicoes = linha.map((_, indice) => `$${valores.length + indice + 1}`);
    valores.push(...linha);
    return `(${posicoes.join(',')})`;
  });

  await executor.query(
    `insert into produtos
       (id, nome, descricao, categoria, intensidade, capsulas, preco, preco_de,
        disponivel, ativo, origem, fora_do_site, imagem, url)
     values ${marcadores.join(',')}
     on conflict (id) do update set
       nome = excluded.nome,
       descricao = excluded.descricao,
       categoria = excluded.categoria,
       intensidade = excluded.intensidade,
       capsulas = excluded.capsulas,
       preco = excluded.preco,
       preco_de = excluded.preco_de,
       disponivel = excluded.disponivel,
       ativo = excluded.ativo,
       origem = excluded.origem,
       fora_do_site = excluded.fora_do_site,
       imagem = excluded.imagem,
       -- O link só é substituído quando vem um novo, para não zerar o que
       -- já existe numa leitura que não traz endereço (a de reserva).
       url = coalesce(excluded.url, produtos.url)`,
    valores
  );
}

/**
 * Grava o catálogo inteiro que veio da sincronização, numa transação só.
 * Produtos que já existem são atualizados; os novos entram.
 *
 * Grava em lotes, e não produto a produto, porque esta transação segura uma
 * conexão do pool do começo ao fim. Com ~200 produtos, o jeito antigo eram ~400
 * idas ao banco a ~144 ms cada: quase um minuto de transação aberta a cada boot,
 * em que `/api/sessao` — o healthcheck da Railway — não respondia a tempo e o
 * contêiner era reiniciado, até esgotar as tentativas e o site sair do ar.
 */
async function salvarCatalogo(catalogo) {
  // Dois produtos com o mesmo id fariam o upsert gravar um por cima do outro e
  // o catálogo encolheria em silêncio. Se acontecer, é defeito de quem montou a
  // lista — avisa alto em vez de sumir com a diferença.
  const porId = new Map();
  for (const produto of catalogo) porId.set(produto.id, produto);
  if (porId.size !== catalogo.length) {
    console.warn(
      `[banco] ${catalogo.length - porId.size} produto(s) com id repetido na gravação do catálogo — mantido o último de cada.`
    );
  }
  catalogo = [...porId.values()];

  const conexao = await pool.connect();
  try {
    await conexao.query('begin');
    for (let inicio = 0; inicio < catalogo.length; inicio += PRODUTOS_POR_LOTE) {
      const lote = catalogo.slice(inicio, inicio + PRODUTOS_POR_LOTE);
      await gravarLoteDeProdutos(lote, conexao);
      // Na mesma transação: se a gravação do catálogo voltar atrás, o histórico
      // não pode ficar com um preço que nunca chegou a valer.
      await registrarPrecos(lote, conexao);
    }
    await conexao.query('commit');
  } catch (falha) {
    await conexao.query('rollback');
    throw falha;
  } finally {
    conexao.release();
  }
}

/* ------------------------------------------------------------------ */
/* Rodadas                                                             */
/* ------------------------------------------------------------------ */

async function rodadaAberta() {
  return paraRodada(await uma('select * from rodadas where aberta limit 1'));
}

async function garantirRodadaAberta(nova) {
  const atual = await rodadaAberta();
  if (atual) return atual;
  const r = nova();
  // O índice único de rodada aberta faz o "do nothing" valer: se outra
  // requisição criou a rodada primeiro, esta desiste e lê a que ficou.
  await consulta(
    `insert into rodadas (id, nome, observacao, aberta) values ($1, $2, $3, true)
     on conflict do nothing`,
    [r.id, r.nome, r.observacao || '']
  );
  return rodadaAberta();
}

async function listarRodadas() {
  const { rows } = await consulta('select * from rodadas order by criada_em desc');
  return rows.map(paraRodada);
}

async function rodadaPorId(id) {
  return paraRodada(await uma('select * from rodadas where id = $1', [id]));
}

async function atualizarRodada(id, mudancas) {
  const partes = [];
  const valores = [id];
  for (const campo of ['nome', 'observacao']) {
    if (mudancas[campo] === undefined) continue;
    valores.push(mudancas[campo]);
    partes.push(`${campo} = $${valores.length}`);
  }
  if (!partes.length) return rodadaPorId(id);
  return paraRodada(await uma(`update rodadas set ${partes.join(', ')} where id = $1 returning *`, valores));
}

/**
 * Grava (ou tira, com null) o código de rastreio da entrega da rodada.
 *
 * A data é calculada aqui e os dois parâmetros vão com o tipo escrito. Fazer a
 * data por `case when $2 is null` reaproveitava o mesmo parâmetro num contexto
 * que não diz tipo nenhum, e o Postgres recusava com "could not determine data
 * type of parameter $2".
 */
async function gravarRastreio(id, codigo) {
  const quando = codigo ? new Date() : null;
  return paraRodada(
    await uma(
      `update rodadas
          set rastreio = $2::text,
              rastreio_em = $3::timestamptz
        where id = $1
      returning *`,
      [id, codigo || null, quando]
    )
  );
}

async function fecharRodada(id, quem, proxima) {
  const conexao = await pool.connect();
  try {
    await conexao.query('begin');
    await conexao.query(
      'update rodadas set aberta = false, fechada_em = now(), fechada_por = $2 where id = $1',
      [id, quem]
    );
    await conexao.query('insert into rodadas (id, nome, observacao, aberta) values ($1, $2, $3, true)', [
      proxima.id,
      proxima.nome,
      proxima.observacao || ''
    ]);
    await conexao.query('commit');
  } catch (falha) {
    await conexao.query('rollback');
    throw falha;
  } finally {
    conexao.release();
  }
}

/* ------------------------------------------------------------------ */
/* Pedidos                                                             */
/* ------------------------------------------------------------------ */

async function pedidosDaRodada(rodadaId) {
  const { rows } = await consulta('select * from pedidos where rodada_id = $1 order by nome', [rodadaId]);
  return rows.map(paraPedido);
}

async function pedidoDe(rodadaId, usuarioId) {
  return paraPedido(
    await uma('select * from pedidos where rodada_id = $1 and usuario_id = $2', [rodadaId, usuarioId])
  );
}

/** Upsert: não lê antes de gravar, então dois pedidos ao mesmo tempo não se atropelam. */
async function salvarPedido(rodadaId, pedido) {
  const linha = await uma(
    `insert into pedidos (rodada_id, usuario_id, nome, itens, observacao, atualizado_em)
     values ($1, $2, $3, $4::jsonb, $5, now())
     on conflict (rodada_id, usuario_id) do update set
       nome = excluded.nome,
       itens = excluded.itens,
       observacao = excluded.observacao,
       atualizado_em = now(),
       -- Mudou o pedido, mudou o valor: o "já paguei" de antes não vale mais.
       pago_em = null,
       confirmado_em = null
     returning *`,
    [rodadaId, pedido.usuarioId, pedido.nome, JSON.stringify(pedido.itens), pedido.observacao || '']
  );
  return paraPedido(linha);
}

async function removerPedido(rodadaId, usuarioId) {
  await consulta('delete from pedidos where rodada_id = $1 and usuario_id = $2', [rodadaId, usuarioId]);
}

/** Pedido acompanhado dos dados da rodada a que ele pertence. */
function paraPedidoComRodada(linha) {
  if (!linha) return null;
  return {
    ...paraPedido(linha),
    rodada: {
      id: linha.rodada_id,
      nome: linha.rodada_nome,
      aberta: linha.rodada_aberta,
      criadaEm: iso(linha.rodada_criada_em),
      fechadaEm: iso(linha.rodada_fechada_em)
    }
  };
}

/**
 * Tudo o que a pessoa já pediu, da rodada mais nova para a mais velha.
 *
 * Fechar a rodada não apaga a dívida de quem não pagou: é por aqui que ela
 * continua vendo o que pediu e conseguindo pagar depois do fechamento.
 */
async function pedidosDoUsuario(usuarioId) {
  const { rows } = await consulta(
    `select p.*, r.nome as rodada_nome, r.aberta as rodada_aberta,
            r.criada_em as rodada_criada_em, r.fechada_em as rodada_fechada_em
       from pedidos p
       join rodadas r on r.id = p.rodada_id
      where p.usuario_id = $1
      order by r.criada_em desc`,
    [usuarioId]
  );
  return rows.map(paraPedidoComRodada);
}

/** Quem ficou devendo em rodadas já fechadas — a lista de cobrança do comprador. */
async function pendencias() {
  const { rows } = await consulta(
    `select p.*, r.nome as rodada_nome, r.aberta as rodada_aberta,
            r.criada_em as rodada_criada_em, r.fechada_em as rodada_fechada_em
       from pedidos p
       join rodadas r on r.id = p.rodada_id
      where p.confirmado_em is null and not r.aberta
      order by r.criada_em desc, p.nome`
  );
  return rows.map(paraPedidoComRodada);
}

/** A pessoa avisando que fez o Pix. */
async function marcarPago(rodadaId, usuarioId, pago) {
  return paraPedido(
    await uma(
      `update pedidos set pago_em = ${pago ? 'now()' : 'null'}
        where rodada_id = $1 and usuario_id = $2 returning *`,
      [rodadaId, usuarioId]
    )
  );
}

/** O comprador confirmando que o dinheiro caiu. */
async function confirmarPagamento(rodadaId, usuarioId, confirmado) {
  return paraPedido(
    await uma(
      `update pedidos set confirmado_em = ${confirmado ? 'now()' : 'null'}
        where rodada_id = $1 and usuario_id = $2 returning *`,
      [rodadaId, usuarioId]
    )
  );
}

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

async function lerConfiguracao(chave) {
  const linha = await uma('select valor from configuracao where chave = $1', [chave]);
  return linha ? linha.valor : null;
}

async function gravarConfiguracao(chave, valor) {
  if (valor === null || valor === '') {
    await consulta('delete from configuracao where chave = $1', [chave]);
    return;
  }
  await consulta(
    `insert into configuracao (chave, valor) values ($1, $2)
     on conflict (chave) do update set valor = excluded.valor`,
    [chave, String(valor)]
  );
}

/* ------------------------------------------------------------------ */
/* Sincronização do catálogo                                           */
/* ------------------------------------------------------------------ */

async function lerSincronizacao() {
  const linha = await uma('select dados from sincronizacao where id = 1');
  return linha ? linha.dados : { ultima: null, situacao: 'nunca', mensagem: 'Ainda não sincronizado.' };
}

async function gravarSincronizacao(dados) {
  await consulta(
    `insert into sincronizacao (id, dados) values (1, $1::jsonb)
     on conflict (id) do update set dados = excluded.dados`,
    [JSON.stringify(dados)]
  );
}

async function encerrar() {
  await pool.end();
}

module.exports = {
  iniciar,
  encerrar,
  contarUsuarios,
  listarUsuarios,
  usuarioPorChave,
  usuarioPorId,
  criarUsuario,
  trocarPapel,
  trocarSenha,
  removerUsuario,
  contarCompradores,
  abrirSessao,
  usuarioPorToken,
  fecharSessao,
  limparSessoesVencidas,
  listarProdutos,
  produtoPorId,
  criarProduto,
  atualizarProduto,
  removerProduto,
  salvarCatalogo,
  registrarPreco,
  registrarPrecos,
  historicoDoProduto,
  historicoDeTodos,
  rodadaAberta,
  garantirRodadaAberta,
  listarRodadas,
  rodadaPorId,
  atualizarRodada,
  gravarRastreio,
  fecharRodada,
  pedidosDaRodada,
  pedidoDe,
  salvarPedido,
  removerPedido,
  pedidosDoUsuario,
  pendencias,
  marcarPago,
  confirmarPagamento,
  lerConfiguracao,
  gravarConfiguracao,
  lerSincronizacao,
  gravarSincronizacao
};
