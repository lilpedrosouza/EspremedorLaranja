'use strict';

/**
 * Espremedor de Laranja — pedidos da copa.
 * Servidor HTTP puro (só Node.js, sem dependências) com persistência em arquivos JSON.
 * Suba com:  node servidor.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const catalogoNescafe = require('./lib/catalogo-nescafe');

const PORTA = Number(process.env.PORTA || process.env.PORT || 3000);
const RAIZ = __dirname;
// Em hospedagem, aponte DIR_DADOS para um disco persistente — o disco padrão
// dessas plataformas é apagado a cada deploy, e com ele todos os pedidos.
const DIR_DADOS = process.env.DIR_DADOS || path.join(RAIZ, 'dados');
const DIR_PUBLICO = path.join(RAIZ, 'publico');
const DIR_SEMENTE = path.join(RAIZ, 'dados-iniciais');

const ARQ_USUARIOS = path.join(DIR_DADOS, 'usuarios.json');
const ARQ_PRODUTOS = path.join(DIR_DADOS, 'produtos.json');
const ARQ_RODADAS = path.join(DIR_DADOS, 'rodadas.json');
const ARQ_SESSOES = path.join(DIR_DADOS, 'sessoes.json');
const ARQ_SINCRONIZACAO = path.join(DIR_DADOS, 'sincronizacao.json');

const NOME_COOKIE = 'espremedor_sessao';
const DURACAO_SESSAO = 30 * 24 * 60 * 60 * 1000; // 30 dias
const INTERVALO_SINCRONIA = 12 * 60 * 60 * 1000; // 12 horas

/* ------------------------------------------------------------------ */
/* Arquivos                                                            */
/* ------------------------------------------------------------------ */

function garantirPastas() {
  fs.mkdirSync(DIR_DADOS, { recursive: true });
}

function ler(arquivo, padrao) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return padrao;
  }
}

function gravar(arquivo, valor) {
  const temporario = `${arquivo}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(valor, null, 2), 'utf8');
  fs.renameSync(temporario, arquivo);
}

function iniciarDados() {
  garantirPastas();
  if (!fs.existsSync(ARQ_USUARIOS)) gravar(ARQ_USUARIOS, []);
  if (!fs.existsSync(ARQ_SESSOES)) gravar(ARQ_SESSOES, {});
  if (!fs.existsSync(ARQ_PRODUTOS)) {
    const semente = ler(path.join(DIR_SEMENTE, 'produtos.json'), []);
    gravar(ARQ_PRODUTOS, semente.map((p) => ({ ...p, origem: 'site', foraDoSite: false })));
  }
  if (!fs.existsSync(ARQ_RODADAS)) {
    gravar(ARQ_RODADAS, [criarRodada('Primeira rodada')]);
  }
  if (!fs.existsSync(ARQ_SINCRONIZACAO)) {
    gravar(ARQ_SINCRONIZACAO, { ultima: null, situacao: 'nunca', mensagem: 'Ainda não sincronizado.' });
  }
}

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

function agora() {
  return new Date().toISOString();
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
    observacao: '',
    aberta: true,
    criadaEm: agora(),
    fechadaEm: null,
    pedidos: []
  };
}

function dinheiro(valor) {
  return (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/* ------------------------------------------------------------------ */
/* Sessões                                                             */
/* ------------------------------------------------------------------ */

function lerCookies(requisicao) {
  const bruto = requisicao.headers.cookie || '';
  const mapa = {};
  for (const parte of bruto.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    mapa[parte.slice(0, igual).trim()] = decodeURIComponent(parte.slice(igual + 1).trim());
  }
  return mapa;
}

function limparSessoesVencidas(sessoes) {
  const limite = Date.now() - DURACAO_SESSAO;
  let mudou = false;
  for (const [token, dados] of Object.entries(sessoes)) {
    if (!dados || new Date(dados.criadaEm).getTime() < limite) {
      delete sessoes[token];
      mudou = true;
    }
  }
  return mudou;
}

function usuarioDaRequisicao(requisicao) {
  const token = lerCookies(requisicao)[NOME_COOKIE];
  if (!token) return null;
  const sessoes = ler(ARQ_SESSOES, {});
  const sessao = sessoes[token];
  if (!sessao) return null;
  if (Date.now() - new Date(sessao.criadaEm).getTime() > DURACAO_SESSAO) {
    delete sessoes[token];
    gravar(ARQ_SESSOES, sessoes);
    return null;
  }
  const usuarios = ler(ARQ_USUARIOS, []);
  return usuarios.find((u) => u.id === sessao.usuarioId) || null;
}

// Atrás do proxy da hospedagem a conexão chega como HTTP, mas o navegador falou
// HTTPS. Sem o Secure aí, o cookie de sessão trafegaria em claro num site público.
function porHttps(requisicao) {
  return String(requisicao.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function abrirSessao(requisicao, resposta, usuarioId) {
  const token = crypto.randomBytes(24).toString('hex');
  const sessoes = ler(ARQ_SESSOES, {});
  limparSessoesVencidas(sessoes);
  sessoes[token] = { usuarioId, criadaEm: agora() };
  gravar(ARQ_SESSOES, sessoes);
  resposta.setHeader(
    'Set-Cookie',
    `${NOME_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACAO_SESSAO / 1000}` +
      (porHttps(requisicao) ? '; Secure' : '')
  );
}

function fecharSessao(requisicao, resposta) {
  const token = lerCookies(requisicao)[NOME_COOKIE];
  if (token) {
    const sessoes = ler(ARQ_SESSOES, {});
    delete sessoes[token];
    gravar(ARQ_SESSOES, sessoes);
  }
  resposta.setHeader(
    'Set-Cookie',
    `${NOME_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` + (porHttps(requisicao) ? '; Secure' : '')
  );
}

/* ------------------------------------------------------------------ */
/* Respostas                                                           */
/* ------------------------------------------------------------------ */

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

function rodadaAberta(rodadas) {
  return rodadas.find((r) => r.aberta) || null;
}

function garantirRodadaAberta() {
  const rodadas = ler(ARQ_RODADAS, []);
  if (!rodadaAberta(rodadas)) {
    rodadas.push(criarRodada());
    gravar(ARQ_RODADAS, rodadas);
  }
  return ler(ARQ_RODADAS, []);
}

function resumoDaRodada(rodada) {
  const porProduto = new Map();
  const pessoas = [];

  for (const pedido of rodada.pedidos) {
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
      capsulas: capsulasPessoa
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
    totalCapsulas: pessoas.reduce((soma, p) => soma + p.capsulas, 0)
  };
}

function csvDaRodada(rodada) {
  const resumo = resumoDaRodada(rodada);
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
    linhas.push([pessoa.nome, 'TOTAL DA PESSOA', pessoa.itens.reduce((s, i) => s + i.quantidade, 0), numero(pessoa.total)].map(escapar).join(';'));
  }

  return `\uFEFF${linhas.join('\r\n')}\r\n`;
}

async function rodarSincronizacao(disparadaPor) {
  const catalogo = ler(ARQ_PRODUTOS, []);
  try {
    const resultado = await catalogoNescafe.sincronizar(catalogo);
    gravar(ARQ_PRODUTOS, resultado.catalogo);
    const registro = {
      ultima: agora(),
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
    gravar(ARQ_SINCRONIZACAO, registro);
    return registro;
  } catch (falha) {
    const bloqueadoPeloSite = /HTTP 403|verificação/i.test(falha.message);
    const mensagem = bloqueadoPeloSite
      ? 'A leitura automática não passou pela proteção contra robôs do site da Nescafé (não é um erro daqui). A leitura normal é feita pela API da loja; se ela também falhou, costuma ser passageiro — tente de novo mais tarde. Enquanto isso, ajuste preços, estoque e imagens direto na aba Catálogo: pedido, fechamento e planilha seguem funcionando.'
      : `Não deu para ler o site agora: ${falha.message}`;
    const registro = {
      ...ler(ARQ_SINCRONIZACAO, {}),
      ultimaTentativa: agora(),
      situacao: 'falhou',
      bloqueadoPeloSite,
      disparadaPor: disparadaPor || 'automática',
      mensagem
    };
    gravar(ARQ_SINCRONIZACAO, registro);
    return registro;
  }
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

async function tratarApi(requisicao, resposta, url) {
  const rota = url.pathname;
  const metodo = requisicao.method;
  const usuario = usuarioDaRequisicao(requisicao);
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

    const usuarios = ler(ARQ_USUARIOS, []);
    if (usuarios.some((u) => u.chave === chaveLogin(nome))) {
      return erro(resposta, 409, 'Esse nome já está cadastrado. Entre com ele ou use outro.');
    }
    const novo = {
      id: novoId(),
      nome,
      chave: chaveLogin(nome),
      senha: embaralharSenha(senha),
      papel: usuarios.length === 0 ? 'comprador' : 'colega',
      criadoEm: agora()
    };
    usuarios.push(novo);
    gravar(ARQ_USUARIOS, usuarios);
    abrirSessao(requisicao, resposta, novo.id);
    return responderJson(resposta, 201, { id: novo.id, nome: novo.nome, papel: novo.papel });
  }

  if (rota === '/api/entrar' && metodo === 'POST') {
    const corpo = await lerCorpo(requisicao);
    const usuarios = ler(ARQ_USUARIOS, []);
    const encontrado = usuarios.find((u) => u.chave === chaveLogin(corpo.nome || ''));
    if (!encontrado || !senhaConfere(String(corpo.senha || ''), encontrado.senha)) {
      return erro(resposta, 401, 'Nome ou senha não conferem.');
    }
    abrirSessao(requisicao, resposta, encontrado.id);
    return responderJson(resposta, 200, { id: encontrado.id, nome: encontrado.nome, papel: encontrado.papel });
  }

  if (rota === '/api/sair' && metodo === 'POST') {
    fecharSessao(requisicao, resposta);
    return responderJson(resposta, 200, { ok: true });
  }

  if (rota === '/api/sessao' && metodo === 'GET') {
    const usuarios = ler(ARQ_USUARIOS, []);
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);
    return responderJson(resposta, 200, {
      usuario: usuario ? { id: usuario.id, nome: usuario.nome, papel: usuario.papel } : null,
      primeiroAcesso: usuarios.length === 0,
      rodada: aberta ? { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao } : null
    });
  }

  /* ---- catálogo ---- */

  if (rota === '/api/produtos' && metodo === 'GET') {
    if (!exigeLogin()) return;
    const produtos = ler(ARQ_PRODUTOS, []);
    const lista = eComprador ? produtos : produtos.filter((p) => p.ativo !== false);
    return responderJson(resposta, 200, {
      produtos: lista,
      sincronizacao: ler(ARQ_SINCRONIZACAO, {})
    });
  }

  if (rota === '/api/produtos/sincronizar' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const registro = await rodarSincronizacao(usuario.nome);
    return responderJson(resposta, registro.situacao === 'ok' ? 200 : 502, {
      sincronizacao: registro,
      produtos: ler(ARQ_PRODUTOS, [])
    });
  }

  if (rota === '/api/produtos' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const nome = String(corpo.nome || '').trim();
    if (!nome) return erro(resposta, 400, 'Dê um nome ao produto.');
    const produtos = ler(ARQ_PRODUTOS, []);
    const id = catalogoNescafe.gerarId(nome) || novoId();
    if (produtos.some((p) => p.id === id)) return erro(resposta, 409, 'Já existe um produto com esse nome.');
    const novo = {
      id,
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
    };
    produtos.push(novo);
    gravar(ARQ_PRODUTOS, produtos);
    return responderJson(resposta, 201, novo);
  }

  const casaProduto = rota.match(/^\/api\/produtos\/([\w-]+)$/);
  if (casaProduto && (metodo === 'PATCH' || metodo === 'DELETE')) {
    if (!exigeComprador()) return;
    const produtos = ler(ARQ_PRODUTOS, []);
    const indice = produtos.findIndex((p) => p.id === casaProduto[1]);
    if (indice === -1) return erro(resposta, 404, 'Produto não encontrado.');

    if (metodo === 'DELETE') {
      const [removido] = produtos.splice(indice, 1);
      gravar(ARQ_PRODUTOS, produtos);
      return responderJson(resposta, 200, { removido: removido.id });
    }

    const corpo = await lerCorpo(requisicao);
    const produto = produtos[indice];
    if (corpo.ativo !== undefined) produto.ativo = Boolean(corpo.ativo);
    if (corpo.disponivel !== undefined) produto.disponivel = Boolean(corpo.disponivel);
    if (corpo.preco !== undefined) produto.preco = catalogoNescafe.paraNumero(corpo.preco) || 0;
    if (corpo.descricao !== undefined) produto.descricao = String(corpo.descricao).trim();
    if (corpo.categoria !== undefined) produto.categoria = String(corpo.categoria).trim();
    if (corpo.imagem !== undefined) {
      const imagem = String(corpo.imagem).trim();
      if (imagem && !/^https?:\/\//i.test(imagem)) {
        return erro(resposta, 400, 'A imagem precisa ser um link começando com http:// ou https://.');
      }
      produto.imagem = imagem ? imagem.slice(0, 500) : null;
    }
    gravar(ARQ_PRODUTOS, produtos);
    return responderJson(resposta, 200, produto);
  }

  /* ---- meu pedido ---- */

  if (rota === '/api/meu-pedido' && metodo === 'GET') {
    if (!exigeLogin()) return;
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);
    const meu = aberta.pedidos.find((p) => p.usuarioId === usuario.id) || null;
    return responderJson(resposta, 200, { rodada: { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao }, pedido: meu });
  }

  if (rota === '/api/meu-pedido' && (metodo === 'PUT' || metodo === 'DELETE')) {
    if (!exigeLogin()) return;
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);

    if (metodo === 'DELETE') {
      aberta.pedidos = aberta.pedidos.filter((p) => p.usuarioId !== usuario.id);
      gravar(ARQ_RODADAS, rodadas);
      return responderJson(resposta, 200, { pedido: null });
    }

    const corpo = await lerCorpo(requisicao);
    const produtos = ler(ARQ_PRODUTOS, []);
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

    const pedido = {
      usuarioId: usuario.id,
      nome: usuario.nome,
      itens,
      observacao: String(corpo.observacao || '').trim().slice(0, 300),
      atualizadoEm: agora()
    };
    const indice = aberta.pedidos.findIndex((p) => p.usuarioId === usuario.id);
    if (indice === -1) aberta.pedidos.push(pedido);
    else aberta.pedidos[indice] = pedido;
    gravar(ARQ_RODADAS, rodadas);
    return responderJson(resposta, 200, { pedido });
  }

  /* ---- fechamento (comprador) ---- */

  if (rota === '/api/fechamento' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);
    return responderJson(resposta, 200, {
      rodada: { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao, criadaEm: aberta.criadaEm },
      resumo: resumoDaRodada(aberta)
    });
  }

  if (rota === '/api/fechamento.csv' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const rodadas = garantirRodadaAberta();
    const alvo = url.searchParams.get('rodada')
      ? rodadas.find((r) => r.id === url.searchParams.get('rodada'))
      : rodadaAberta(rodadas);
    if (!alvo) return erro(resposta, 404, 'Rodada não encontrada.');
    const csv = csvDaRodada(alvo);
    resposta.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lista-${semAcento(alvo.nome).replace(/\W+/g, '-').toLowerCase()}.csv"`
    });
    return resposta.end(csv);
  }

  if (rota === '/api/rodadas' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const rodadas = ler(ARQ_RODADAS, []);
    return responderJson(resposta, 200, {
      rodadas: rodadas
        .map((r) => {
          const resumo = resumoDaRodada(r);
          return {
            id: r.id,
            nome: r.nome,
            aberta: r.aberta,
            criadaEm: r.criadaEm,
            fechadaEm: r.fechadaEm,
            pessoas: resumo.pessoas.length,
            caixas: resumo.totalCaixas,
            total: resumo.totalGeral
          };
        })
        .reverse()
    });
  }

  const casaRodada = rota.match(/^\/api\/rodadas\/([\w-]+)$/);
  if (casaRodada && metodo === 'GET') {
    if (!exigeComprador()) return;
    const rodadas = ler(ARQ_RODADAS, []);
    const alvo = rodadas.find((r) => r.id === casaRodada[1]);
    if (!alvo) return erro(resposta, 404, 'Rodada não encontrada.');
    return responderJson(resposta, 200, { rodada: alvo, resumo: resumoDaRodada(alvo) });
  }

  if (rota === '/api/rodadas/fechar' && metodo === 'POST') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);
    aberta.aberta = false;
    aberta.fechadaEm = agora();
    aberta.fechadaPor = usuario.nome;
    rodadas.push(criarRodada(String(corpo.proximaRodada || '').trim()));
    gravar(ARQ_RODADAS, rodadas);
    return responderJson(resposta, 200, { fechada: aberta.id, nova: rodadaAberta(rodadas) });
  }

  if (rota === '/api/rodadas/atual' && metodo === 'PATCH') {
    if (!exigeComprador()) return;
    const corpo = await lerCorpo(requisicao);
    const rodadas = garantirRodadaAberta();
    const aberta = rodadaAberta(rodadas);
    if (corpo.nome !== undefined) aberta.nome = String(corpo.nome).trim().slice(0, 80) || aberta.nome;
    if (corpo.observacao !== undefined) aberta.observacao = String(corpo.observacao).trim().slice(0, 200);
    gravar(ARQ_RODADAS, rodadas);
    return responderJson(resposta, 200, { rodada: { id: aberta.id, nome: aberta.nome, observacao: aberta.observacao } });
  }

  /* ---- pessoas ---- */

  if (rota === '/api/usuarios' && metodo === 'GET') {
    if (!exigeComprador()) return;
    const usuarios = ler(ARQ_USUARIOS, []);
    return responderJson(resposta, 200, {
      usuarios: usuarios.map((u) => ({ id: u.id, nome: u.nome, papel: u.papel, criadoEm: u.criadoEm }))
    });
  }

  const casaUsuario = rota.match(/^\/api\/usuarios\/([\w-]+)$/);
  if (casaUsuario && (metodo === 'PATCH' || metodo === 'DELETE')) {
    if (!exigeComprador()) return;
    const usuarios = ler(ARQ_USUARIOS, []);
    const indice = usuarios.findIndex((u) => u.id === casaUsuario[1]);
    if (indice === -1) return erro(resposta, 404, 'Pessoa não encontrada.');

    if (metodo === 'DELETE') {
      if (usuarios[indice].id === usuario.id) return erro(resposta, 400, 'Você não pode remover o próprio acesso.');
      const [removido] = usuarios.splice(indice, 1);
      gravar(ARQ_USUARIOS, usuarios);
      return responderJson(resposta, 200, { removido: removido.id });
    }

    const corpo = await lerCorpo(requisicao);
    if (corpo.papel === 'comprador' || corpo.papel === 'colega') {
      const compradores = usuarios.filter((u) => u.papel === 'comprador');
      if (corpo.papel === 'colega' && compradores.length === 1 && compradores[0].id === usuarios[indice].id) {
        return erro(resposta, 400, 'Deixe pelo menos uma pessoa como comprador.');
      }
      usuarios[indice].papel = corpo.papel;
    }
    if (corpo.novaSenha) {
      if (String(corpo.novaSenha).length < 4) return erro(resposta, 400, 'A senha precisa de pelo menos 4 caracteres.');
      usuarios[indice].senha = embaralharSenha(String(corpo.novaSenha));
    }
    gravar(ARQ_USUARIOS, usuarios);
    return responderJson(resposta, 200, {
      usuario: { id: usuarios[indice].id, nome: usuarios[indice].nome, papel: usuarios[indice].papel }
    });
  }

  if (rota === '/api/minha-senha' && metodo === 'POST') {
    if (!exigeLogin()) return;
    const corpo = await lerCorpo(requisicao);
    if (String(corpo.nova || '').length < 4) return erro(resposta, 400, 'A nova senha precisa de pelo menos 4 caracteres.');
    const usuarios = ler(ARQ_USUARIOS, []);
    const eu = usuarios.find((u) => u.id === usuario.id);
    if (!senhaConfere(String(corpo.atual || ''), eu.senha)) return erro(resposta, 401, 'A senha atual não confere.');
    eu.senha = embaralharSenha(String(corpo.nova));
    gravar(ARQ_USUARIOS, usuarios);
    return responderJson(resposta, 200, { ok: true });
  }

  return erro(resposta, 404, 'Rota não encontrada.');
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

iniciarDados();

const servidor = http.createServer((requisicao, resposta) => {
  const url = new URL(requisicao.url, `http://${requisicao.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    tratarApi(requisicao, resposta, url).catch((falha) => {
      console.error('[erro]', falha);
      if (!resposta.headersSent) erro(resposta, 500, `Algo quebrou no servidor: ${falha.message}`);
    });
    return;
  }
  servirArquivo(resposta, url.pathname);
});

servidor.listen(PORTA, '0.0.0.0', () => {
  const enderecos = ['localhost'];
  for (const grupo of Object.values(os.networkInterfaces())) {
    for (const rede of grupo || []) {
      if (rede.family === 'IPv4' && !rede.internal) enderecos.push(rede.address);
    }
  }
  console.log('\n  Espremedor de Laranja — pedidos da copa');
  console.log('  --------------------------------------');
  for (const endereco of enderecos) console.log(`  http://${endereco}:${PORTA}`);
  console.log(`\n  Dados em: ${DIR_DADOS}`);
  console.log('  Pare com Ctrl+C.\n');

  if (process.env.SEM_SINCRONIA === '1') return;
  rodarSincronizacao('início do servidor').then((r) => console.log(`  [catálogo] ${r.mensagem}`));
  setInterval(() => {
    rodarSincronizacao('automática').then((r) => console.log(`  [catálogo] ${r.mensagem}`));
  }, INTERVALO_SINCRONIA).unref();
});
