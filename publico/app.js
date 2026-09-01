'use strict';

/* ------------------------------------------------------------------ */
/* Apoio                                                               */
/* ------------------------------------------------------------------ */

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const $$ = (seletor, raiz = document) => [...raiz.querySelectorAll(seletor)];

const CORES_CATEGORIA = {
  'Cafés': '#4a2e1c',
  'Lungos': '#7a4a24',
  'Lattes': '#c07a2a',
  'Chocolates': '#6e2b2b',
  'Chás': '#8a7a25',
  'Starbucks': '#16694c',
  'NEO': '#2f6b5b',
  'Combos': '#3e4a5c',
  'Acessórios': '#5a5f66',
  'Outros': '#54585e'
};

const estado = {
  usuario: null,
  rodada: null,
  produtos: [],
  carrinho: new Map(),
  pedido: null,
  pix: null,
  anteriores: [],
  categoria: 'Todos',
  busca: '',
  buscaCatalogo: '',
  aba: 'loja'
};

function esc(texto) {
  return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function dinheiro(valor) {
  return (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function corDe(categoria) {
  return CORES_CATEGORIA[categoria] || CORES_CATEGORIA['Outros'];
}

function quandoFoi(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 12/03 — para os eixos do gráfico, onde o espaço é curto. */
function diaCurto(quando) {
  return new Date(quando).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** 12 de março de 2026 — para a tabela e a dica, onde cabe por extenso. */
function diaLongo(quando) {
  return new Date(quando).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

/** Recebe a fração (0,073) e devolve o que se lê (7,3%). */
function porcento(fracao) {
  return `${(Math.abs(Number(fracao) || 0) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

let relogioTorradeira;
function torradeira(mensagem, ruim = false) {
  clearTimeout(relogioTorradeira);
  let caixa = $('.torradeira');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.className = 'torradeira';
    caixa.setAttribute('role', 'status');
    document.body.appendChild(caixa);
  }
  caixa.textContent = mensagem;
  caixa.classList.toggle('ruim', ruim);
  relogioTorradeira = setTimeout(() => caixa.remove(), 3600);
}

/* ------------------------------------------------------------------ */
/* Conversa com a API                                                  */
/* ------------------------------------------------------------------ */

// Vazio quando o próprio backend serve esta tela. Veja config.js.
const BASE = String(window.API || '').replace(/\/$/, '');
const CHAVE_TOKEN = 'espremedor_token';

// O token vai no cabeçalho, não em cookie: assim o front funciona igual estando
// no mesmo endereço da API ou hospedado à parte (GitHub Pages, Netlify).
function lerToken() {
  try {
    return localStorage.getItem(CHAVE_TOKEN) || null;
  } catch {
    return null;
  }
}

function guardarToken(token) {
  try {
    if (token) localStorage.setItem(CHAVE_TOKEN, token);
    else localStorage.removeItem(CHAVE_TOKEN);
  } catch {
    /* navegador sem localStorage: a sessão dura só esta aba */
  }
}

function cabecalhos() {
  const saida = { 'Content-Type': 'application/json' };
  const token = lerToken();
  if (token) saida.Authorization = `Bearer ${token}`;
  return saida;
}

async function api(caminho, opcoes = {}) {
  const resposta = await fetch(BASE + caminho, {
    ...opcoes,
    headers: cabecalhos(),
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined
  });
  let dados = {};
  try {
    dados = await resposta.json();
  } catch {
    /* resposta sem corpo */
  }
  if (resposta.status === 401) guardarToken(null);
  if (!resposta.ok) {
    const falha = new Error(dados.erro || `Falha na comunicação (${resposta.status}).`);
    // O corpo vai junto: a tela de entrada precisa saber se o problema foi o
    // nome ou a senha para oferecer a saída certa, e isso vem em sinalizadores
    // como `naoCadastrado` — não dá para adivinhar pelo texto da mensagem.
    falha.status = resposta.status;
    falha.dados = dados;
    throw falha;
  }
  return dados;
}

/** O CSV precisa do cabeçalho de autorização, então não dá para ser um link simples. */
async function baixarCsv(rodadaId) {
  const caminho = `/api/fechamento.csv${rodadaId ? `?rodada=${encodeURIComponent(rodadaId)}` : ''}`;
  try {
    const resposta = await fetch(BASE + caminho, { headers: cabecalhos() });
    if (!resposta.ok) throw new Error(`Não deu para gerar a planilha (${resposta.status}).`);
    const nomeNoCabecalho = (resposta.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const endereco = URL.createObjectURL(await resposta.blob());
    const link = document.createElement('a');
    link.href = endereco;
    link.download = nomeNoCabecalho ? nomeNoCabecalho[1] : 'lista.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(endereco);
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

let modoEntrada = 'entrar';

// O token que veio no link do e-mail (?redefinir=...), quando houver.
let tokenDoLink = null;

function ajustarEntrada() {
  const criando = modoEntrada === 'criar';
  $('#aba-entrar').setAttribute('aria-pressed', String(!criando));
  $('#aba-criar').setAttribute('aria-pressed', String(criando));
  $('#botao-entrada').textContent = criando ? 'Criar acesso' : 'Entrar';
  // O navegador usa isto para decidir entre preencher a senha guardada e
  // oferecer a criação de uma nova.
  $('#campo-senha').setAttribute('autocomplete', criando ? 'new-password' : 'current-password');
  // O e-mail só aparece ao criar acesso: na entrada ele não serve para nada e
  // um campo a mais só atrapalha quem já tem conta.
  $('#campo-email-caixa').classList.toggle('escondido', !criando);
  $('#dica-entrada').textContent = criando
    ? 'O e-mail é por onde você recupera a senha se esquecer.'
    : 'Ainda não tem acesso? Toque em “Criar acesso”.';
  $('#erro-entrada').classList.add('escondido');
}

/**
 * O recado de erro da entrada, com um botão opcional ao lado.
 *
 * O texto entra por textContent, e não por innerHTML: ele vem do servidor, e
 * mensagem de erro não é lugar para interpretar marcação.
 */
function mostrarErroEntrada(mensagem, acao) {
  const caixa = $('#erro-entrada');
  caixa.textContent = mensagem;
  if (acao) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'link-discreto no-erro';
    botao.textContent = acao.texto;
    botao.addEventListener('click', acao.aoClicar);
    caixa.append(' ', botao);
  }
  caixa.classList.remove('escondido');
}

function mostrarErroRecuperacao(mensagem) {
  const caixa = $('#erro-recuperacao');
  caixa.textContent = mensagem;
  caixa.classList.remove('escondido');
}

/** Alterna entre os três painéis da tela de entrada. */
function mostrarPainelEntrada(qual) {
  $('#painel-acesso').classList.toggle('escondido', qual !== 'acesso');
  $('#painel-recuperacao').classList.toggle('escondido', qual !== 'recuperacao');
  $('#painel-nova-senha').classList.toggle('escondido', qual !== 'nova-senha');
  for (const caixa of ['#erro-entrada', '#erro-recuperacao', '#aviso-recuperacao', '#erro-nova-senha']) {
    $(caixa).classList.add('escondido');
  }

  if (qual === 'recuperacao') {
    // Leva junto o nome que a pessoa já tinha digitado: ela chegou aqui depois
    // de tentar entrar, e redigitar o mesmo nome é atrito à toa.
    const digitado = $('#campo-nome').value.trim();
    if (digitado && !$('#esq-quem').value.trim()) $('#esq-quem').value = digitado;
    if (digitado && !$('#rec-nome').value.trim()) $('#rec-nome').value = digitado;
    mostrarQuemAjuda();
    $('#esq-quem').focus();
  } else if (qual === 'acesso') {
    $('#campo-nome').focus();
  }
}

/** Pede o link de redefinição por e-mail. */
async function enviarEsqueci(evento) {
  if (evento) evento.preventDefault();
  const quem = $('#esq-quem').value.trim();
  if (!quem) return mostrarErroRecuperacao('Escreva seu nome ou seu e-mail.');

  const botao = $('#botao-esqueci');
  botao.disabled = true;
  botao.textContent = 'Enviando…';
  $('#erro-recuperacao').classList.add('escondido');
  try {
    const dados = await api('/api/esqueci-senha', { method: 'POST', corpo: { quem } });
    const aviso = $('#aviso-recuperacao');
    aviso.textContent = dados.mensagem;
    aviso.classList.remove('escondido');
    $('#forma-esqueci').classList.add('escondido');
  } catch (falha) {
    mostrarErroRecuperacao(falha.message);
    // Servidor sem e-mail configurado: o caminho do código é o que resta.
    if (falha.dados && falha.dados.semEmail) mostrarFormularioDoCodigo();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar link por e-mail';
  }
}

function mostrarFormularioDoCodigo() {
  $('#forma-recuperacao').classList.remove('escondido');
  $('#abrir-codigo').classList.add('escondido');
  $('#separador-recuperacao').classList.add('escondido');
  $('#rec-codigo').focus();
}

/**
 * A tela que o link do e-mail abre.
 *
 * Confere o link antes de mostrar o campo: descobrir que o link venceu só
 * depois de escolher a senha e apertar o botão seria cruel.
 */
async function abrirNovaSenha(token) {
  $('#tela-app').classList.add('escondido');
  $('#tela-entrada').classList.remove('escondido');
  mostrarPainelEntrada('nova-senha');

  try {
    const dados = await api(`/api/redefinir/conferir?token=${encodeURIComponent(token)}`);
    $('#abertura-nova-senha').textContent = `Oi, ${dados.nome}. Escolha a senha que você vai usar de agora em diante.`;
    $('#forma-nova-senha').classList.remove('escondido');
    $('#nova-senha-link').focus();
  } catch (falha) {
    $('#abertura-nova-senha').textContent = '';
    $('#forma-nova-senha').classList.add('escondido');
    const caixa = $('#erro-nova-senha');
    caixa.textContent = falha.message;
    caixa.classList.remove('escondido');
  }
}

async function enviarNovaSenha(evento) {
  if (evento) evento.preventDefault();
  const novaSenha = $('#nova-senha-link').value;
  if (!novaSenha) return;

  const botao = $('#botao-nova-senha');
  botao.disabled = true;
  botao.textContent = 'Salvando…';
  try {
    const conta = await api('/api/redefinir', {
      method: 'POST',
      corpo: { token: tokenDoLink, novaSenha }
    });
    guardarToken(conta.token);
    $('#nova-senha-link').value = '';
    // Tira o token da barra de endereços: ele já foi gasto, e recarregar a
    // página com ele na URL só mostraria "este link não vale mais".
    tokenDoLink = null;
    history.replaceState(null, '', location.pathname);
    await iniciar();
    torradeira('Senha trocada. Bom te ver de volta.');
  } catch (falha) {
    const caixa = $('#erro-nova-senha');
    caixa.textContent = falha.message;
    caixa.classList.remove('escondido');
    if (falha.dados && falha.dados.expirado) $('#forma-nova-senha').classList.add('escondido');
  } finally {
    botao.disabled = false;
    botao.textContent = 'Salvar e entrar';
  }
}

function nomesEmLista(nomes) {
  if (nomes.length === 1) return nomes[0];
  return `${nomes.slice(0, -1).join(', ')} ou ${nomes[nomes.length - 1]}`;
}

/** Quem procurar quando nem o e-mail nem o código resolvem. */
async function mostrarQuemAjuda() {
  try {
    const dados = await api('/api/espremedores');

    // Servidor sem e-mail configurado: não adianta oferecer o link.
    if (!dados.emailDisponivel) {
      $('#abertura-recuperacao').textContent =
        'Use o código de recuperação que você anotou quando criou o acesso.';
      $('#forma-esqueci').classList.add('escondido');
      mostrarFormularioDoCodigo();
    }

    if (dados.espremedores.length) {
      $('#dica-recuperacao').textContent =
        `Sem e-mail e sem código? Peça a ${nomesEmLista(dados.espremedores)} para redefinir sua senha.`;
    }
  } catch {
    // A dica genérica já está escrita na tela; sem rede ela continua servindo.
  }
}

let codigoNaTela = '';

/** A janela que mostra o código — a única vez em que ele aparece. */
function mostrarCodigo(codigo, titulo, subtitulo) {
  codigoNaTela = codigo;
  $('#titulo-codigo').textContent = titulo;
  $('#subtitulo-codigo').textContent = subtitulo;
  $('#valor-codigo').textContent = codigo;
  const janela = $('#janela-codigo');
  if (!janela.open) janela.showModal();
}

async function enviarEntrada(evento) {
  if (evento) evento.preventDefault();
  const nome = $('#campo-nome').value.trim();
  const senha = $('#campo-senha').value;
  if (!nome || !senha) return mostrarErroEntrada('Preencha nome e senha.');

  const criando = modoEntrada === 'criar';
  const enderecoEmail = $('#campo-email').value.trim();
  if (criando && !enderecoEmail) return mostrarErroEntrada('Informe seu e-mail — é por ele que você recupera a senha.');

  const botao = $('#botao-entrada');
  botao.disabled = true;
  botao.textContent = criando ? 'Criando…' : 'Entrando…';
  try {
    const conta = await api(criando ? '/api/cadastro' : '/api/entrar', {
      method: 'POST',
      corpo: criando ? { nome, senha, email: enderecoEmail } : { nome, senha }
    });
    guardarToken(conta.token);
    $('#campo-senha').value = '';
    await iniciar();
    if (conta.recuperacao) {
      mostrarCodigo(
        conta.recuperacao,
        'Anote seu código de recuperação',
        'É o que devolve seu acesso se você esquecer a senha. Ele não aparece de novo.'
      );
    }
  } catch (falha) {
    const naoCadastrado = falha.dados && falha.dados.naoCadastrado;
    const senhaErrada = falha.dados && falha.dados.senhaErrada;
    if (naoCadastrado && !criando) {
      mostrarErroEntrada(falha.message, {
        texto: 'Criar acesso com esse nome',
        aoClicar: () => {
          modoEntrada = 'criar';
          ajustarEntrada();
          $('#campo-senha').focus();
        }
      });
    } else if (senhaErrada) {
      mostrarErroEntrada(falha.message, {
        texto: 'Esqueci minha senha',
        aoClicar: () => mostrarPainelEntrada('recuperacao')
      });
    } else {
      mostrarErroEntrada(falha.message);
    }
  } finally {
    botao.disabled = false;
    ajustarEntrada();
  }
}

async function enviarRecuperacao(evento) {
  if (evento) evento.preventDefault();
  const nome = $('#rec-nome').value.trim();
  const codigo = $('#rec-codigo').value.trim();
  const novaSenha = $('#rec-senha').value;
  if (!nome || !codigo || !novaSenha) return mostrarErroRecuperacao('Preencha os três campos.');

  const botao = $('#botao-recuperar');
  botao.disabled = true;
  botao.textContent = 'Trocando…';
  try {
    const conta = await api('/api/recuperar', { method: 'POST', corpo: { nome, codigo, novaSenha } });
    guardarToken(conta.token);
    $('#rec-codigo').value = '';
    $('#rec-senha').value = '';
    await iniciar();
    torradeira('Senha trocada. Bom te ver de volta.');
    mostrarCodigo(
      conta.recuperacao,
      'Seu novo código de recuperação',
      'O anterior foi usado e não vale mais. Anote este no lugar dele.'
    );
  } catch (falha) {
    mostrarErroRecuperacao(falha.message);
    if (falha.dados && falha.dados.semCodigo) mostrarQuemAjuda();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Trocar a senha e entrar';
  }
}

/* ------------------------------------------------------------------ */
/* Navegação                                                           */
/* ------------------------------------------------------------------ */

function trocarAba(aba) {
  estado.aba = aba;
  for (const botao of $$('#navegacao button')) {
    botao.setAttribute('aria-current', String(botao.dataset.aba === aba));
  }
  for (const nome of ['loja', 'rastreio', 'fechamento', 'catalogo', 'pessoas']) {
    $(`#aba-${nome}`).classList.toggle('escondido', nome !== aba);
  }
  if (aba === 'rastreio') carregarRastreio();
  if (aba === 'fechamento') carregarFechamento();
  if (aba === 'catalogo') desenharCatalogo();
  if (aba === 'pessoas') carregarPessoas();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ */
/* Sabores                                                             */
/* ------------------------------------------------------------------ */

function produtosVisiveis() {
  const busca = estado.busca.trim().toLowerCase();
  return estado.produtos
    .filter((p) => p.ativo !== false)
    .filter((p) => estado.categoria === 'Todos' || p.categoria === estado.categoria)
    .filter((p) => !busca || `${p.nome} ${p.descricao || ''}`.toLowerCase().includes(busca))
    .sort((a, b) => (a.disponivel === false ? 1 : 0) - (b.disponivel === false ? 1 : 0));
}

function desenharFichas() {
  const categorias = [...new Set(estado.produtos.filter((p) => p.ativo !== false).map((p) => p.categoria))].sort(
    (a, b) => a.localeCompare(b, 'pt-BR')
  );
  $('#fichas-categorias').innerHTML = ['Todos', ...categorias]
    .map(
      (categoria) =>
        `<button type="button" data-categoria="${esc(categoria)}" aria-pressed="${categoria === estado.categoria}">${esc(categoria)}</button>`
    )
    .join('');
}

/**
 * O selo de preço do cartão.
 *
 * O texto diz tudo sozinho ("12% abaixo da média") e a cor só reforça: quem não
 * distingue verde de laranja precisa receber a mesma informação. Sem histórico
 * suficiente o selo não aparece — dizer "no preço de sempre" no primeiro dia
 * seria afirmar algo que ninguém conferiu.
 */
function seloDePreco(analise) {
  if (!analise || analise.situacao === 'sem-dados') return '';
  if (analise.situacao === 'media') {
    return `<span class="selo-preco media" title="Média dos últimos ${analise.dias} dias: ${dinheiro(analise.media)}">no preço de sempre</span>`;
  }
  const abaixo = analise.situacao === 'abaixo';
  return `<span class="selo-preco ${abaixo ? 'abaixo' : 'acima'}" title="Média dos últimos ${analise.dias} dias: ${dinheiro(analise.media)}">
    <span aria-hidden="true">${abaixo ? '↓' : '↑'}</span> ${porcento(analise.percentual)} ${abaixo ? 'abaixo' : 'acima'} da média</span>`;
}

function desenharGrade() {
  const lista = produtosVisiveis();
  $('#sem-resultado').classList.toggle('escondido', lista.length > 0);

  $('#grade-produtos').innerHTML = lista
    .map((produto) => {
      const quantidade = estado.carrinho.get(produto.id) || 0;
      const indisponivel = produto.disponivel === false;
      const marca = produto.intensidade || '';
      return `
        <article class="cartao ${quantidade ? 'escolhido' : ''} ${indisponivel ? 'sem-estoque' : ''}" data-id="${esc(produto.id)}">
          <span class="disco" style="--cor:${corDe(produto.categoria)}" aria-hidden="true">${esc(marca)}${produto.imagem ? `<img src="${esc(produto.imagem)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
          <div>
            <h3>${
              produto.url
                ? `<a class="link-produto" href="${esc(produto.url)}" target="_blank" rel="noopener noreferrer">${esc(produto.nome)}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="so-leitor">abre o sabor no site da Nescafé, em outra aba</span></a>`
                : esc(produto.nome)
            }</h3>
            ${produto.descricao ? `<p class="descricao">${esc(produto.descricao)}</p>` : ''}
            <p class="meta">${esc(produto.categoria)}${produto.capsulas ? ` · ${produto.capsulas} cápsulas` : ''}</p>
            <div class="linha-preco">
              ${indisponivel ? '<span class="aviso-estoque">sem estoque</span>' : `<span class="preco">${dinheiro(produto.preco)}</span>`}
              ${!indisponivel && produto.precoDe ? `<span class="preco-antigo">${dinheiro(produto.precoDe)}</span>` : ''}
              <span class="contador">
                <button type="button" data-acao="menos" aria-label="Tirar uma caixa de ${esc(produto.nome)}" ${quantidade ? '' : 'disabled'}>−</button>
                <span>${quantidade}</span>
                <button type="button" data-acao="mais" aria-label="Somar uma caixa de ${esc(produto.nome)}" ${indisponivel ? 'disabled' : ''}>+</button>
              </span>
            </div>
            <div class="linha-analise">
              ${seloDePreco(produto.analise)}
              <button type="button" class="botao-historico" data-acao="historico" aria-label="Ver o histórico de preço de ${esc(produto.nome)}">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5 6 7.5l3 2.5 5-6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                histórico
              </button>
            </div>
          </div>
        </article>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Histórico de preço                                                  */
/* ------------------------------------------------------------------ */

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Medidas do gráfico no sistema do viewBox — o SVG se estica para a largura que
 * tiver. A margem de baixo guarda a faixa das datas e a da direita, o preço de
 * hoje na ponta da linha: sem esse espaço reservado os dois saem cortados.
 */
const GRAFICO = { largura: 720, altura: 300, topo: 24, direita: 82, baixo: 42, esquerda: 76 };

/** As contas de escala, compartilhadas pelo desenho e pela dica do cursor. */
function escalaDoGrafico(pontos, precoAtual, media) {
  const serie = pontos.map((ponto) => ({ t: new Date(ponto.em).getTime(), v: ponto.preco }));
  const inicio = serie[0].t;
  const agora = Date.now();
  // Um ponto só deixaria o eixo do tempo sem largura nenhuma, e a divisão daria
  // infinito. Um dia de folga resolve.
  const fim = agora > inicio + 60000 ? agora : inicio + DIA_MS;

  const valores = [...serie.map((ponto) => ponto.v), Number(precoAtual) || serie[0].v];
  if (media) valores.push(media);

  let menor = Math.min(...valores);
  let maior = Math.max(...valores);
  if (maior - menor < 0.01) {
    // Preço que nunca mudou: sem abrir a faixa ela teria altura zero e a linha
    // ficaria colada na borda de cima do quadro.
    const folga = Math.max(maior * 0.05, 0.5);
    menor -= folga;
    maior += folga;
  } else {
    const folga = (maior - menor) * 0.12;
    menor -= folga;
    maior += folga;
  }

  const areaL = GRAFICO.largura - GRAFICO.esquerda - GRAFICO.direita;
  const areaA = GRAFICO.altura - GRAFICO.topo - GRAFICO.baixo;

  return {
    serie,
    inicio,
    fim,
    areaL,
    areaA,
    menor,
    maior,
    x: (t) => GRAFICO.esquerda + ((t - inicio) / (fim - inicio)) * areaL,
    y: (v) => GRAFICO.topo + ((maior - v) / (maior - menor)) * areaA
  };
}

/**
 * A linha do preço no tempo, em degraus.
 *
 * Degrau e não reta: o preço não sobe aos poucos entre uma leitura e outra — ele
 * fica parado e pula de uma vez. Uma reta ligando os pontos desenharia uma
 * transição gradual que nunca aconteceu.
 */
function svgDoHistorico(pontos, precoAtual, analise) {
  const e = escalaDoGrafico(pontos, precoAtual, analise.media);
  const base = GRAFICO.topo + e.areaA;
  const direita = GRAFICO.esquerda + e.areaL;
  const ultimo = e.serie[e.serie.length - 1];

  let linha = `M ${e.x(e.serie[0].t).toFixed(1)} ${e.y(e.serie[0].v).toFixed(1)}`;
  for (let i = 1; i < e.serie.length; i += 1) {
    const px = e.x(e.serie[i].t).toFixed(1);
    linha += ` L ${px} ${e.y(e.serie[i - 1].v).toFixed(1)} L ${px} ${e.y(e.serie[i].v).toFixed(1)}`;
  }
  linha += ` L ${direita.toFixed(1)} ${e.y(ultimo.v).toFixed(1)}`;

  const grades = [0, 1, 2, 3].map((passo) => {
    const valor = e.menor + ((e.maior - e.menor) * passo) / 3;
    const py = e.y(valor).toFixed(1);
    return `<line class="grade" x1="${GRAFICO.esquerda}" y1="${py}" x2="${direita}" y2="${py}"></line>
            <text class="rotulo-eixo" x="${GRAFICO.esquerda - 10}" y="${py}" text-anchor="end" dominant-baseline="middle">${dinheiro(valor)}</text>`;
  });

  const datas = [0, 1, 2, 3].map((passo) => {
    const quando = e.inicio + ((e.fim - e.inicio) * passo) / 3;
    const ancora = passo === 0 ? 'start' : passo === 3 ? 'end' : 'middle';
    return `<text class="rotulo-eixo" x="${e.x(quando).toFixed(1)}" y="${base + 22}" text-anchor="${ancora}">${diaCurto(quando)}</text>`;
  });

  // A média é uma referência, não uma grade — por isso ela é a única linha
  // tracejada do desenho.
  //
  // O rótulo fica à esquerda, dentro do quadro, e não na ponta direita junto do
  // preço de hoje: quando o preço atual está perto da média, os dois textos
  // cairiam um em cima do outro justamente no caso mais comum.
  const mediaDesenhada = analise.media
    ? `<line class="linha-media" x1="${GRAFICO.esquerda}" y1="${e.y(analise.media).toFixed(1)}" x2="${direita}" y2="${e.y(analise.media).toFixed(1)}"></line>
       <text class="rotulo-media" x="${GRAFICO.esquerda + 6}" y="${(e.y(analise.media) - 7).toFixed(1)}">média ${dinheiro(analise.media)}</text>`
    : '';

  const marcadores = e.serie
    .map((ponto) => `<circle class="ponto" cx="${e.x(ponto.t).toFixed(1)}" cy="${e.y(ponto.v).toFixed(1)}" r="4"></circle>`)
    .join('');

  return `
    <svg viewBox="0 0 ${GRAFICO.largura} ${GRAFICO.altura}" class="grafico-precos" role="img"
         aria-label="Preço de hoje ${dinheiro(precoAtual)}${analise.media ? `, média ${dinheiro(analise.media)}` : ''}. Os mesmos valores estão na tabela abaixo do gráfico.">
      ${grades.join('')}
      <path class="area" d="${linha} L ${direita.toFixed(1)} ${base} L ${e.x(e.serie[0].t).toFixed(1)} ${base} Z"></path>
      ${mediaDesenhada}
      <path class="linha" d="${linha}"></path>
      ${marcadores}
      <circle class="ponto atual" cx="${direita.toFixed(1)}" cy="${e.y(ultimo.v).toFixed(1)}" r="4.5"></circle>
      <text class="rotulo-ponta" x="${direita + 8}" y="${e.y(ultimo.v).toFixed(1)}" dominant-baseline="middle">${dinheiro(precoAtual)}</text>
      <line class="cursor escondido" id="cursor-grafico" y1="${GRAFICO.topo}" y2="${base}"></line>
      <rect id="area-grafico" x="${GRAFICO.esquerda}" y="${GRAFICO.topo}" width="${e.areaL}" height="${e.areaA}" fill="transparent"></rect>
    </svg>`;
}

function tabelaDoHistorico(pontos, analise) {
  const linhas = [...pontos]
    .reverse()
    .map((ponto) => {
      const diferenca = analise.media ? (ponto.preco - analise.media) / analise.media : null;
      return `<tr>
        <td>${diaLongo(ponto.em)}</td>
        <td class="num">${dinheiro(ponto.preco)}</td>
        <td class="num">${diferenca === null ? '—' : `${diferenca < 0 ? '−' : '+'}${porcento(Math.abs(diferenca))}`}</td>
      </tr>`;
    })
    .join('');

  return `<table>
      <thead><tr><th>Quando mudou</th><th class="num">Preço</th><th class="num">vs. média</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>`;
}

/**
 * A dica que segue o cursor. Mostra o preço que estava valendo naquele ponto do
 * tempo — e não o ponto mais próximo, porque preço é degrau: entre 3 e 17 de
 * julho vale o que foi gravado no dia 3, mesmo que o dia 17 esteja mais perto.
 */
function ligarDicaDoGrafico(pontos, precoAtual, media) {
  const figura = $('#grafico-precos');
  if (!figura) return;

  const svg = $('svg', figura);
  const alvo = $('#area-grafico', figura);
  const cursor = $('#cursor-grafico', figura);
  const dica = $('#dica-grafico');
  if (!svg || !alvo) return;

  const e = escalaDoGrafico(pontos, precoAtual, media);

  function mostrar(evento) {
    const caixa = svg.getBoundingClientRect();
    if (!caixa.width) return;
    // De pixel da tela para o sistema do viewBox: o SVG escala junto com a
    // largura da janela, então a conta não pode assumir 1 unidade = 1 pixel.
    const posicao = ((evento.clientX - caixa.left) / caixa.width) * GRAFICO.largura;

    let indice = 0;
    for (let i = 0; i < e.serie.length; i += 1) {
      if (e.x(e.serie[i].t) <= posicao) indice = i;
    }
    const ponto = e.serie[indice];
    const diferenca = media ? (ponto.v - media) / media : null;

    cursor.setAttribute('x1', posicao.toFixed(1));
    cursor.setAttribute('x2', posicao.toFixed(1));
    cursor.classList.remove('escondido');

    dica.innerHTML = `<b>${dinheiro(ponto.v)}</b><span>desde ${diaLongo(ponto.t)}</span>${
      diferenca === null ? '' : `<span>${diferenca < 0 ? '−' : '+'}${porcento(Math.abs(diferenca))} vs. média</span>`
    }`;
    dica.style.left = `${Math.min(92, Math.max(8, (posicao / GRAFICO.largura) * 100))}%`;
    dica.classList.remove('escondido');
  }

  function esconder() {
    cursor.classList.add('escondido');
    dica.classList.add('escondido');
  }

  alvo.addEventListener('pointermove', mostrar);
  alvo.addEventListener('pointerdown', mostrar);
  alvo.addEventListener('pointerleave', esconder);
}

async function abrirHistoricoDePreco(produtoId) {
  const janela = $('#janela-historico');
  $('#titulo-historico').textContent = 'Histórico de preço';
  $('#subtitulo-historico').textContent = 'Buscando…';
  $('#conteudo-historico').innerHTML = '';
  if (!janela.open) janela.showModal();

  try {
    desenharHistoricoDePreco(await api(`/api/produtos/${encodeURIComponent(produtoId)}/historico`));
  } catch (falha) {
    $('#subtitulo-historico').textContent = '';
    $('#conteudo-historico').innerHTML = `<p class="vazio">${esc(falha.message)}</p>`;
  }
}

function desenharHistoricoDePreco({ produto, pontos, analise, janelaDias }) {
  $('#titulo-historico').textContent = produto.nome;
  $('#subtitulo-historico').textContent =
    analise.situacao === 'sem-dados'
      ? `Hoje: ${dinheiro(produto.preco)}.`
      : `Hoje ${dinheiro(produto.preco)} · média de ${analise.dias} dias ${dinheiro(analise.media)} · variou entre ${dinheiro(analise.minimo)} e ${dinheiro(analise.maximo)}.`;

  if (!pontos.length) {
    $('#conteudo-historico').innerHTML =
      '<p class="vazio">Ainda não guardamos preço deste sabor. O histórico começa na próxima leitura do site, que acontece de 12 em 12 horas.</p>';
    return;
  }

  const veredito =
    analise.situacao === 'sem-dados'
      ? `<p class="veredito neutro"><span aria-hidden="true">•</span> São ${analise.dias} dia(s) de histórico — ainda é cedo pra dizer se está caro ou barato.</p>`
      : analise.situacao === 'media'
        ? '<p class="veredito neutro"><span aria-hidden="true">=</span> Está no preço de sempre.</p>'
        : `<p class="veredito ${analise.situacao}"><span aria-hidden="true">${analise.situacao === 'abaixo' ? '↓' : '↑'}</span> Está ${porcento(Math.abs(analise.percentual))} ${
            analise.situacao === 'abaixo' ? 'abaixo' : 'acima'
          } da média — ${dinheiro(Math.abs(analise.diferenca))} ${analise.situacao === 'abaixo' ? 'a menos' : 'a mais'} por caixa.</p>`;

  $('#conteudo-historico').innerHTML = `
    ${veredito}
    <figure class="grafico" id="grafico-precos">
      ${svgDoHistorico(pontos, produto.preco, analise)}
      <div class="dica-grafico escondido" id="dica-grafico" role="status"></div>
    </figure>
    <p class="legenda-grafico">Cada degrau é uma mudança de preço; a linha tracejada é a média dos últimos ${janelaDias} dias. A escala começa perto do menor preço, e não no zero.</p>
    <details class="tabela-historico">
      <summary>Ver os valores em tabela</summary>
      ${tabelaDoHistorico(pontos, analise)}
    </details>`;

  ligarDicaDoGrafico(pontos, produto.preco, analise.media);
}

function desenharPainel() {
  const itens = [...estado.carrinho.entries()]
    .map(([id, quantidade]) => ({ produto: estado.produtos.find((p) => p.id === id), quantidade }))
    .filter((linha) => linha.produto && linha.quantidade > 0);

  $('#painel-vazio').classList.toggle('escondido', itens.length > 0);
  $('#itens-painel').innerHTML = itens
    .map(
      ({ produto, quantidade }) => `
        <li>
          <span class="disco pequeno" style="--cor:${corDe(produto.categoria)}" aria-hidden="true"></span>
          <span>
            <span class="nome-item">${esc(produto.nome)}</span><br>
            <span class="qtd-item">${quantidade} × ${dinheiro(produto.preco)}</span>
          </span>
          <span class="valor-item">${dinheiro(produto.preco * quantidade)}</span>
        </li>`
    )
    .join('');

  const caixas = itens.reduce((soma, i) => soma + i.quantidade, 0);
  const capsulas = itens.reduce((soma, i) => soma + (i.produto.capsulas || 0) * i.quantidade, 0);
  const total = itens.reduce((soma, i) => soma + i.produto.preco * i.quantidade, 0);

  $('#total-caixas').textContent = caixas;
  $('#total-capsulas').textContent = capsulas;
  $('#total-valor').textContent = dinheiro(total);
  $('#botao-enviar').disabled = caixas === 0;
  $('#botao-enviar').textContent = estado.pedido ? 'Atualizar meu pedido' : 'Enviar pedido';

  const recado = $('#recado-enviado');
  if (estado.pedido) {
    recado.textContent = `Pedido enviado em ${quandoFoi(estado.pedido.atualizadoEm)}. Dá pra mudar enquanto a rodada estiver aberta.`;
    recado.classList.remove('escondido');
    $('#botao-cancelar').classList.remove('escondido');
  } else {
    recado.classList.add('escondido');
    $('#botao-cancelar').classList.add('escondido');
  }

  desenharPagamento();
  desenharAnteriores();
  pedirAjusteDoPainel();
}

/**
 * O bloco do Pix só aparece com pedido enviado — antes disso não há valor a
 * pagar. Se o carrinho tiver mudanças ainda não enviadas, o QR some: ele carrega
 * o valor do pedido que está no servidor, e mostrar o antigo faria pagar errado.
 */
function desenharPagamento() {
  const bloco = $('#bloco-pagamento');
  const pedido = estado.pedido;

  if (!pedido) {
    bloco.classList.add('escondido');
    return;
  }

  const totalEnviado = pedido.itens.reduce((s, i) => s + (Number(i.preco) || 0) * i.quantidade, 0);
  const mudou = carrinhoDiferenteDoPedido();

  if (!estado.pix) {
    bloco.classList.remove('escondido');
    $('#qr-pix').innerHTML = '';
    $('#pix-nome').textContent = '—';
    $('#pix-chave').textContent = 'Pix ainda não configurado';
    $('#pix-valor').textContent = dinheiro(totalEnviado);
    $('#botao-copiar-pix').classList.add('escondido');
    $('#botao-paguei').classList.add('escondido');
    mostrarAviso('O espremedor ainda não cadastrou a chave Pix. Combine o pagamento com ele.', 'neutro');
    return;
  }

  bloco.classList.remove('escondido');
  $('#botao-copiar-pix').classList.toggle('escondido', mudou);
  $('#qr-pix').innerHTML = mudou ? '' : estado.pix.qrcode;
  $('#pix-nome').textContent = estado.pix.nome;
  $('#pix-chave').textContent = formatarChavePix(estado.pix.chave);
  $('#pix-valor').textContent = dinheiro(estado.pix.valor);

  const botao = $('#botao-paguei');
  botao.classList.toggle('escondido', mudou);

  if (mudou) {
    mostrarAviso('Você mexeu no pedido. Envie de novo para o código do Pix valer o novo valor.', 'atencao');
    return;
  }

  if (pedido.confirmadoEm) {
    botao.disabled = true;
    botao.textContent = 'Pagamento confirmado';
    mostrarAviso(`O espremedor confirmou seu pagamento em ${quandoFoi(pedido.confirmadoEm)}.`, 'bom');
  } else if (pedido.pagoEm) {
    botao.disabled = false;
    botao.textContent = 'Avisei que paguei — desfazer';
    mostrarAviso(`Você avisou que pagou em ${quandoFoi(pedido.pagoEm)}. Falta o espremedor confirmar.`, 'neutro');
  } else {
    botao.disabled = false;
    botao.textContent = 'Já paguei';
    esconderAviso();
  }
}

/**
 * Rodadas já fechadas em que a pessoa pediu.
 *
 * Fechar a rodada não apaga a dívida: aqui ela vê o que pediu e, se ainda não
 * pagou, o Pix daquela rodada continua à mão.
 */
function desenharAnteriores() {
  const bloco = $('#bloco-anteriores');
  const fechadas = estado.anteriores.filter((r) => !r.rodada.aberta);

  if (!fechadas.length) {
    bloco.classList.add('escondido');
    return;
  }
  bloco.classList.remove('escondido');

  const devendo = fechadas.filter((r) => !r.confirmadoEm);
  const aPagar = devendo.reduce((s, r) => s + r.total, 0);
  $('#resumo-anteriores').textContent = devendo.length
    ? `Falta acertar ${dinheiro(aPagar)} em ${devendo.length} rodada${devendo.length > 1 ? 's' : ''}.`
    : 'Tudo acertado. Aqui fica o histórico do que você pediu.';

  $('#lista-anteriores').innerHTML = fechadas
    .map((r) => {
      const situacao = r.confirmadoEm
        ? { classe: 'pago', texto: 'pago' }
        : r.pagoEm
          ? { classe: 'avisou', texto: 'aguardando confirmação' }
          : { classe: 'devendo', texto: 'em aberto' };

      return `
        <details class="rodada-anterior ${situacao.classe}" data-rodada="${esc(r.rodada.id)}">
          <summary>
            <span class="nome-rodada-anterior">${esc(r.rodada.nome)}</span>
            <span class="situacao">${situacao.texto}</span>
            <b>${dinheiro(r.total)}</b>
          </summary>
          <ul class="itens-anteriores">
            ${r.itens.map((i) => `<li>${i.quantidade}× ${esc(i.nome)} <span>${dinheiro(i.preco * i.quantidade)}</span></li>`).join('')}
          </ul>
          ${
            r.confirmadoEm
              ? `<p class="aviso-pagamento bom">Pagamento confirmado em ${quandoFoi(r.confirmadoEm)}.</p>`
              : `
            ${r.pix ? `<div class="qr">${r.pix.qrcode}</div>` : ''}
            ${
              r.pix
                ? `<div class="pix-dados">
                     <span class="pix-rotulo">Chave</span><code>${esc(formatarChavePix(r.pix.chave))}</code>
                     <span class="pix-rotulo">Valor</span><b>${dinheiro(r.pix.valor)}</b>
                   </div>
                   <button type="button" class="botao claro largo" data-acao="copiar-pix">Copiar código Pix</button>`
                : '<p class="aviso-pagamento neutro">O espremedor ainda não cadastrou a chave Pix.</p>'
            }
            <button type="button" class="botao ${r.pagoEm ? 'claro' : 'verde'} largo" data-acao="paguei">
              ${r.pagoEm ? 'Avisei que paguei — desfazer' : 'Já paguei'}
            </button>
            ${r.pagoEm ? `<p class="aviso-pagamento neutro">Avisado em ${quandoFoi(r.pagoEm)}. Falta o espremedor confirmar.</p>` : ''}`
          }
        </details>`;
    })
    .join('');
}

function mostrarAviso(texto, tipo) {
  const aviso = $('#aviso-pagamento');
  aviso.textContent = texto;
  aviso.className = `aviso-pagamento ${tipo}`;
}

function esconderAviso() {
  $('#aviso-pagamento').className = 'aviso-pagamento escondido';
}

/** O que está no carrinho agora bate com o pedido já enviado? */
function carrinhoDiferenteDoPedido() {
  if (!estado.pedido) return false;
  const enviado = new Map(estado.pedido.itens.map((i) => [i.produtoId, i.quantidade]));
  if (enviado.size !== estado.carrinho.size) return true;
  for (const [id, quantidade] of estado.carrinho) {
    if (enviado.get(id) !== quantidade) return true;
  }
  return false;
}

/** 00000000000 -> 000.000.000-00, só para a chave ficar legível na tela. */
function formatarChavePix(chave) {
  const digitos = String(chave).replace(/\D/g, '');
  if (digitos.length === 11 && !String(chave).includes('@')) {
    return digitos.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  return chave;
}

/**
 * Limita a altura da coluna "Seu pedido" ao espaço que sobra na tela.
 *
 * O CSS já tem um limite, mas ele só serve para quando a coluna está grudada no
 * topo. Antes disso ela começa mais abaixo — e aí o mesmo limite deixa o fim
 * dela (o QR e os botões de pagamento) passar do rodapé da janela. Como só o
 * navegador sabe onde a coluna está a cada momento, a conta é feita aqui.
 */
function ajustarAlturaPainel() {
  const painel = $('.painel');
  if (!painel) return;

  // Numa coluna só (celular) a página rola inteira; prender a altura atrapalha.
  if (getComputedStyle(painel).position !== 'sticky') {
    painel.style.maxHeight = '';
    return;
  }

  const distanciaDoTopo = painel.getBoundingClientRect().top;
  const sobra = window.innerHeight - distanciaDoTopo - 16;
  // Um piso evita que a coluna vire uma fresta em janelas muito baixas.
  painel.style.maxHeight = `${Math.max(260, Math.round(sobra))}px`;
}

let ajustePendente = false;
function pedirAjusteDoPainel() {
  if (ajustePendente) return;
  ajustePendente = true;
  requestAnimationFrame(() => {
    ajustePendente = false;
    ajustarAlturaPainel();
  });
}

function desenharLoja() {
  desenharFichas();
  desenharGrade();
  desenharPainel();
}

function mudarQuantidade(id, passo) {
  const atual = estado.carrinho.get(id) || 0;
  const nova = Math.max(0, Math.min(99, atual + passo));
  if (nova === 0) estado.carrinho.delete(id);
  else estado.carrinho.set(id, nova);
  desenharGrade();
  desenharPainel();
}

async function enviarPedido() {
  const itens = [...estado.carrinho.entries()].map(([produtoId, quantidade]) => ({ produtoId, quantidade }));
  const botao = $('#botao-enviar');
  botao.disabled = true;
  try {
    const resposta = await api('/api/meu-pedido', { method: 'PUT', corpo: { itens } });
    estado.pedido = resposta.pedido;
    estado.pix = resposta.pix;
    desenharPainel();
    torradeira('Pedido enviado. Agora é só pagar.');
    $('#bloco-pagamento').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (falha) {
    torradeira(falha.message, true);
  } finally {
    botao.disabled = false;
  }
}

async function cancelarPedido() {
  if (!confirm('Tirar seu pedido desta rodada?')) return;
  try {
    await api('/api/meu-pedido', { method: 'DELETE' });
    estado.pedido = null;
    estado.pix = null;
    estado.carrinho.clear();
    desenharLoja();
    torradeira('Pedido cancelado.');
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Rastreio                                                            */
/* ------------------------------------------------------------------ */

let rastreioAtual = null;

async function carregarRastreio() {
  try {
    rastreioAtual = await api('/api/rastreio');
    desenharRastreio(rastreioAtual);
  } catch (falha) {
    $('#lista-rastreio').innerHTML = `<p class="vazio">${esc(falha.message)}</p>`;
  }
}

function desenharRastreio({ rodadas, podeEditar, site }) {
  $('#subtitulo-rastreio').textContent = podeEditar
    ? `Cole aqui o código que o ${new URL(site).host} te dá depois da compra.`
    : 'Onde está a entrega de cada rodada.';

  if (!rodadas.length) {
    $('#lista-rastreio').innerHTML = '<p class="vazio">Nenhuma rodada ainda.</p>';
    return;
  }

  $('#lista-rastreio').innerHTML = rodadas
    .map(
      (r) => `
      <div class="rastreio-rodada ${r.rastreio ? 'com-codigo' : ''}" data-rodada="${esc(r.id)}">
        <div class="rastreio-cabeca">
          <b>${esc(r.nome)}</b>
          <span class="situacao">${r.aberta ? 'aberta' : `fechada em ${quandoFoi(r.fechadaEm)}`}</span>
        </div>

        ${
          r.rastreio
            ? `<p class="rastreio-codigo">
                 <code>${esc(r.rastreio)}</code>
                 <a class="botao claro miudo" href="${esc(r.rastreioUrl)}" target="_blank" rel="noopener noreferrer">Acompanhar</a>
               </p>
               <p class="quem">Anotado em ${quandoFoi(r.rastreioEm)}.</p>`
            : `<p class="quem">${
                r.aberta
                  ? 'A rodada ainda está aberta — o código aparece depois da compra.'
                  : 'Sem código de rastreio ainda.'
              }</p>`
        }

        ${
          podeEditar
            ? `<div class="linha-campos">
                 <div class="campo">
                   <label for="rastreio-${esc(r.id)}">Código ou endereço do rastreio</label>
                   <input id="rastreio-${esc(r.id)}" data-campo="rastreio" value="${esc(r.rastreio || '')}" placeholder="FR260730GKSEI">
                 </div>
                 <button type="button" class="botao claro" data-acao="salvar-rastreio">Salvar</button>
                 ${r.rastreio ? '<button type="button" class="botao perigo" data-acao="limpar-rastreio">Tirar</button>' : ''}
               </div>`
            : ''
        }
      </div>`
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/* Fechamento                                                          */
/* ------------------------------------------------------------------ */

let fechamentoAtual = null;

async function carregarFechamento() {
  try {
    const dados = await api('/api/fechamento');
    fechamentoAtual = dados;
    desenharFechamento(dados);
    const pendentes = await api('/api/pendencias');
    desenharPendencias(pendentes.pendencias, pendentes.total);
    const historico = await api('/api/rodadas');
    desenharHistorico(historico.rodadas);
    await carregarMelhorDia();
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

async function carregarMelhorDia() {
  try {
    desenharMelhorDia(await api('/api/melhor-dia'));
  } catch (falha) {
    // Análise de preço é acessório: se falhar, o fechamento continua servindo.
    $('#conteudo-melhor-dia').innerHTML = `<p class="vazio">${esc(falha.message)}</p>`;
  }
}

/**
 * A régua dos sete dias.
 *
 * Cada barra sai do meio: para a esquerda quando o dia costuma sair mais barato
 * que a média, para a direita quando sai mais caro. O número fica em preto ao
 * lado — a cor da barra reforça, mas não é o único jeito de ler.
 */
function reguaDosDias(semana) {
  const maior = Math.max(...semana.dias.map((dia) => Math.abs(dia.percentual || 0)), 0.001);

  const linhas = semana.dias
    .map((dia) => {
      const valor = dia.percentual || 0;
      const largura = ((Math.abs(valor) / maior) * 50).toFixed(1);
      const eMelhor = semana.melhor && semana.melhor.dia === dia.dia;
      return `
        <div class="dia-semana ${eMelhor ? 'melhor' : ''}">
          <span class="dia-nome">${esc(dia.nome)}${eMelhor ? '<span class="etiqueta">melhor</span>' : ''}</span>
          <span class="dia-trilho"><i class="${valor < 0 ? 'abaixo' : 'acima'}" style="width:${largura}%"></i></span>
          <span class="dia-valor">${valor < 0 ? '−' : '+'}${porcento(valor)}</span>
        </div>`;
    })
    .join('');

  return `<div class="dias-semana">${linhas}</div>`;
}

function desenharMelhorDia({ semana, momento, janelaDias }) {
  const partes = [];

  // Primeiro o que dá pra fazer hoje: a lista desta rodada está cara ou barata?
  if (momento.suficiente) {
    const sinal = momento.situacao === 'media' ? '=' : momento.situacao === 'abaixo' ? '↓' : '↑';
    const conselho =
      momento.situacao === 'abaixo'
        ? ' Bom momento pra fechar a compra.'
        : momento.situacao === 'acima'
          ? ' Se der pra esperar, costuma ficar mais em conta.'
          : '';
    const texto =
      momento.situacao === 'media'
        ? `A lista desta rodada está no preço de sempre: ${dinheiro(momento.total)}.`
        : `A lista desta rodada está <b>${porcento(momento.percentual)} ${momento.situacao === 'abaixo' ? 'abaixo' : 'acima'}</b> do que ela costuma custar — ${dinheiro(momento.total)} contra ${dinheiro(momento.totalMedio)} na média.`;
    partes.push(`<p class="veredito ${esc(momento.situacao)}"><span aria-hidden="true">${sinal}</span> ${texto}${conselho}</p>`);
  }

  // Depois o dia da semana. Sem base, diz que não sabe — e mostra o que falta.
  if (!semana.suficiente || !semana.melhor) {
    partes.push(`<p class="vazio">${esc(semana.motivo)}</p>`);
    if (semana.produtos) {
      partes.push(
        `<p class="legenda-grafico">Já são ${semana.diasObservados} dia(s) de histórico e ${semana.mudancas} mudança(s) de preço em ${semana.produtos} sabor(es).</p>`
      );
    }
  } else {
    partes.push(
      `<p class="melhor-dia"><span class="rotulo-melhor-dia">Melhor dia pra comprar</span><b>${esc(semana.melhor.nome)}</b></p>`,
      `<p class="legenda-grafico">Nos últimos ${semana.diasObservados} dias, os preços em ${esc(semana.melhor.nome)} ficaram <b>${porcento(semana.melhor.percentual)} abaixo</b> da média de cada sabor; o dia mais caro foi ${esc(semana.pior.nome)}. Base: ${semana.mudancas} mudanças de preço em ${semana.produtos} sabores, últimos ${janelaDias} dias.</p>`,
      reguaDosDias(semana)
    );
  }

  $('#conteudo-melhor-dia').innerHTML = partes.join('');
}

function desenharFechamento({ rodada, resumo }) {
  $('#titulo-fechamento').textContent = rodada.nome;
  $('#nome-rodada').value = rodada.nome;
  $('#recado-rodada').value = rodada.observacao || '';

  $('#numeros-fechamento').innerHTML = [
    ['Pessoas', resumo.pessoas.length],
    ['Caixas', resumo.totalCaixas],
    ['Cápsulas', resumo.totalCapsulas],
    ['Total', dinheiro(resumo.totalGeral)],
    ['Recebido', dinheiro(resumo.totalRecebido)],
    ['A receber', dinheiro(resumo.totalAReceber)]
  ]
    .map(([rotulo, valor]) => `<div class="num"><b>${esc(valor)}</b><span>${esc(rotulo)}</span></div>`)
    .join('');

  if (!resumo.produtos.length) {
    $('#tabela-compra').innerHTML = '<p class="vazio">Ninguém pediu nada ainda nesta rodada.</p>';
    $('#lista-pessoas').innerHTML = '<p class="vazio">Assim que alguém enviar um pedido, aparece aqui.</p>';
    return;
  }

  $('#tabela-compra').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Produto</th>
          <th class="num">Caixas</th>
          <th class="num">Unitário</th>
          <th class="num">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${resumo.produtos
          .map(
            (linha) => `
          <tr>
            <td>
              <div class="produto-linha">
                <span class="disco pequeno" style="--cor:${corDe(linha.categoria)}" aria-hidden="true"></span>
                <div>
                  ${esc(linha.nome)}
                  <div class="quem">${linha.pessoas.map((p) => `${esc(p.nome)} (${p.quantidade})`).join(' · ')}</div>
                </div>
              </div>
            </td>
            <td class="num">${linha.quantidade}</td>
            <td class="num">${dinheiro(linha.preco)}</td>
            <td class="num">${dinheiro(linha.subtotal)}</td>
          </tr>`
          )
          .join('')}
        <tr>
          <td><b>Total</b></td>
          <td class="num"><b>${resumo.totalCaixas}</b></td>
          <td></td>
          <td class="num"><b>${dinheiro(resumo.totalGeral)}</b></td>
        </tr>
      </tbody>
    </table>`;

  $('#lista-pessoas').innerHTML = resumo.pessoas
    .map((pessoa) => {
      const situacao = pessoa.confirmadoEm
        ? { classe: 'pago', texto: 'pago' }
        : pessoa.pagoEm
          ? { classe: 'avisou', texto: 'avisou que pagou' }
          : { classe: 'devendo', texto: 'não pagou' };

      return `
      <div class="pessoa ${situacao.classe}" data-usuario="${esc(pessoa.usuarioId)}">
        <h3>${esc(pessoa.nome)} <span class="situacao">${situacao.texto}</span></h3>
        <ul>${pessoa.itens.map((i) => `<li>${i.quantidade}× ${esc(i.nome)}</li>`).join('')}</ul>
        <div class="total-pessoa">${dinheiro(pessoa.total)}</div>
        ${
          pessoa.pagoEm && !pessoa.confirmadoEm
            ? `<p class="quem">Avisou em ${quandoFoi(pessoa.pagoEm)}.</p>`
            : ''
        }
        <label class="interruptor confirmar">
          <input type="checkbox" data-acao="confirmar" ${pessoa.confirmadoEm ? 'checked' : ''}>
          <span>Recebi o dinheiro</span>
        </label>
      </div>`;
    })
    .join('');
}

/**
 * Quem ficou devendo de rodadas já fechadas.
 *
 * Fechar a rodada para adiantar a compra não quer dizer que todo mundo pagou —
 * sem esta lista a cobrança sumia da tela junto com a rodada.
 */
function desenharPendencias(pendencias, total) {
  const bloco = $('#bloco-pendencias');
  if (!pendencias.length) {
    bloco.classList.add('escondido');
    return;
  }
  bloco.classList.remove('escondido');

  const pessoas = new Set(pendencias.map((p) => p.usuarioId)).size;
  $('#resumo-pendencias').textContent =
    `${dinheiro(total)} a receber de ${pessoas} pessoa${pessoas > 1 ? 's' : ''}, ` +
    `em ${pendencias.length} pedido${pendencias.length > 1 ? 's' : ''} de rodadas já fechadas.`;

  $('#lista-pendencias').innerHTML = pendencias
    .map(
      (p) => `
      <div class="pessoa ${p.pagoEm ? 'avisou' : 'devendo'}" data-usuario="${esc(p.usuarioId)}" data-rodada="${esc(p.rodada.id)}">
        <h3>${esc(p.nome)} <span class="situacao">${p.pagoEm ? 'avisou que pagou' : 'não pagou'}</span></h3>
        <p class="quem">${esc(p.rodada.nome)} · fechada em ${quandoFoi(p.rodada.fechadaEm)}</p>
        <ul>${p.itens.map((i) => `<li>${i.quantidade}× ${esc(i.nome)}</li>`).join('')}</ul>
        <div class="total-pessoa">${dinheiro(p.total)}</div>
        ${p.pagoEm ? `<p class="quem">Avisou em ${quandoFoi(p.pagoEm)}.</p>` : ''}
        <label class="interruptor confirmar">
          <input type="checkbox" data-acao="confirmar-pendencia">
          <span>Recebi o dinheiro</span>
        </label>
      </div>`
    )
    .join('');
}

function desenharHistorico(rodadas) {
  const anteriores = rodadas.filter((r) => !r.aberta);
  if (!anteriores.length) {
    $('#historico').innerHTML = '<p class="vazio">Nenhuma rodada fechada ainda.</p>';
    return;
  }
  $('#historico').innerHTML = `
    <table>
      <thead>
        <tr><th>Rodada</th><th>Fechada em</th><th class="num">Pessoas</th><th class="num">Caixas</th><th class="num">Total</th><th></th></tr>
      </thead>
      <tbody>
        ${anteriores
          .map(
            (r) => `
          <tr>
            <td>${esc(r.nome)}</td>
            <td>${quandoFoi(r.fechadaEm)}</td>
            <td class="num">${r.pessoas}</td>
            <td class="num">${r.caixas}</td>
            <td class="num">${dinheiro(r.total)}</td>
            <td class="num"><a href="#" class="baixar-csv" data-rodada="${esc(r.id)}">planilha</a></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function textoDaLista() {
  if (!fechamentoAtual) return '';
  const { rodada, resumo } = fechamentoAtual;
  const linhas = [
    `*${rodada.nome}* — lista de compra`,
    `${resumo.pessoas.length} pessoas · ${resumo.totalCaixas} caixas · ${dinheiro(resumo.totalGeral)}`,
    ''
  ];
  for (const produto of resumo.produtos) {
    linhas.push(`${produto.quantidade}x ${produto.nome} — ${dinheiro(produto.subtotal)}`);
    linhas.push(`   ${produto.pessoas.map((p) => `${p.nome} ${p.quantidade}`).join(', ')}`);
  }
  linhas.push('', 'Quanto cada um deve:');
  for (const pessoa of resumo.pessoas) linhas.push(`${pessoa.nome}: ${dinheiro(pessoa.total)}`);
  return linhas.join('\n');
}

async function copiarLista() {
  const texto = textoDaLista();
  if (!texto) return torradeira('Não tem nada pra copiar ainda.', true);
  try {
    await navigator.clipboard.writeText(texto);
    torradeira('Lista copiada.');
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    torradeira('Lista copiada.');
  }
}

async function salvarRodada() {
  try {
    await api('/api/rodadas/atual', {
      method: 'PATCH',
      corpo: { nome: $('#nome-rodada').value, observacao: $('#recado-rodada').value }
    });
    torradeira('Rodada atualizada.');
    await carregarSessao();
    carregarFechamento();
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

async function fecharRodada() {
  const nome = prompt('Nome da próxima rodada:', `Rodada de ${new Date().toLocaleDateString('pt-BR')}`);
  if (nome === null) return;
  try {
    await api('/api/rodadas/fechar', { method: 'POST', corpo: { proximaRodada: nome } });
    torradeira('Rodada fechada. A próxima já está aberta.');
    estado.pedido = null;
    estado.carrinho.clear();
    await carregarSessao();
    await carregarMeuPedido();
    desenharLoja();
    carregarFechamento();
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                            */
/* ------------------------------------------------------------------ */

function desenharEstadoSincronia(sincronizacao) {
  if (!sincronizacao) return;
  const quando = sincronizacao.ultima ? quandoFoi(sincronizacao.ultima) : 'ainda não';
  const texto =
    sincronizacao.situacao === 'ok'
      ? `Última leitura do site: ${quando}. ${sincronizacao.mensagem || ''}`
      : `${sincronizacao.mensagem || 'Sem leitura do site.'} Última leitura boa: ${quando}.`;
  $('#estado-sincronia').textContent = texto;
}

function desenharCatalogo() {
  const busca = estado.buscaCatalogo.trim().toLowerCase();
  const lista = estado.produtos.filter((p) => !busca || p.nome.toLowerCase().includes(busca));

  $('#tabela-catalogo').innerHTML = `
    <table>
      <thead>
        <tr><th>Produto</th><th>Categoria</th><th>Imagem</th><th class="num">Preço</th><th>Na lista</th><th>Estoque</th><th></th></tr>
      </thead>
      <tbody>
        ${lista
          .map(
            (produto) => `
          <tr data-id="${esc(produto.id)}">
            <td>
              <div class="produto-linha">
                <span class="disco pequeno" style="--cor:${corDe(produto.categoria)}" aria-hidden="true">${produto.imagem ? `<img src="${esc(produto.imagem)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
                <div>
                  ${esc(produto.nome)}
                  ${produto.foraDoSite ? '<div class="quem" style="color:var(--alerta)">saiu do site</div>' : ''}
                  ${produto.origem === 'manual' ? '<div class="quem">incluído na mão</div>' : ''}
                </div>
              </div>
            </td>
            <td>${esc(produto.categoria)}</td>
            <td><input data-campo="imagem" value="${esc(produto.imagem || '')}" placeholder="Link da foto (https://…)" style="width:190px;padding:5px 8px;border:1px solid var(--linha);border-radius:6px;font-family:var(--mono);font-size:12px"></td>
            <td class="num"><input data-campo="preco" value="${(Number(produto.preco) || 0).toFixed(2).replace('.', ',')}" style="width:82px;text-align:right;padding:5px 8px;border:1px solid var(--linha);border-radius:6px;font-family:var(--mono)"></td>
            <td><label class="interruptor"><input type="checkbox" data-campo="ativo" ${produto.ativo !== false ? 'checked' : ''}> mostrar</label></td>
            <td><label class="interruptor"><input type="checkbox" data-campo="disponivel" ${produto.disponivel !== false ? 'checked' : ''}> tem</label></td>
            <td class="num">${produto.origem === 'manual' ? '<button type="button" class="botao perigo miudo" data-acao="apagar">Apagar</button>' : ''}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

async function sincronizarCatalogo() {
  const botao = $('#botao-sincronizar');
  botao.disabled = true;
  botao.textContent = 'Lendo o site…';
  try {
    const dados = await api('/api/produtos/sincronizar', { method: 'POST' });
    estado.produtos = dados.produtos;
    desenharEstadoSincronia(dados.sincronizacao);
    desenharCatalogo();
    desenharLoja();
    torradeira(dados.sincronizacao.mensagem);
  } catch (falha) {
    torradeira(falha.message, true);
    await carregarProdutos();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Atualizar do site agora';
  }
}

async function alterarProduto(id, mudanca) {
  try {
    const atualizado = await api(`/api/produtos/${id}`, { method: 'PATCH', corpo: mudanca });
    const indice = estado.produtos.findIndex((p) => p.id === id);
    if (indice > -1) estado.produtos[indice] = atualizado;
    desenharLoja();
    if (estado.aba === 'catalogo') desenharCatalogo();
    torradeira('Catálogo salvo.');
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

async function incluirProduto() {
  const nome = $('#novo-nome').value.trim();
  const preco = $('#novo-preco').value;
  const capsulas = $('#novo-capsulas').value;
  if (!nome) return torradeira('Escreva o nome do produto.', true);
  try {
    await api('/api/produtos', { method: 'POST', corpo: { nome, preco, capsulas } });
    $('#novo-nome').value = '';
    $('#novo-preco').value = '';
    await carregarProdutos();
    desenharCatalogo();
    desenharLoja();
    torradeira('Produto incluído.');
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Pessoas                                                             */
/* ------------------------------------------------------------------ */

async function carregarPessoas() {
  const espremedor = estado.usuario && estado.usuario.papel === 'espremedor';
  $('#bloco-pessoas').classList.toggle('escondido', !espremedor);
  $('#titulo-conta').textContent = espremedor ? 'Pessoas' : 'Minha conta';
  $('#subtitulo-conta').textContent = espremedor
    ? 'Quem tem acesso e quem faz a compra.'
    : 'Troque sua senha ou gere seu código de recuperação.';
  desenharEstadoEmail();
  desenharEstadoRecuperacao();
  if (!espremedor) return;

  try {
    const dados = await api('/api/usuarios');
    $('#tabela-pessoas').innerHTML = `
      <table>
        <thead><tr><th>Nome</th><th>Perfil</th><th>E-mail</th><th>Desde</th><th></th></tr></thead>
        <tbody>
          ${dados.usuarios
            .map(
              (pessoa) => `
            <tr data-id="${esc(pessoa.id)}">
              <td>${esc(pessoa.nome)}</td>
              <td>
                <select data-acao="papel" style="padding:5px 8px;border:1px solid var(--linha);border-radius:6px">
                  <option value="usuario" ${pessoa.papel === 'usuario' ? 'selected' : ''}>usuário</option>
                  <option value="espremedor" ${pessoa.papel === 'espremedor' ? 'selected' : ''}>espremedor</option>
                </select>
              </td>
              <td>
                <input type="email" data-acao="email" autocomplete="off" spellcheck="false"
                       value="${esc(pessoa.email || '')}" data-valor="${esc(pessoa.email || '')}"
                       placeholder="sem e-mail"
                       style="width:100%;min-width:170px;padding:5px 8px;border:1px solid var(--linha);border-radius:6px;background:var(--papel)">
              </td>
              <td>${quandoFoi(pessoa.criadoEm)}</td>
              <td class="num">
                <button type="button" class="botao claro miudo" data-acao="senha">Redefinir senha</button>
                ${pessoa.id === estado.usuario.id ? '' : '<button type="button" class="botao perigo miudo" data-acao="remover">Remover</button>'}
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

async function trocarMinhaSenha() {
  const atual = $('#senha-atual').value;
  const nova = $('#senha-nova').value;
  if (!atual || !nova) return torradeira('Preencha as duas senhas.', true);
  try {
    const resposta = await api('/api/minha-senha', { method: 'POST', corpo: { atual, nova } });
    // O servidor derruba as sessões antigas e abre uma nova para este aparelho.
    // Sem guardar o token que volta, quem acabou de trocar a senha seria posto
    // para fora junto com os outros.
    if (resposta.token) guardarToken(resposta.token);
    $('#senha-atual').value = '';
    $('#senha-nova').value = '';
    torradeira('Senha trocada. Os outros aparelhos foram desconectados.');
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

function desenharEstadoEmail() {
  const atual = estado.usuario && estado.usuario.email;
  $('#estado-email').textContent = atual
    ? 'É para cá que vai o link quando você esquecer a senha.'
    : 'Você ainda não tem e-mail cadastrado — sem ele o link de "esqueci minha senha" não tem para onde ir.';
  $('#meu-email').value = atual || '';
}

async function salvarMeuEmail() {
  const endereco = $('#meu-email').value.trim();
  const senha = $('#senha-para-email').value;
  if (!senha) return torradeira('Confirme sua senha para trocar o e-mail.', true);

  const botao = $('#botao-salvar-email');
  botao.disabled = true;
  try {
    const dados = await api('/api/meu-email', { method: 'POST', corpo: { senha, email: endereco } });
    estado.usuario.email = dados.email;
    $('#senha-para-email').value = '';
    desenharEstadoEmail();
    torradeira(dados.email ? 'E-mail salvo.' : 'E-mail removido.');
  } catch (falha) {
    torradeira(falha.message, true);
  } finally {
    botao.disabled = false;
  }
}

function desenharEstadoRecuperacao() {
  const tem = Boolean(estado.usuario && estado.usuario.temRecuperacao);
  $('#estado-recuperacao').textContent = tem
    ? 'Você já tem um código guardado. Gerar outro faz o anterior deixar de valer — vale a pena se você acha que alguém o viu.'
    : 'Você ainda não tem código. Sem ele, esquecer a senha só se resolve pedindo a um espremedor.';
  $('#botao-gerar-codigo').textContent = tem ? 'Gerar outro código' : 'Gerar meu código';
}

async function gerarMeuCodigo() {
  const senha = $('#senha-para-codigo').value;
  if (!senha) return torradeira('Confirme sua senha para gerar o código.', true);

  const botao = $('#botao-gerar-codigo');
  botao.disabled = true;
  try {
    const dados = await api('/api/minha-recuperacao', { method: 'POST', corpo: { senha } });
    $('#senha-para-codigo').value = '';
    estado.usuario.temRecuperacao = true;
    desenharEstadoRecuperacao();
    mostrarCodigo(
      dados.recuperacao,
      dados.substituiu ? 'Seu novo código de recuperação' : 'Anote seu código de recuperação',
      dados.substituiu
        ? 'O código anterior não vale mais. Anote este no lugar dele.'
        : 'É o que devolve seu acesso se você esquecer a senha. Ele não aparece de novo.'
    );
  } catch (falha) {
    torradeira(falha.message, true);
  } finally {
    botao.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Carga inicial                                                       */
/* ------------------------------------------------------------------ */

async function carregarProdutos() {
  const dados = await api('/api/produtos');
  estado.produtos = dados.produtos;
  desenharEstadoSincronia(dados.sincronizacao);
}

async function carregarAnteriores() {
  try {
    const dados = await api('/api/minhas-rodadas');
    estado.anteriores = dados.rodadas;
  } catch {
    // Histórico é acessório: se falhar, a rodada aberta continua funcionando.
    estado.anteriores = [];
  }
}

async function carregarMeuPedido() {
  const dados = await api('/api/meu-pedido');
  estado.pedido = dados.pedido;
  estado.pix = dados.pix;
  estado.carrinho.clear();
  if (dados.pedido) {
    for (const item of dados.pedido.itens) estado.carrinho.set(item.produtoId, item.quantidade);
  }
}

async function carregarSessao() {
  const sessao = await api('/api/sessao');
  estado.usuario = sessao.usuario;
  estado.rodada = sessao.rodada;
  if (sessao.rodada) {
    $('#titulo-rodada').textContent = sessao.rodada.nome;
    $('#observacao-rodada').textContent =
      sessao.rodada.observacao || 'Escolha os sabores e a quantidade de caixas que você quer.';
  }
  return sessao;
}

async function iniciar() {
  // O link do e-mail manda para cá com o token na barra de endereços. Ele passa
  // na frente de tudo: quem clicou quer trocar a senha, mesmo que ainda haja
  // uma sessão velha aberta neste navegador.
  const daUrl = new URLSearchParams(location.search).get('redefinir');
  if (daUrl) {
    tokenDoLink = daUrl;
    return abrirNovaSenha(daUrl);
  }

  const sessao = await carregarSessao();

  if (!sessao.usuario) {
    $('#tela-app').classList.add('escondido');
    $('#tela-entrada').classList.remove('escondido');
    mostrarPainelEntrada('acesso');
    if (sessao.primeiroAcesso) {
      modoEntrada = 'criar';
      ajustarEntrada();
      $('#dica-entrada').textContent =
        'Ninguém se cadastrou ainda. O primeiro acesso criado vira o espremedor da turma.';
      // Sem ninguém cadastrado não há senha a recuperar.
      $('#abrir-recuperacao').classList.add('escondido');
    } else {
      ajustarEntrada();
      $('#abrir-recuperacao').classList.remove('escondido');
    }
    $('#campo-nome').focus();
    return;
  }

  $('#tela-entrada').classList.add('escondido');
  $('#tela-app').classList.remove('escondido');
  $('#nome-usuario').textContent = sessao.usuario.nome;

  const espremedor = sessao.usuario.papel === 'espremedor';
  $('#selo-espremedor').classList.toggle('escondido', !espremedor);
  for (const elemento of $$('.so-espremedor')) elemento.classList.toggle('escondido', !espremedor);

  await carregarProdutos();
  await carregarMeuPedido();
  await carregarAnteriores();
  desenharLoja();
  trocarAba('loja');
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

$('#aba-entrar').addEventListener('click', () => {
  modoEntrada = 'entrar';
  ajustarEntrada();
});
$('#aba-criar').addEventListener('click', () => {
  modoEntrada = 'criar';
  ajustarEntrada();
});

// O submit do form cobre o clique no botão e o Enter em qualquer campo, e é o
// que faz o navegador oferecer para guardar a senha.
$('#forma-entrada').addEventListener('submit', enviarEntrada);
$('#forma-recuperacao').addEventListener('submit', enviarRecuperacao);

$('#forma-esqueci').addEventListener('submit', enviarEsqueci);
$('#forma-nova-senha').addEventListener('submit', enviarNovaSenha);

$('#abrir-recuperacao').addEventListener('click', () => mostrarPainelEntrada('recuperacao'));
$('#abrir-codigo').addEventListener('click', mostrarFormularioDoCodigo);
$('#voltar-entrada').addEventListener('click', () => mostrarPainelEntrada('acesso'));

$('#voltar-da-nova-senha').addEventListener('click', () => {
  // Sai do link e volta à entrada normal, sem o token pendurado na URL.
  tokenDoLink = null;
  history.replaceState(null, '', location.pathname);
  iniciar();
});

$('#botao-salvar-email').addEventListener('click', salvarMeuEmail);

/** O olho que mostra a senha. Ajuda em teclado de celular, onde errar é fácil. */
for (const botao of $$('.olho')) {
  botao.addEventListener('click', () => {
    const campo = $(`#${botao.dataset.ver}`);
    const escondida = campo.type === 'password';
    campo.type = escondida ? 'text' : 'password';
    botao.setAttribute('aria-pressed', String(escondida));
    botao.setAttribute('aria-label', escondida ? 'Esconder a senha' : 'Mostrar a senha');
    campo.focus();
  });
}

/**
 * Vai pondo os traços conforme a pessoa digita o código.
 *
 * O traço só entra depois de um grupo de 4 que tenha algo em seguida, senão
 * apagar o último caractere recolocaria o traço e o campo travaria.
 */
$('#rec-codigo').addEventListener('input', (evento) => {
  const limpo = evento.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 16);
  evento.target.value = limpo.replace(/(.{4})(?=.)/g, '$1-');
});

$('#guardei-codigo').addEventListener('click', () => $('#janela-codigo').close());

$('#copiar-codigo').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codigoNaTela);
    torradeira('Código copiado. Guarde num lugar que você lembre.');
  } catch {
    prompt('Copie seu código de recuperação:', codigoNaTela);
  }
});

$('#botao-gerar-codigo').addEventListener('click', gerarMeuCodigo);

$('#navegacao').addEventListener('click', (evento) => {
  const botao = evento.target.closest('button[data-aba]');
  if (botao) trocarAba(botao.dataset.aba);
});

$('#botao-sair').addEventListener('click', async () => {
  await api('/api/sair', { method: 'POST' }).catch(() => {});
  guardarToken(null);
  estado.usuario = null;
  estado.carrinho.clear();
  estado.pedido = null;
  await iniciar();
});

$('#busca').addEventListener('input', (evento) => {
  estado.busca = evento.target.value;
  desenharGrade();
});

$('#fichas-categorias').addEventListener('click', (evento) => {
  const botao = evento.target.closest('button[data-categoria]');
  if (!botao) return;
  estado.categoria = botao.dataset.categoria;
  desenharFichas();
  desenharGrade();
});

$('#grade-produtos').addEventListener('click', (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const cartao = botao.closest('.cartao');
  if (botao.dataset.acao === 'historico') return abrirHistoricoDePreco(cartao.dataset.id);
  mudarQuantidade(cartao.dataset.id, botao.dataset.acao === 'mais' ? 1 : -1);
});

$('#fechar-historico').addEventListener('click', () => $('#janela-historico').close());

// Clique fora do conteúdo fecha a janela. O <dialog> entrega o clique no fundo
// como se fosse nele mesmo, então comparar o alvo basta — e o Esc já vem de graça.
$('#janela-historico').addEventListener('click', (evento) => {
  if (evento.target === $('#janela-historico')) $('#janela-historico').close();
});

$('#botao-enviar').addEventListener('click', enviarPedido);
$('#botao-cancelar').addEventListener('click', cancelarPedido);

$('#lista-anteriores').addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const caixa = botao.closest('.rodada-anterior');
  const rodadaId = caixa.dataset.rodada;
  const rodada = estado.anteriores.find((r) => r.rodada.id === rodadaId);
  if (!rodada) return;

  if (botao.dataset.acao === 'copiar-pix') {
    try {
      await navigator.clipboard.writeText(rodada.pix.brcode);
      torradeira('Código Pix copiado. Cole no seu banco.');
    } catch {
      prompt('Copie o código Pix:', rodada.pix.brcode);
    }
    return;
  }

  botao.disabled = true;
  try {
    await api('/api/meu-pedido/pagamento', {
      method: 'POST',
      corpo: { pago: !rodada.pagoEm, rodada: rodadaId }
    });
    torradeira(rodada.pagoEm ? 'Aviso de pagamento desfeito.' : 'Avisado. O espremedor vai confirmar.');
    await carregarAnteriores();
    desenharAnteriores();
    pedirAjusteDoPainel();
  } catch (falha) {
    botao.disabled = false;
    torradeira(falha.message, true);
  }
});

window.addEventListener('scroll', pedirAjusteDoPainel, { passive: true });
window.addEventListener('resize', pedirAjusteDoPainel);

$('#botao-paguei').addEventListener('click', async () => {
  const botao = $('#botao-paguei');
  botao.disabled = true;
  try {
    const resposta = await api('/api/meu-pedido/pagamento', {
      method: 'POST',
      corpo: { pago: !estado.pedido.pagoEm }
    });
    estado.pedido = resposta.pedido;
    desenharPagamento();
    torradeira(resposta.pedido.pagoEm ? 'Avisado. O espremedor vai confirmar.' : 'Aviso de pagamento desfeito.');
  } catch (falha) {
    botao.disabled = false;
    torradeira(falha.message, true);
  }
});

$('#botao-copiar-pix').addEventListener('click', async () => {
  if (!estado.pix) return;
  try {
    await navigator.clipboard.writeText(estado.pix.brcode);
    torradeira('Código Pix copiado. Cole no seu banco.');
  } catch {
    // Sem permissão para a área de transferência: mostra o código para copiar na mão.
    prompt('Copie o código Pix:', estado.pix.brcode);
  }
});

$('#lista-pessoas').addEventListener('change', async (evento) => {
  const caixa = evento.target.closest('input[data-acao="confirmar"]');
  if (!caixa) return;
  const cartao = caixa.closest('.pessoa');
  caixa.disabled = true;
  try {
    await api(`/api/pedidos/${cartao.dataset.usuario}/pagamento`, {
      method: 'PATCH',
      corpo: { confirmado: caixa.checked }
    });
    torradeira(caixa.checked ? 'Pagamento confirmado.' : 'Confirmação desfeita.');
    await carregarFechamento();
  } catch (falha) {
    caixa.checked = !caixa.checked;
    caixa.disabled = false;
    torradeira(falha.message, true);
  }
});

$('#lista-rastreio').addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const caixa = botao.closest('.rastreio-rodada');
  const limpando = botao.dataset.acao === 'limpar-rastreio';
  const campo = caixa.querySelector('input[data-campo="rastreio"]');

  botao.disabled = true;
  try {
    await api(`/api/rodadas/${caixa.dataset.rodada}/rastreio`, {
      method: 'PUT',
      corpo: { rastreio: limpando ? '' : campo.value }
    });
    torradeira(limpando ? 'Código removido.' : 'Código de rastreio salvo.');
    await carregarRastreio();
  } catch (falha) {
    botao.disabled = false;
    torradeira(falha.message, true);
  }
});

$('#lista-rastreio').addEventListener('keydown', (evento) => {
  if (evento.key !== 'Enter') return;
  const campo = evento.target.closest('input[data-campo="rastreio"]');
  if (!campo) return;
  evento.preventDefault();
  campo.closest('.rastreio-rodada').querySelector('button[data-acao="salvar-rastreio"]').click();
});

$('#lista-pendencias').addEventListener('change', async (evento) => {
  const caixa = evento.target.closest('input[data-acao="confirmar-pendencia"]');
  if (!caixa) return;
  const cartao = caixa.closest('.pessoa');
  caixa.disabled = true;
  try {
    await api(`/api/pedidos/${cartao.dataset.usuario}/pagamento`, {
      method: 'PATCH',
      corpo: { confirmado: caixa.checked, rodada: cartao.dataset.rodada }
    });
    torradeira(caixa.checked ? 'Pagamento confirmado.' : 'Confirmação desfeita.');
    await carregarFechamento();
  } catch (falha) {
    caixa.checked = !caixa.checked;
    caixa.disabled = false;
    torradeira(falha.message, true);
  }
});

$('#botao-copiar').addEventListener('click', copiarLista);
$('#link-csv').addEventListener('click', () => baixarCsv(null));

$('#historico').addEventListener('click', (evento) => {
  const link = evento.target.closest('.baixar-csv');
  if (!link) return;
  evento.preventDefault();
  baixarCsv(link.dataset.rodada);
});

$('#botao-salvar-rodada').addEventListener('click', salvarRodada);
$('#botao-fechar-rodada').addEventListener('click', fecharRodada);

$('#botao-sincronizar').addEventListener('click', sincronizarCatalogo);
$('#botao-novo-produto').addEventListener('click', incluirProduto);
$('#busca-catalogo').addEventListener('input', (evento) => {
  estado.buscaCatalogo = evento.target.value;
  desenharCatalogo();
});

$('#tabela-catalogo').addEventListener('change', (evento) => {
  const linha = evento.target.closest('tr[data-id]');
  if (!linha) return;
  const campo = evento.target.dataset.campo;
  if (campo === 'ativo' || campo === 'disponivel') {
    alterarProduto(linha.dataset.id, { [campo]: evento.target.checked });
  } else if (campo === 'preco') {
    alterarProduto(linha.dataset.id, { preco: evento.target.value });
  } else if (campo === 'imagem') {
    alterarProduto(linha.dataset.id, { imagem: evento.target.value });
  }
});

$('#tabela-catalogo').addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao="apagar"]');
  if (!botao) return;
  const linha = botao.closest('tr[data-id]');
  if (!confirm('Apagar este item do catálogo?')) return;
  try {
    await api(`/api/produtos/${linha.dataset.id}`, { method: 'DELETE' });
    await carregarProdutos();
    desenharCatalogo();
    desenharLoja();
    torradeira('Item apagado.');
  } catch (falha) {
    torradeira(falha.message, true);
  }
});

$('#tabela-pessoas').addEventListener('change', async (evento) => {
  const linha = evento.target.closest('tr[data-id]');
  const acao = evento.target.dataset.acao;
  if (!linha || (acao !== 'papel' && acao !== 'email')) return;

  // O e-mail é o destino do link de "esqueci minha senha" — por isso o
  // espremedor consegue arrumar o de quem digitou torto ou trocou de endereço.
  if (acao === 'email') {
    const campo = evento.target;
    const endereco = campo.value.trim();
    // O evento também dispara ao sair do campo sem ter mexido em nada.
    if (endereco === (campo.dataset.valor || '')) return;
    try {
      const dados = await api(`/api/usuarios/${linha.dataset.id}`, {
        method: 'PATCH',
        corpo: { email: endereco }
      });
      campo.value = dados.usuario.email || '';
      campo.dataset.valor = dados.usuario.email || '';
      if (linha.dataset.id === estado.usuario.id) {
        estado.usuario.email = dados.usuario.email;
        desenharEstadoEmail();
      }
      torradeira(dados.usuario.email ? 'E-mail atualizado.' : 'E-mail removido.');
    } catch (falha) {
      torradeira(falha.message, true);
      campo.value = campo.dataset.valor || '';
    }
    return;
  }

  try {
    await api(`/api/usuarios/${linha.dataset.id}`, { method: 'PATCH', corpo: { papel: evento.target.value } });
    torradeira('Perfil atualizado.');
    if (linha.dataset.id === estado.usuario.id) await iniciar();
  } catch (falha) {
    torradeira(falha.message, true);
    carregarPessoas();
  }
});

$('#tabela-pessoas').addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const linha = botao.closest('tr[data-id]');
  try {
    if (botao.dataset.acao === 'senha') {
      const nova = prompt('Nova senha para essa pessoa (mínimo 4 caracteres):');
      if (!nova) return;
      await api(`/api/usuarios/${linha.dataset.id}`, { method: 'PATCH', corpo: { novaSenha: nova } });
      torradeira('Senha redefinida.');
    } else if (botao.dataset.acao === 'remover') {
      if (!confirm('Remover o acesso dessa pessoa?')) return;
      await api(`/api/usuarios/${linha.dataset.id}`, { method: 'DELETE' });
      torradeira('Acesso removido.');
      carregarPessoas();
    }
  } catch (falha) {
    torradeira(falha.message, true);
  }
});

$('#botao-trocar-senha').addEventListener('click', trocarMinhaSenha);

iniciar().catch((falha) => {
  document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif">Não deu para falar com o servidor: ${esc(falha.message)}</p>`;
});
