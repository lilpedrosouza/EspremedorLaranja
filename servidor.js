'use strict';

/**
 * Espremedor de Laranja — pedidos de cápsulas.
 *
 * Servidor HTTP puro (só Node, sem framework) com os dados no Postgres/Supabase.
 * Suba com:  node servidor.js
 *
 * Precisa de DATABASE_URL. Veja .env.example e o README.
 */

require('./lib/ambiente').carregar();

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const catalogoNescafe = require('./lib/catalogo-nescafe');
const banco = require('./lib/banco');
const pix = require('./lib/pix');
const qrcode = require('qrcode');

// PORT vem primeiro: é o que a hospedagem define, e ela precisa ganhar de um
// PORTA que tenha sobrado do .env. Escutar numa porta diferente da que a
// Railway espera derruba o site inteiro com "Application not found".
const PORTA = Number(process.env.PORT || process.env.PORTA || 3000);
const DIR_PUBLICO = path.join(__dirname, 'publico');

const DURACAO_SESSAO = 30 * 24 * 60 * 60 * 1000; // 30 dias
const INTERVALO_SINCRONIA = 12 * 60 * 60 * 1000; // 12 horas

// Endereços do front que podem chamar esta API, separados por vírgula.
// Ex.: ORIGENS_PERMITIDAS=https://lilpedrosouza.github.io,http://localhost:5173
// Vazio = só o front servido por este mesmo servidor.
const ORIGENS = (process.env.ORIGENS_PERMITIDAS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function semAcento(texto) {
  return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function chaveLogin(nome) {
  return semAcento(nome).toLowerCase().replace(/\s+/g, ' ').trim();
}

function novoId() {
  return crypto.randomBytes(9).toString('hex');
}

function embaralharSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const resumo = crypto.scryptSync(senha, sal, 64).toString('hex');
  return `scrypt:${sal}:${resumo}`;
}

function senhaConfere(senha, guardada) {
  try {
    const [algoritmo, sal, resumo] = String(guardada).split(':');
    if (algoritmo !== 'scrypt') return false;
    const calculado = crypto.scryptSync(senha, sal, 64);
    const salvo = Buffer.from(resumo, 'hex');
    return calculado.length === salvo.length && crypto.timingSafeEqual(calculado, salvo);
  } catch {
    return false;
  }
}

function criarRodada(nome) {
  return {
    id: novoId(),
    nome: nome || `Rodada de ${new Date().toLocaleDateString('pt-BR')}`,
    observacao: ''
  };
}

/* ------------------------------------------------------------------ */
/* Sessões                                                             */
/* ------------------------------------------------------------------ */

/**
 * O token vem no cabeçalho Authorization, não em cookie: o front pode estar
 * num domínio diferente do da API (GitHub Pages x Railway), e navegador
 * nenhum guarda cookie de terceiros de forma confiável hoje.
 */
function tokenDaRequisicao(requisicao) {
  const bruto = requisicao.headers.authorization || '';
  const casa = bruto.match(/^Bearer\s+(.+)$/i);
  return casa ? casa[1].trim() : null;
}

async function usuarioDaRequisicao(requisicao) {
  const token = tokenDaRequisicao(requisicao);
  if (!token) return null;
  return banco.usuarioPorToken(token, DURACAO_SESSAO);
}

async function abrirSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await banco.abrirSessao(token, usuarioId);
  return token;
}

/* ------------------------------------------------------------------ */
/* Respostas                                                           */
/* ------------------------------------------------------------------ */

function aplicarCors(requisicao, resposta) {
  const origem = String(requisicao.headers.origin || '').replace(/\/$/, '');
  if (!origem || !ORIGENS.includes(origem)) return;
  resposta.setHeader('Access-Control-Allow-Origin', origem);
  resposta.setHeader('Vary', 'Origin');
  resposta.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  resposta.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Sem isto o front em outro domínio não lê o nome do arquivo da planilha.
  resposta.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  resposta.setHeader('Access-Control-Max-Age', '86400');
}

function responderJson(resposta, status, corpo) {
  const texto = JSON.stringify(corpo);
  resposta.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(texto)
  });
  resposta.end(texto);
}

function erro(resposta, status, mensagem) {
  responderJson(resposta, status, { erro: mensagem });
}

function lerCorpo(requisicao) {
  return new Promise((resolver, rejeitar) => {
    const pedacos = [];
    let tamanho = 0;
    requisicao.on('data', (pedaco) => {
      tamanho += pedaco.length;
      if (tamanho > 1_000_000) {
        rejeitar(new Error('corpo grande demais'));
        requisicao.destroy();
        return;
      }
      pedacos.push(pedaco);
    });
    requisicao.on('end', () => {
      const texto = Buffer.concat(pedacos).toString('utf8');
      if (!texto) return resolver({});
      try {
        resolver(JSON.parse(texto));
      } catch {
        rejeitar(new Error('JSON inválido'));
      }
    });
    requisicao.on('error', rejeitar);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function servirArquivo(resposta, caminhoUrl) {
  const relativo = decodeURIComponent(caminhoUrl.split('?')[0]);
  const alvo = path.join(DIR_PUBLICO, relativo === '/' ? 'index.html' : relativo);
  if (!alvo.startsWith(DIR_PUBLICO)) return erro(resposta, 403, 'Caminho não permitido.');
  fs.readFile(alvo, (falha, conteudo) => {
    if (falha) {
      resposta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      resposta.end('Página não encontrada.');
      return;
    }
    resposta.writeHead(200, {
      'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    resposta.end(conteudo);
  });
}

/* ------------------------------------------------------------------ */
/* Regras de negócio                                                   */
/* ------------------------------------------------------------------ */

function resumoDaRodada(pedidos) {
  const porProduto = new Map();
  const pessoas = [];

  for (const pedido of pedidos) {
    let totalPessoa = 0;
    let capsulasPessoa = 0;

    for (const item of pedido.itens) {
      const preco = Number(item.preco) || 0;
      const subtotal = preco * item.quantidade;
      totalPessoa += subtotal;
      capsulasPessoa += (Number(item.capsulas) || 0) * item.quantidade;

      const atual = porProduto.get(item.produtoId) || {
        produtoId: item.produtoId,
        nome: item.nome,
        categoria: item.categoria || '',
        capsulas: item.capsulas || null,
        preco,
        quantidade: 0,
        subtotal: 0,
        pessoas: []
      };
      atual.quantidade += item.quantidade;
      atual.subtotal += subtotal;
      atual.pessoas.push({ nome: pedido.nome, quantidade: item.quantidade });
      porProduto.set(item.produtoId, atual);
    }

    pessoas.push({
      usuarioId: pedido.usuarioId,
      nome: pedido.nome,
      atualizadoEm: pedido.atualizadoEm,
      itens: pedido.itens,
      total: totalPessoa,
      capsulas: capsulasPessoa,
      pagoEm: pedido.pagoEm,
      confirmadoEm: pedido.confirmadoEm
    });
  }

  const produtos = [...porProduto.values()].sort(
    (a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome, 'pt-BR')
  );
  pessoas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return {
    produtos,
    pessoas,
    totalGeral: produtos.reduce((soma, p) => soma + p.subtotal, 0),
    totalCaixas: produtos.reduce((soma, p) => soma + p.quantidade, 0),
    totalCapsulas: pessoas.reduce((soma, p) => soma + p.capsulas, 0),
    totalRecebido: pessoas.reduce((soma, p) => soma + (p.confirmadoEm ? p.total : 0), 0),
    totalAReceber: pessoas.reduce((soma, p) => soma + (p.confirmadoEm ? 0 : p.total), 0)
  };
}

function csvDaRodada(rodada, resumo) {
  const numero = (v) => (Number(v) || 0).toFixed(2).replace('.', ',');
  const escapar = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const linhas = [];

  linhas.push(escapar(`Lista de compra — ${rodada.nome}`));
  linhas.push('');
  linhas.push(['Produto', 'Categoria', 'Preço unitário', 'Caixas', 'Subtotal', 'Quem pediu'].map(escapar).join(';'));
  for (const p of resumo.produtos) {
    linhas.push(
      [
        p.nome,
        p.categoria,
        numero(p.preco),
        p.quantidade,
        numero(p.subtotal),
        p.pessoas.map((x) => `${x.nome} (${x.quantidade})`).join(', ')
      ]
        .map(escapar)
        .join(';')
    );
  }
  linhas.push(['TOTAL', '', '', resumo.totalCaixas, numero(resumo.totalGeral), ''].map(escapar).join(';'));
  linhas.push('');
  linhas.push(escapar('Quanto cada pessoa deve'));
  linhas.push(['Pessoa', 'Produto', 'Caixas', 'Subtotal'].map(escapar).join(';'));
  for (const pessoa of resumo.pessoas) {
    for (const item of pessoa.itens) {
      linhas.push(
        [pessoa.nome, item.nome, item.quantidade, numero((Number(item.preco) || 0) * item.quantidade)]
          .map(escapar)
          .join(';')
      );
    }
    linhas.push(
      [pessoa.nome, 'TOTAL DA PESSOA', pessoa.itens.reduce((s, i) => s + i.quantidade, 0), numero(pessoa.total)]
        .map(escapar)
        .join(';')
    );
  }

  return `\uFEFF${linhas.join('\r\n')}\r\n`;
}

/** Quanto a pessoa deve nesta rodada, a partir dos itens que ela pediu. */
function totalDoPedido(pedido) {
  if (!pedido) return 0;
  return pedido.itens.reduce((soma, item) => soma + (Number(item.preco) || 0) * item.quantidade, 0);
}

/**
 * Monta o Pix de quem vai pagar: o "copia e cola" já com o valor da pessoa e o
 * mesmo texto desenhado como QR. Sem chave configurada, devolve null — a tela
 * então explica o que fazer em vez de mostrar um QR quebrado.
 */
async function pixParaPagar(valor) {
  const chave = await banco.lerConfiguracao('pix_chave');
  if (!chave) return null;

  const nome = (await banco.lerConfiguracao('pix_nome')) || 'Comprador';
  const cidade = (await banco.lerConfiguracao('pix_cidade')) || 'BRASIL';
  const brcode = pix.montarBrCode({ chave, nome, cidade, valor });

  return {
    chave,
    nome,
    valor,
    brcode,
    qrcode: await qrcode.toString(brcode, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  };
}

async function rodarSincronizacao(disparadaPor) {
  try {
    const atual = await banco.listarProdutos();
    const resultado = await catalogoNescafe.sincronizar(atual);
    await banco.salvarCatalogo(resultado.catalogo);
    const registro = {
      ultima: new Date().toISOString(),
      situacao: 'ok',
      disparadaPor: disparadaPor || 'automática',
      encontrados: resultado.encontrados,
      novos: resultado.novos,
      atualizados: resultado.atualizados,
      sumiram: resultado.sumiram,
      estrategia: resultado.estrategia,
      leituraParcial: Boolean(resultado.leituraParcial),
      mensagem:
        `${resultado.encontrados} produtos lidos do site — ${resultado.novos} novos, ` +
        `${resultado.atualizados} atualizados.` +
        (resultado.leituraParcial
          ? ' A leitura veio incompleta, então nada foi marcado como "saiu do site".'
          : '')
    };
    await banco.gravarSincronizacao(registro);
    return registro;
  } catch (falha) {
    const bloqueadoPeloSite = /HTTP 403|verificação/i.test(falha.message);
    const mensagem = bloqueadoPeloSite
      ? 'A leitura automática não passou pela proteção contra robôs do site da Nescafé (não é um erro daqui). A leitura normal é feita pela API da loja; se ela também falhou, costuma ser passageiro — tente de novo mais tarde. Enquanto isso, ajuste preços, estoque e imagens direto na aba Catálogo: pedido, fechamento e planilha seguem funcionando.'
      : `Não deu para ler o site agora: ${falha.message}`;
    const registro = {
      ...(await banco.lerSincronizacao()),
      ultimaTentativa: new Date().toISOString(),
      situacao: 'falhou',
      bloqueadoPeloSite,
      disparadaPor: disparadaPor || 'automática',
      mensagem
    };
    await banco.gravarSincronizacao(registro).catch(() => {});
    return registro;
  }
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

async function tratarApi(requisicao, resposta, url) {
  const rota = url.pathname;
  const metodo = requisicao.method;
  const usuario = await usuarioDaRequisicao(requisicao);
  const eComprador = usuario && usuario.papel === 'comprador';

  const exigeLogin = () => {
    if (!usuario) {
      erro(resposta, 401, 'Entre com seu nome e senha para continuar.');
      return false;
    }
    return true;
  };
  const exigeComprador = () => {
    if (!exigeLogin()) return false;
    if (!eComprador) {
      erro(resposta, 403, 'Só quem tem o perfil de comprador pode fazer isso.');
      return false;
    }
    return true;
  };

  /* ---- cadastro e acesso ---- */

  if (rota === '/api/cadastro' && metodo === 'POST') {
    const corpo = await lerCorpo(requisicao);
    const nome = String(corpo.nome || '').trim();
    const senha = String(corpo.senha || '');
    if (nome.length < 2) return erro(resposta, 400, 'Escreva seu nome com pelo menos 2 letras.');
    if (senha.length < 4) return erro(resposta, 400, 'A senha precisa de pelo menos 4 caracteres.');

    const primeiro = (await banco.contarUsuarios()) === 0;
    const novo = await banco.criarUsuario({
      id: novoId(),
      nome,
      chave: chaveLogin(nome),
      senha: embaralharSenha(senha),
      papel: primeiro ? 'comprador' : 'colega'
    });
    if (!novo) return erro(resposta, 409, 'Esse nome já está cadastrado. Entre com ele ou use outro.');

    const token = await abrirSessao(novo.id);
    return responderJson(resposta, 201, {
      token,
      usuario: { id: novo.id, nome: novo.nome, papel: novo.papel }
    });
  }

  if (rota === '/api/entrar' && metodo === 'POST') {
    const corpo = await lerCorpo(requisicao);
    const encontrado = await banco.usuarioPorChave(chaveLogin(corpo.nome || ''));
    if (!encontrado || !senhaConfere(String(corpo.senha || ''), encontrado.senha)) {
      return erro(resposta, 401, 'Nome ou senha não conferem.');
    }
    const token = await abrirSessao(encontrado.id);
    return responderJson(resposta, 200, {
      token,
      usuario: { id: encontrado.id, nome: encontrado.nome, papel: encontrado.papel }
    });
  }

  if (rota === '/api/sair' && metodo === 'POST') {
    const token = tokenDaRequisicao(requisicao);
    if (token) await banco.fecharSessao(token);
    return responderJson(resposta, 200, { ok: true });
  }

  if (rota === '/api/sessao' && metodo === 'GET') {
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    return responderJson(resposta, 200, {
      usuario: usuario ? { id: usuario.id, nome: usuario.nome, papel: usuario.papel } : null,
      primeiroAcesso: (await banco.contarUsuarios()) === 0,
      rodada: aberta ? { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao } : null
    });
  }

  /* ---- catálogo ---- */

  if (rota === '/api/produtos' && metodo === 'GET') {
    if (!exigeLogin()) return;
    return responderJson(resposta, 200, {
      produtos: await banco.listarProdutos({ soAtivos: !eComprador }),
      sincronizacao: await banco.lerSincronizacao()
    });
  }

  if (rota === '/api/produtos/sincronizar' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const registro = await rodarSincronizacao(usuario.nome);
    return responderJson(resposta, registro.situacao === 'ok' ? 200 : 502, {
      sincronizacao: registro,
      produtos: await banco.listarProdutos()
    });
  }

  if (rota === '/api/produtos' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const nome = String(corpo.nome || '').trim();
    if (!nome) return erro(resposta, 400, 'Dê um nome ao produto.');
    const novo = await banco.criarProduto({
      id: catalogoNescafe.gerarId(nome) || novoId(),
      nome: nome.toUpperCase(),
      descricao: String(corpo.descricao || '').trim(),
      categoria: String(corpo.categoria || catalogoNescafe.categoriaPeloNome(nome)),
      intensidade: null,
      capsulas: Number(corpo.capsulas) || 10,
      preco: catalogoNescafe.paraNumero(corpo.preco) || 0,
      precoDe: null,
      disponivel: true,
      ativo: true,
      origem: 'manual',
      foraDoSite: false,
      imagem: null
    });
    if (!novo) return erro(resposta, 409, 'Já existe um produto com esse nome.');
    return responderJson(resposta, 201, novo);
  }

  const casaProduto = rota.match(/^\/api\/produtos\/([\w-]+)$/);
  if (casaProduto && (metodo === 'PATCH' || metodo === 'DELETE')) {
    if (!exigeComprador()) return;

    if (metodo === 'DELETE') {
      const foi = await banco.removerProduto(casaProduto[1]);
      if (!foi) return erro(resposta, 404, 'Produto não encontrado.');
      return responderJson(resposta, 200, { removido: casaProduto[1] });
    }

    const corpo = await lerCorpo(requisicao);
    const mudancas = {};
    if (corpo.ativo !== undefined) mudancas.ativo = Boolean(corpo.ativo);
    if (corpo.disponivel !== undefined) mudancas.disponivel = Boolean(corpo.disponivel);
    if (corpo.preco !== undefined) mudancas.preco = catalogoNescafe.paraNumero(corpo.preco) || 0;
    if (corpo.descricao !== undefined) mudancas.descricao = String(corpo.descricao).trim();
    if (corpo.categoria !== undefined) mudancas.categoria = String(corpo.categoria).trim();
    if (corpo.imagem !== undefined) {
      const imagem = String(corpo.imagem).trim();
      if (imagem && !/^https?:\/\//i.test(imagem)) {
        return erro(resposta, 400, 'A imagem precisa ser um link começando com http:// ou https://.');
      }
      mudancas.imagem = imagem ? imagem.slice(0, 500) : null;
    }
    const produto = await banco.atualizarProduto(casaProduto[1], mudancas);
    if (!produto) return erro(resposta, 404, 'Produto não encontrado.');
    return responderJson(resposta, 200, produto);
  }

  /* ---- meu pedido ---- */

  if (rota === '/api/meu-pedido' && metodo === 'GET') {
    if (!exigeLogin()) return;
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    const pedido = await banco.pedidoDe(aberta.id, usuario.id);
    return responderJson(resposta, 200, {
      rodada: { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao },
      pedido,
      pix: pedido ? await pixParaPagar(totalDoPedido(pedido)) : null
    });
  }

  if (rota === '/api/meu-pedido' && (metodo === 'PUT' || metodo === 'DELETE')) {
    if (!exigeLogin()) return;
    const aberta = await banco.garantirRodadaAberta(criarRodada);

    if (metodo === 'DELETE') {
      await banco.removerPedido(aberta.id, usuario.id);
      return responderJson(resposta, 200, { pedido: null });
    }

    const corpo = await lerCorpo(requisicao);
    const produtos = await banco.listarProdutos();
    const itens = [];
    for (const bruto of Array.isArray(corpo.itens) ? corpo.itens : []) {
      const produto = produtos.find((p) => p.id === bruto.produtoId);
      const quantidade = Math.max(0, Math.min(99, Math.trunc(Number(bruto.quantidade) || 0)));
      if (!produto || quantidade === 0) continue;
      itens.push({
        produtoId: produto.id,
        nome: produto.nome,
        categoria: produto.categoria,
        capsulas: produto.capsulas,
        preco: produto.preco,
        quantidade
      });
    }
    if (!itens.length) return erro(resposta, 400, 'Escolha pelo menos um sabor antes de enviar.');

    const pedido = await banco.salvarPedido(aberta.id, {
      usuarioId: usuario.id,
      nome: usuario.nome,
      itens,
      observacao: String(corpo.observacao || '').trim().slice(0, 300)
    });
    // O Pix vai junto: é aqui que a pessoa acaba de fechar o pedido e precisa pagar.
    return responderJson(resposta, 200, { pedido, pix: await pixParaPagar(totalDoPedido(pedido)) });
  }

  /* ---- pagamento ---- */

  if (rota === '/api/meu-pedido/pagamento' && metodo === 'POST') {
    if (!exigeLogin()) return;
    const corpo = await lerCorpo(requisicao);
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    const pedido = await banco.marcarPago(aberta.id, usuario.id, corpo.pago !== false);
    if (!pedido) return erro(resposta, 404, 'Envie seu pedido antes de marcar o pagamento.');
    return responderJson(resposta, 200, { pedido });
  }

  const casaPagamento = rota.match(/^\/api\/pedidos\/([\w-]+)\/pagamento$/);
  if (casaPagamento && metodo === 'PATCH') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    const pedido = await banco.confirmarPagamento(aberta.id, casaPagamento[1], corpo.confirmado !== false);
    if (!pedido) return erro(resposta, 404, 'Essa pessoa não tem pedido nesta rodada.');
    return responderJson(resposta, 200, { pedido });
  }

  /* ---- fechamento (comprador) ---- */

  if (rota === '/api/fechamento' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    return responderJson(resposta, 200, {
      rodada: { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao, criadaEm: aberta.criadaEm },
      resumo: resumoDaRodada(await banco.pedidosDaRodada(aberta.id))
    });
  }

  if (rota === '/api/fechamento.csv' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const pedida = url.searchParams.get('rodada');
    const alvo = pedida ? await banco.rodadaPorId(pedida) : await banco.garantirRodadaAberta(criarRodada);
    if (!alvo) return erro(resposta, 404, 'Rodada não encontrada.');
    const csv = csvDaRodada(alvo, resumoDaRodada(await banco.pedidosDaRodada(alvo.id)));
    resposta.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lista-${semAcento(alvo.nome).replace(/\W+/g, '-').toLowerCase()}.csv"`
    });
    return resposta.end(csv);
  }

  if (rota === '/api/rodadas' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const rodadas = await banco.listarRodadas();
    const lista = [];
    for (const r of rodadas) {
      const resumo = resumoDaRodada(await banco.pedidosDaRodada(r.id));
      lista.push({
        id: r.id,
        nome: r.nome,
        aberta: r.aberta,
        criadaEm: r.criadaEm,
        fechadaEm: r.fechadaEm,
        pessoas: resumo.pessoas.length,
        caixas: resumo.totalCaixas,
        total: resumo.totalGeral
      });
    }
    return responderJson(resposta, 200, { rodadas: lista });
  }

  const casaRodada = rota.match(/^\/api\/rodadas\/([\w-]+)$/);
  if (casaRodada && metodo === 'GET') {
    if (!exigeComprador()) return;
    const alvo = await banco.rodadaPorId(casaRodada[1]);
    if (!alvo) return erro(resposta, 404, 'Rodada não encontrada.');
    const pedidos = await banco.pedidosDaRodada(alvo.id);
    return responderJson(resposta, 200, {
      rodada: { ...alvo, pedidos },
      resumo: resumoDaRodada(pedidos)
    });
  }

  if (rota === '/api/rodadas/fechar' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    await banco.fecharRodada(aberta.id, usuario.nome, criarRodada(String(corpo.proximaRodada || '').trim()));
    return responderJson(resposta, 200, { fechada: aberta.id, nova: await banco.rodadaAberta() });
  }

  if (rota === '/api/rodadas/atual' && metodo === 'PATCH') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const aberta = await banco.garantirRodadaAberta(criarRodada);
    const mudancas = {};
    if (corpo.nome !== undefined) mudancas.nome = String(corpo.nome).trim().slice(0, 80) || aberta.nome;
    if (corpo.observacao !== undefined) mudancas.observacao = String(corpo.observacao).trim().slice(0, 200);
    const rodada = await banco.atualizarRodada(aberta.id, mudancas);
    return responderJson(resposta, 200, {
      rodada: { id: rodada.id, nome: rodada.nome, observacao: rodada.observacao }
    });
  }

  /* ---- pessoas ---- */

  if (rota === '/api/usuarios' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const usuarios = await banco.listarUsuarios();
    return responderJson(resposta, 200, {
      usuarios: usuarios.map((u) => ({ id: u.id, nome: u.nome, papel: u.papel, criadoEm: u.criadoEm }))
    });
  }

  const casaUsuario = rota.match(/^\/api\/usuarios\/([\w-]+)$/);
  if (casaUsuario && (metodo === 'PATCH' || metodo === 'DELETE')) {
    if (!exigeComprador()) return;
    const alvo = await banco.usuarioPorId(casaUsuario[1]);
    if (!alvo) return erro(resposta, 404, 'Pessoa não encontrada.');

    if (metodo === 'DELETE') {
      if (alvo.id === usuario.id) return erro(resposta, 400, 'Você não pode remover o próprio acesso.');
      await banco.removerUsuario(alvo.id);
      return responderJson(resposta, 200, { removido: alvo.id });
    }

    const corpo = await lerCorpo(requisicao);
    let atualizado = alvo;
    if (corpo.papel === 'comprador' || corpo.papel === 'colega') {
      if (corpo.papel === 'colega' && alvo.papel === 'comprador' && (await banco.contarCompradores()) === 1) {
        return erro(resposta, 400, 'Deixe pelo menos uma pessoa como comprador.');
      }
      atualizado = await banco.trocarPapel(alvo.id, corpo.papel);
    }
    if (corpo.novaSenha) {
      if (String(corpo.novaSenha).length < 4) return erro(resposta, 400, 'A senha precisa de pelo menos 4 caracteres.');
      atualizado = await banco.trocarSenha(alvo.id, embaralharSenha(String(corpo.novaSenha)));
    }
    return responderJson(resposta, 200, {
      usuario: { id: atualizado.id, nome: atualizado.nome, papel: atualizado.papel }
    });
  }

  if (rota === '/api/minha-senha' && metodo === 'POST') {
    if (!exigeLogin()) return;
    const corpo = await lerCorpo(requisicao);
    if (String(corpo.nova || '').length < 4) return erro(resposta, 400, 'A nova senha precisa de pelo menos 4 caracteres.');
    if (!senhaConfere(String(corpo.atual || ''), usuario.senha)) {
      return erro(resposta, 401, 'A senha atual não confere.');
    }
    await banco.trocarSenha(usuario.id, embaralharSenha(String(corpo.nova)));
    return responderJson(resposta, 200, { ok: true });
  }

  return erro(resposta, 404, 'Rota não encontrada.');
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

const servidor = http.createServer((requisicao, resposta) => {
  const url = new URL(requisicao.url, `http://${requisicao.headers.host || 'localhost'}`);
  aplicarCors(requisicao, resposta);

  if (requisicao.method === 'OPTIONS') {
    resposta.writeHead(204);
    return resposta.end();
  }

  if (url.pathname.startsWith('/api/')) {
    tratarApi(requisicao, resposta, url).catch((falha) => {
      console.error('[erro]', falha);
      if (!resposta.headersSent) erro(resposta, 500, `Algo quebrou no servidor: ${falha.message}`);
    });
    return;
  }
  servirArquivo(resposta, url.pathname);
});

(async () => {
  try {
    await banco.iniciar(criarRodada);
  } catch (falha) {
    console.error('\n  Não deu para preparar o banco:', falha.message);
    console.error('  Confira a DATABASE_URL (host, senha e o sufixo ?sslmode=require).\n');
    process.exit(1);
  }

  banco.limparSessoesVencidas(DURACAO_SESSAO).catch(() => {});

  servidor.listen(PORTA, '0.0.0.0', () => {
    const enderecos = ['localhost'];
    for (const grupo of Object.values(os.networkInterfaces())) {
      for (const rede of grupo || []) {
        if (rede.family === 'IPv4' && !rede.internal) enderecos.push(rede.address);
      }
    }
    console.log('\n  Espremedor de Laranja');
    console.log('  --------------------------------------');
    for (const endereco of enderecos) console.log(`  http://${endereco}:${PORTA}`);
    console.log(`\n  Banco: Postgres${ORIGENS.length ? `\n  Front liberado de: ${ORIGENS.join(', ')}` : ''}`);
    console.log('  Pare com Ctrl+C.\n');

    if (process.env.SEM_SINCRONIA === '1') return;
    rodarSincronizacao('início do servidor').then((r) => console.log(`  [catálogo] ${r.mensagem}`));
    setInterval(() => {
      rodarSincronizacao('automática').then((r) => console.log(`  [catálogo] ${r.mensagem}`));
    }, INTERVALO_SINCRONIA).unref();
  });
})();

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    servidor.close(() => banco.encerrar().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
