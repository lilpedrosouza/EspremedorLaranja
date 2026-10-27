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
    // Servidor sem e-mail configurado, ou conta sem e-mail cadastrado: o
    // caminho do código é o que resta.
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
  for (const nome of ['loja', 'rastreio', 'fechamento', 'catalogo', 'sorteio', 'pessoas']) {
    $(`#aba-${nome}`).classList.toggle('escondido', nome !== aba);
  }
  if (aba === 'rastreio') carregarRastreio();
  if (aba === 'fechamento') carregarFechamento();
  if (aba === 'catalogo') desenharCatalogo();
  if (aba === 'sorteio') carregarSorteio(sorteio.rodadaEscolhida);
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
    await carregarEntrega(historico.rodadas);
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

/**
 * Entrega: o que separar pra cada pessoa quando a compra chega.
 *
 * Quando as caixas chegam a rodada normalmente já foi fechada, então a lista não
 * pode ficar presa à rodada aberta: por padrão vai a última fechada com pedido.
 */
const entrega = { rodadaId: null, rodadas: [], rodada: null, resumo: null, busca: '' };

async function carregarEntrega(rodadas, rodadaId) {
  if (rodadas) entrega.rodadas = rodadas;
  const existe = (id) => entrega.rodadas.some((r) => r.id === id);
  const padrao =
    entrega.rodadas.find((r) => !r.aberta && r.pessoas > 0) || entrega.rodadas.find((r) => r.aberta) || entrega.rodadas[0];
  entrega.rodadaId = existe(rodadaId) ? rodadaId : existe(entrega.rodadaId) ? entrega.rodadaId : padrao && padrao.id;

  $('#rodada-entrega').innerHTML = entrega.rodadas
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === entrega.rodadaId ? 'selected' : ''}>${esc(r.nome)}${r.aberta ? ' (aberta)' : ''} — ${r.pessoas} pessoa${r.pessoas === 1 ? '' : 's'}</option>`
    )
    .join('');

  if (!entrega.rodadaId) {
    entrega.resumo = null;
    return desenharEntrega();
  }
  try {
    const dados = await api(`/api/rodadas/${encodeURIComponent(entrega.rodadaId)}`);
    entrega.rodada = dados.rodada;
    entrega.resumo = dados.resumo;
  } catch (falha) {
    entrega.resumo = null;
    torradeira(falha.message, true);
  }
  desenharEntrega();
}

function desenharEntrega() {
  const resumo = entrega.resumo;
  if (!resumo || !resumo.pessoas.length) {
    $('#progresso-entrega').innerHTML = '';
    $('#lista-entrega').innerHTML = '<p class="vazio">Ninguém pediu nada nesta rodada.</p>';
    return;
  }

  const entregues = resumo.pessoas.filter((p) => p.entregueEm).length;
  const total = resumo.pessoas.length;
  $('#progresso-entrega').innerHTML = `
    <span><b>${entregues}</b> de ${total} entregue${total === 1 ? '' : 's'} · ${resumo.totalCaixas} caixa${resumo.totalCaixas === 1 ? '' : 's'} na rodada</span>
    <span class="trilho-entrega" aria-hidden="true"><i style="width:${((entregues / total) * 100).toFixed(1)}%"></i></span>`;

  const busca = semAcentoTela(entrega.busca.trim());
  const visiveis = resumo.pessoas
    .filter((p) => !busca || semAcentoTela(p.nome).includes(busca))
    // Quem falta receber fica em cima; quem já levou desce e apaga.
    .sort((a, b) => Boolean(a.entregueEm) - Boolean(b.entregueEm));

  if (!visiveis.length) {
    $('#lista-entrega').innerHTML = '<p class="vazio">Ninguém com esse nome nesta rodada.</p>';
    return;
  }

  $('#lista-entrega').innerHTML = visiveis
    .map((pessoa) => {
      const caixas = pessoa.itens.reduce((soma, i) => soma + i.quantidade, 0);
      const pagamento = pessoa.confirmadoEm
        ? { classe: 'pago', texto: 'pago' }
        : pessoa.pagoEm
          ? { classe: 'avisou', texto: 'avisou que pagou' }
          : { classe: 'devendo', texto: 'não pagou' };
      return `
      <div class="pessoa cartao-entrega ${pessoa.entregueEm ? 'entregue' : ''}" data-usuario="${esc(pessoa.usuarioId)}">
        <h3>${esc(pessoa.nome)} <span class="situacao ${pagamento.classe}">${pagamento.texto}</span></h3>
        <ul class="itens-entrega">
          ${pessoa.itens
            .map(
              (i) => `
            <li>
              <b class="qtd-entrega">${i.quantidade}×</b>
              <span class="disco pequeno" style="--cor:${corDe(i.categoria)}" aria-hidden="true"></span>
              <span>${esc(i.nome)}</span>
            </li>`
            )
            .join('')}
        </ul>
        <div class="rodape-entrega">
          <span>${caixas} caixa${caixas === 1 ? '' : 's'} · ${dinheiro(pessoa.total)}</span>
          <label class="interruptor">
            <input type="checkbox" data-acao="entregar" ${pessoa.entregueEm ? 'checked' : ''}>
            <span>Entregue</span>
          </label>
        </div>
        ${pessoa.entregueEm ? `<p class="quem">Entregue em ${quandoFoi(pessoa.entregueEm)}.</p>` : ''}
      </div>`;
    })
    .join('');
}

/** Só pra busca: "joao" acha "João". */
function semAcentoTela(texto) {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function imprimirEntrega() {
  document.body.classList.add('imprimindo-entrega');
  window.addEventListener('afterprint', () => document.body.classList.remove('imprimindo-entrega'), { once: true });
  window.print();
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
              <td>
                <input data-acao="nome" autocomplete="off" spellcheck="false" aria-label="Nome de ${esc(pessoa.nome)}"
                       value="${esc(pessoa.nome)}" data-valor="${esc(pessoa.nome)}"
                       style="width:100%;min-width:140px;padding:5px 8px;border:1px solid var(--linha);border-radius:6px;background:var(--papel);font-weight:600">
              </td>
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
/* Sorteio de brindes                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tons da laranja, alternando claro e escuro para que duas fatias vizinhas
 * nunca se confundam. Cada tom vem com a cor de texto que dá contraste nele.
 */
const FATIAS = [
  { fundo: '#f5811f', texto: '#2a1406' },
  { fundo: '#7a2f08', texto: '#fff4e8' },
  { fundo: '#ffc58a', texto: '#4a2408' },
  { fundo: '#2f7d45', texto: '#ffffff' },
  { fundo: '#c25211', texto: '#fff4e8' },
  { fundo: '#ffe3c2', texto: '#5a2c0a' },
  { fundo: '#a8410a', texto: '#fff4e8' },
  { fundo: '#7cc48a', texto: '#10331a' }
];

// Medidas no sistema do viewBox (-200 a 200). A tela escala tudo junto.
const RAIO_RODA = 172;
const RAIO_PINOS = 163;
const RAIO_MIOLO = 46;
const PIVO_PONTEIRO = -184;
const DEFLEXAO_MAXIMA = 26; // graus que o ponteiro deita quando um pino o empurra
const LAMPADAS = 20;
const CHAVE_SOM = 'espremedor_som_sorteio';

const sorteio = {
  dados: null,
  rodadaEscolhida: null,
  marcados: new Set(),
  fatias: 0,
  rotacao: 0,
  ponteiro: 0,
  alvoPonteiro: 0,
  velPonteiro: 0,
  movimento: null,
  quadro: null,
  ultimoQuadro: 0,
  ultimoTique: 0,
  girando: false,
  som: lerPreferenciaDeSom(),
  audio: null
};

const mod = (valor, divisor) => ((valor % divisor) + divisor) % divisor;
const esperar = (ms) => new Promise((pronto) => setTimeout(pronto, ms));

function movimentoReduzido() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** "Ana", "Ana e Bia", "Ana, Bia e Caio". */
function nomesComE(nomes) {
  if (nomes.length < 2) return nomes.join('');
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

function participantesDaRoda() {
  if (!sorteio.dados) return [];
  return sorteio.dados.candidatos.filter((c) => sorteio.marcados.has(c.usuarioId));
}

function corDaFatia(indice, total) {
  // Com a paleta dando a volta, a última fatia pode cair na mesma cor da
  // primeira — e as duas são vizinhas na roda. Aí a última pega outro tom.
  if (total > 1 && indice === total - 1 && indice % FATIAS.length === 0) return FATIAS[3];
  return FATIAS[indice % FATIAS.length];
}

/** Ângulo em graus, contado do topo no sentido do relógio, como na roleta. */
function ponto(angulo, raio) {
  const radianos = (angulo * Math.PI) / 180;
  return [(raio * Math.sin(radianos)).toFixed(2), (-raio * Math.cos(radianos)).toFixed(2)];
}

/** O nome que cabe na fatia: inteiro, depois "Pedro S.", por último cortado. */
function nomeNaFatia(nome, maximo) {
  const limpo = String(nome).trim().replace(/\s+/g, ' ');
  if (limpo.length <= maximo) return limpo;
  const partes = limpo.split(' ');
  const curto = partes.length > 1 ? `${partes[0]} ${partes[partes.length - 1][0]}.` : limpo;
  if (curto.length <= maximo) return curto;
  return `${limpo.slice(0, Math.max(1, maximo - 1))}…`;
}

/**
 * O aro com as lâmpadas, o brilho e o ponteiro. Nada disso gira: só a roda do
 * meio se mexe, e o brilho parado por cima é o que dá a impressão de vidro.
 */
function desenharMoldura() {
  const lampadas = Array.from({ length: LAMPADAS }, (_, i) => {
    const [x, y] = ponto((360 / LAMPADAS) * i, 185);
    return `<circle class="lampada ${i % 2 ? 'impar' : 'par'}" cx="${x}" cy="${y}" r="4.4"/>`;
  }).join('');

  $('#moldura-roleta').innerHTML = `
    <defs>
      <linearGradient id="aro-roleta" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#d4620d"/>
        <stop offset="1" stop-color="#6b2706"/>
      </linearGradient>
    </defs>
    <circle r="198" fill="url(#aro-roleta)"/>
    <circle r="196" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.5"/>
    <circle r="${RAIO_RODA + 1.5}" fill="#3a1604"/>
    <g class="lampadas">${lampadas}</g>`;

  $('#frente-roleta').innerHTML = `
    <defs>
      <radialGradient id="sombra-borda" r="0.5">
        <stop offset="0.8" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.24"/>
      </radialGradient>
      <radialGradient id="brilho-roleta" cx="0.32" cy="0.24" r="0.58">
        <stop offset="0" stop-color="#fff" stop-opacity="0.34"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <filter id="sombra-ponteiro" x="-80%" y="-30%" width="260%" height="160%">
        <feDropShadow dx="0" dy="2.5" stdDeviation="2" flood-color="#2a1406" flood-opacity="0.45"/>
      </filter>
    </defs>
    <circle r="${RAIO_RODA}" fill="url(#sombra-borda)"/>
    <circle r="${RAIO_RODA}" fill="url(#brilho-roleta)"/>
    <g id="ponteiro" filter="url(#sombra-ponteiro)">
      <path d="M0 -146 L-10.5 -178 A12 12 0 1 1 10.5 -178 Z" fill="#1d1f22"/>
      <path d="M-1.5 -154 L-6.5 -175" stroke="rgba(255,255,255,.22)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="0" cy="${PIVO_PONTEIRO}" r="4.6" fill="#f5811f"/>
    </g>`;
}

function desenharRoda() {
  const lista = participantesDaRoda();
  const roda = $('#roda');
  sorteio.fatias = lista.length;

  if (!lista.length) {
    // Sem fatia não há o que girar, e o texto precisa ficar em pé.
    sorteio.rotacao = 0;
    roda.innerHTML = `
      <circle r="${RAIO_RODA}" fill="#f4f0eb"/>
      <circle r="${RAIO_RODA - 24}" fill="none" stroke="#e2d9cf" stroke-width="1.5" stroke-dasharray="3 7"/>
      <text class="roda-vazia" y="${-(RAIO_MIOLO + 40)}" text-anchor="middle">Marque quem participa</text>`;
    aplicarRotacao();
    ligarQuadros();
    return;
  }

  const total = lista.length;
  const fatia = 360 / total;
  // A letra acompanha a largura da fatia, e o nome corta no que sobra entre o
  // miolo e a borda.
  const letra = Math.max(9, Math.min(15, ((Math.PI / 180) * fatia * 118) * 0.42));
  const cabe = Math.max(3, Math.floor((RAIO_RODA - 18 - (RAIO_MIOLO + 10)) / (letra * 0.56)));

  const fatias = lista
    .map((pessoa, i) => {
      const cor = corDaFatia(i, total);
      let forma;
      if (total === 1) {
        forma = `<circle r="${RAIO_RODA}" fill="${cor.fundo}"/>`;
      } else {
        const [x0, y0] = ponto(i * fatia, RAIO_RODA);
        const [x1, y1] = ponto((i + 1) * fatia, RAIO_RODA);
        forma = `<path d="M0 0 L${x0} ${y0} A${RAIO_RODA} ${RAIO_RODA} 0 ${fatia > 180 ? 1 : 0} 1 ${x1} ${y1} Z" fill="${cor.fundo}"/>`;
      }
      const meio = i * fatia + fatia / 2;
      return `
        <g class="fatia" data-usuario="${esc(pessoa.usuarioId)}">
          ${forma}
          <g transform="rotate(${(meio - 90).toFixed(3)})">
            <text x="${RAIO_RODA - 18}" y="0" text-anchor="end" dominant-baseline="central"
                  fill="${cor.texto}" font-size="${letra.toFixed(1)}">${esc(nomeNaFatia(pessoa.nome, cabe))}</text>
          </g>
        </g>`;
    })
    .join('');

  const divisoes =
    total > 1
      ? lista
          .map((_, i) => {
            const [x, y] = ponto(i * fatia, RAIO_RODA);
            return `<line x1="0" y1="0" x2="${x}" y2="${y}"/>`;
          })
          .join('')
      : '';
  const pinos = lista
    .map((_, i) => {
      const [x, y] = ponto(i * fatia, RAIO_PINOS);
      return `<circle cx="${x}" cy="${y}" r="3.6"/>`;
    })
    .join('');

  roda.innerHTML = `
    ${fatias}
    <g class="divisoes">${divisoes}</g>
    <g class="pinos">${pinos}</g>
    <circle class="anel-miolo" r="${RAIO_MIOLO + 7}"/>`;
  aplicarRotacao();
  // Com pinos em outro lugar, o ponteiro pode ter ficado encostado num deles.
  ligarQuadros();
}

function aplicarRotacao() {
  $('#roda').style.transform = `rotate(${sorteio.rotacao.toFixed(3)}deg)`;
  const ponteiro = $('#ponteiro');
  if (ponteiro) ponteiro.setAttribute('transform', `rotate(${sorteio.ponteiro.toFixed(2)} 0 ${PIVO_PONTEIRO})`);
}

/* ---- movimento ---- */

const suave = (t) => 0.5 - Math.cos(Math.PI * t) / 2;

/**
 * Arrancada curta e freio longo.
 *
 * A velocidade sobe em linha reta nos primeiros 6% do tempo (o empurrão da mão)
 * e depois cai ao cubo até zero. O fim é que dá o suspense: nos últimos
 * segundos a roda se arrasta pino a pino. A posição é a integral dessa
 * velocidade, dividida pelo total para terminar exatamente em 1.
 */
function arrancadaEFreio(t) {
  const arranque = 0.06;
  const total = arranque / 2 + (1 - arranque) / 4;
  if (t < arranque) return (t * t) / (2 * arranque) / total;
  const resto = (t - arranque) / (1 - arranque);
  return (arranque / 2 + ((1 - arranque) * (1 - Math.pow(1 - resto, 4))) / 4) / total;
}

function moverRoda(ate, duracao, curva) {
  return new Promise((terminar) => {
    sorteio.movimento = { de: sorteio.rotacao, ate, inicio: performance.now(), duracao, curva, terminar };
    ligarQuadros();
  });
}

function ligarQuadros() {
  if (sorteio.quadro) return;
  sorteio.ultimoQuadro = performance.now();
  sorteio.quadro = requestAnimationFrame(quadroDaRoleta);
}

/**
 * Um quadro da animação. Tudo é calculado pelo relógio, e não por quadro
 * contado: em tela de 60 Hz ou de 144 Hz a roda leva o mesmo tempo e para no
 * mesmo lugar. O laço se desliga sozinho quando roda e ponteiro sossegam.
 */
function quadroDaRoleta(agora) {
  const dt = Math.min(0.05, Math.max(0, (agora - sorteio.ultimoQuadro) / 1000));
  sorteio.ultimoQuadro = agora;
  const antes = sorteio.rotacao;

  const movimento = sorteio.movimento;
  if (movimento) {
    const t = Math.min(1, Math.max(0, (agora - movimento.inicio) / movimento.duracao));
    sorteio.rotacao = movimento.de + (movimento.ate - movimento.de) * movimento.curva(t);
    if (t >= 1) {
      sorteio.movimento = null;
      movimento.terminar();
    }
  }

  const velocidade = dt ? (sorteio.rotacao - antes) / dt : 0;
  atualizarPonteiro(velocidade, dt);
  tiqueSePassouPino(antes, sorteio.rotacao);
  aplicarRotacao();

  const sossegou =
    !sorteio.movimento &&
    Math.abs(sorteio.velPonteiro) < 0.4 &&
    Math.abs(sorteio.ponteiro - sorteio.alvoPonteiro) < 0.05;
  sorteio.quadro = sossegou ? null : requestAnimationFrame(quadroDaRoleta);
}

/**
 * O ponteiro de verdade: o pino que chega empurra a ponta, e quando escapa ela
 * volta numa mola, com um balanço de sobra. Rápido demais para voltar entre um
 * pino e outro, o ponteiro fica deitado e tremendo, como numa roleta de feira.
 *
 * A roda gira no sentido do relógio, então o pino que vem chegando está à
 * esquerda do ponteiro: é quando a posição dentro da fatia vai chegando a zero.
 */
function atualizarPonteiro(velocidade, dt) {
  let alvo = 0;
  let empurrado = false;

  if (sorteio.fatias) {
    const fatia = 360 / sorteio.fatias;
    const posicao = mod(-sorteio.rotacao, fatia);
    const contato = Math.min(fatia * 0.4, 7);
    const pinosPorSegundo = Math.abs(velocidade) / fatia;

    if (pinosPorSegundo > 14) {
      alvo = -Math.sign(velocidade) * DEFLEXAO_MAXIMA * (0.5 + Math.random() * 0.14);
    } else if (velocidade >= 0 && posicao < contato) {
      alvo = -DEFLEXAO_MAXIMA * (1 - posicao / contato);
      empurrado = true;
    } else if (velocidade < 0 && fatia - posicao < contato) {
      // Girando para trás (a puxada antes do arranque), o pino vem do outro lado.
      alvo = DEFLEXAO_MAXIMA * (1 - (fatia - posicao) / contato);
      empurrado = true;
    }
  }

  const alemDoAtual = alvo < 0 ? alvo < sorteio.ponteiro : alvo > sorteio.ponteiro;
  if (empurrado && alemDoAtual) {
    // O pino manda: a ponta vai junto com ele, sem mola.
    sorteio.ponteiro = alvo;
    sorteio.velPonteiro = 0;
  } else {
    const mola = 320;
    const amortecimento = 15;
    sorteio.velPonteiro += ((alvo - sorteio.ponteiro) * mola - sorteio.velPonteiro * amortecimento) * dt;
    sorteio.ponteiro += sorteio.velPonteiro * dt;
  }
  sorteio.alvoPonteiro = alvo;
}

function tiqueSePassouPino(antes, depois) {
  if (!sorteio.fatias || antes === depois) return;
  const fatia = 360 / sorteio.fatias;
  if (Math.floor(-antes / fatia) === Math.floor(-depois / fatia)) return;
  // Na velocidade máxima passam dezenas de pinos por segundo. Um tique por
  // pino viraria um zumbido; com o intervalo mínimo vira uma matraca.
  const agora = performance.now();
  if (agora - sorteio.ultimoTique < 38) return;
  sorteio.ultimoTique = agora;
  tocarTique();
}

/* ---- som ---- */

function lerPreferenciaDeSom() {
  try {
    return localStorage.getItem(CHAVE_SOM) !== 'desligado';
  } catch {
    return true;
  }
}

/** O navegador só libera áudio depois de um clique, então isto roda no clique. */
function prepararAudio() {
  if (!sorteio.som) return;
  try {
    if (!sorteio.audio) {
      const Contexto = window.AudioContext || window.webkitAudioContext;
      if (!Contexto) return;
      sorteio.audio = new Contexto();
    }
    if (sorteio.audio.state === 'suspended') sorteio.audio.resume();
  } catch {
    sorteio.audio = null;
  }
}

function nota(frequencia, quando, duracao, volume, tipo, frequenciaFinal) {
  const audio = sorteio.audio;
  const oscilador = audio.createOscillator();
  const ganho = audio.createGain();
  oscilador.type = tipo;
  oscilador.frequency.setValueAtTime(frequencia, quando);
  if (frequenciaFinal) oscilador.frequency.exponentialRampToValueAtTime(frequenciaFinal, quando + duracao);
  ganho.gain.setValueAtTime(0.0001, quando);
  ganho.gain.exponentialRampToValueAtTime(volume, quando + 0.004);
  ganho.gain.exponentialRampToValueAtTime(0.0001, quando + duracao);
  oscilador.connect(ganho).connect(audio.destination);
  oscilador.start(quando);
  oscilador.stop(quando + duracao + 0.02);
}

function tocarTique() {
  if (!sorteio.som || !sorteio.audio) return;
  nota(2100, sorteio.audio.currentTime, 0.035, 0.12, 'triangle', 900);
}

function tocarFanfarra() {
  if (!sorteio.som || !sorteio.audio) return;
  const t = sorteio.audio.currentTime + 0.02;
  [523.25, 659.25, 783.99].forEach((frequencia, i) => nota(frequencia, t + i * 0.1, 0.32, 0.14, 'triangle'));
  nota(1046.5, t + 0.3, 0.9, 0.16, 'triangle');
  nota(1318.5, t + 0.3, 0.9, 0.05, 'sine');
}

function desenharBotaoSom() {
  const botao = $('#botao-som');
  botao.textContent = sorteio.som ? 'Som ligado' : 'Som desligado';
  botao.setAttribute('aria-pressed', String(sorteio.som));
}

/* ---- confete ---- */

/**
 * Papel picado e rodelas de laranja saindo da roleta.
 *
 * Num canvas por cima da página, criado só para isso e jogado fora no fim. O
 * estouro perde força rápido pela resistência do ar e a queda fica lenta, com
 * cada papel balançando e virando — o achatamento vertical é o lado do papel
 * que fica de frente.
 */
function soltarConfete(x, y) {
  if (movimentoReduzido()) return;
  const tela = document.createElement('canvas');
  tela.className = 'confete';
  tela.setAttribute('aria-hidden', 'true');
  const largura = window.innerWidth;
  const altura = window.innerHeight;
  const densidade = Math.min(2, window.devicePixelRatio || 1);
  tela.width = Math.round(largura * densidade);
  tela.height = Math.round(altura * densidade);
  document.body.appendChild(tela);
  const ctx = tela.getContext('2d');
  ctx.scale(densidade, densidade);

  const cores = ['#f5811f', '#ffb066', '#a8410a', '#3f9e56', '#ffe3c2', '#7cc48a', '#c25211'];
  const pedacos = Array.from({ length: 160 }, () => {
    const angulo = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
    const forca = 520 + Math.random() * 900;
    return {
      x,
      y,
      vx: Math.cos(angulo) * forca,
      vy: Math.sin(angulo) * forca,
      giro: Math.random() * Math.PI * 2,
      vGiro: (Math.random() - 0.5) * 12,
      fase: Math.random() * Math.PI * 2,
      vFase: 5 + Math.random() * 7,
      tamanho: 5 + Math.random() * 6,
      cor: cores[Math.floor(Math.random() * cores.length)],
      rodela: Math.random() < 0.2
    };
  });

  const DURACAO = 3.8;
  const inicio = performance.now();
  let antes = inicio;

  function passo(agora) {
    const dt = Math.min(0.033, Math.max(0, (agora - antes) / 1000));
    antes = agora;
    const idade = (agora - inicio) / 1000;
    ctx.clearRect(0, 0, largura, altura);
    ctx.globalAlpha = idade > DURACAO - 0.8 ? Math.max(0, (DURACAO - idade) / 0.8) : 1;

    for (const p of pedacos) {
      p.vy += 980 * dt;
      p.vx -= p.vx * 2.6 * dt;
      p.vy -= p.vy * 2.6 * dt;
      p.fase += p.vFase * dt;
      p.giro += p.vGiro * dt;
      p.x += (p.vx + Math.sin(p.fase) * 40) * dt;
      p.y += p.vy * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.giro);
      if (p.rodela) {
        const raio = p.tamanho * 0.8;
        ctx.fillStyle = '#f5811f';
        ctx.beginPath();
        ctx.arc(0, 0, raio, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffc58a';
        ctx.beginPath();
        ctx.arc(0, 0, raio * 0.72, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#f5811f';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let gomo = 0; gomo < 6; gomo += 1) {
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos((gomo * Math.PI) / 3) * raio * 0.72, Math.sin((gomo * Math.PI) / 3) * raio * 0.72);
        }
        ctx.stroke();
      } else {
        ctx.scale(1, Math.cos(p.fase));
        ctx.fillStyle = p.cor;
        ctx.fillRect(-p.tamanho / 2, -p.tamanho * 0.3, p.tamanho, p.tamanho * 0.6);
      }
      ctx.restore();
    }

    if (idade < DURACAO) requestAnimationFrame(passo);
    else tela.remove();
  }
  requestAnimationFrame(passo);
}

/* ---- tela ---- */

async function carregarSorteio(rodadaId, incluir) {
  // Recarregar no meio do giro redesenharia a roda debaixo da animação.
  if (sorteio.girando) return;
  try {
    const dados = await api(`/api/sorteio${rodadaId ? `?rodada=${encodeURIComponent(rodadaId)}` : ''}`);
    acomodarMarcados(sorteio.dados, dados);
    if (incluir) sorteio.marcados.add(incluir);
    sorteio.dados = dados;
    sorteio.rodadaEscolhida = dados.rodada ? dados.rodada.id : null;
    esconderRevelacao();
    desenharEscolhaDeRodada();
    desenharParticipantes();
    desenharRoda();
    desenharHistoricoSorteios();
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/**
 * Quem fica marcado depois de recarregar.
 *
 * Rodada nova começa do padrão: todo mundo, menos quem já ganhou na volta. Na
 * mesma rodada, o que o espremedor marcou à mão fica, e só muda quem trocou de
 * situação: quem acabou de ganhar sai da roleta, e quando a volta fecha quem
 * estava esperando a vez entra de novo.
 */
function acomodarMarcados(antes, depois) {
  const mesmaRodada = antes && antes.rodada && depois.rodada && antes.rodada.id === depois.rodada.id;
  if (!mesmaRodada) {
    sorteio.marcados = new Set(depois.candidatos.filter((c) => !c.jaGanhou).map((c) => c.usuarioId));
    return;
  }
  const anterior = new Map(antes.candidatos.map((c) => [c.usuarioId, c]));
  const marcados = new Set();
  for (const candidato of depois.candidatos) {
    const velho = anterior.get(candidato.usuarioId);
    let dentro;
    if (!velho) dentro = !candidato.jaGanhou;
    else if (!velho.jaGanhou && candidato.jaGanhou) dentro = false;
    else if (velho.jaGanhou && !candidato.jaGanhou) dentro = true;
    else dentro = sorteio.marcados.has(candidato.usuarioId);
    if (dentro) marcados.add(candidato.usuarioId);
  }
  sorteio.marcados = marcados;
}

function desenharEscolhaDeRodada() {
  const { rodadas, rodada } = sorteio.dados;
  $('#rodada-sorteio').innerHTML = rodadas
    .map(
      (r) => `
      <option value="${esc(r.id)}" ${rodada && r.id === rodada.id ? 'selected' : ''}>
        ${esc(r.nome)}${r.aberta ? ' (aberta)' : ''} · ${r.pessoas} ${r.pessoas === 1 ? 'pessoa' : 'pessoas'}
      </option>`
    )
    .join('');
}

function desenharParticipantes() {
  const candidatos = sorteio.dados ? sorteio.dados.candidatos : [];
  const lista = participantesDaRoda();
  const posicao = new Map(lista.map((p, i) => [p.usuarioId, i]));

  desenharQuemDaParaIncluir();

  if (!candidatos.length) {
    $('#resumo-participantes').textContent = 'Ninguém na roleta dessa rodada.';
    $('#lista-participantes').innerHTML = '<li class="vazio">Adicione alguém abaixo ou escolha outra rodada.</li>';
    $('#aviso-volta').classList.add('escondido');
    return;
  }

  $('#resumo-participantes').textContent = `${lista.length} de ${candidatos.length} na roleta.`;
  $('#lista-participantes').innerHTML = candidatos
    .map((c) => {
      const indice = posicao.get(c.usuarioId);
      const dentro = indice !== undefined;
      const selos = [
        c.jaGanhou ? `<span class="selo-volta">${c.ganhouUltimo ? 'ganhou o último' : 'já ganhou'}</span>` : '',
        c.pediu ? '' : '<span class="selo-extra" title="Não pediu nesta rodada; foi adicionado à mão">sem pedido</span>'
      ].join('');
      // O nome da conta aparece ao passar o mouse quando a roleta usa outro.
      const dica = c.nome !== c.nomeDaConta ? ` title="Conta: ${esc(c.nomeDaConta)}"` : '';
      const travado = sorteio.girando ? 'disabled' : '';
      return `
      <li class="participante ${dentro ? '' : 'fora'}" data-usuario="${esc(c.usuarioId)}">
        <label>
          <input type="checkbox" data-usuario="${esc(c.usuarioId)}" ${dentro ? 'checked' : ''} ${travado}>
          <span class="cor-fatia" ${dentro ? `style="--cor:${corDaFatia(indice, lista.length).fundo}"` : ''}></span>
          <span class="nome"${dica}>${esc(c.nome)}</span>
          ${selos}
        </label>
        <button type="button" class="icone-acao" data-acao="renomear" ${travado}
                aria-label="Mudar o nome de ${esc(c.nome)} na roleta" title="Mudar o nome na roleta">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.6 3.4l3 3L7.4 15.6 3.6 16.4l.8-3.8 9.2-9.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="icone-acao perigo" data-acao="remover" ${travado}
                aria-label="Tirar ${esc(c.nome)} da roleta" title="Tirar da roleta">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </li>`;
    })
    .join('');
  desenharAvisoDaVolta(candidatos, lista);
}

/**
 * O seletor de quem dá para pôr na roleta: quem tem conta e não está nela.
 * Quem pediu e foi tirado também aparece aqui — é por onde se desfaz a remoção.
 */
function desenharQuemDaParaIncluir() {
  const disponiveis = sorteio.dados ? sorteio.dados.disponiveis || [] : [];
  $('#adicionar-participante').classList.toggle('escondido', !sorteio.dados || !sorteio.dados.rodada);
  $('#pessoa-para-incluir').innerHTML = disponiveis.length
    ? `<option value="">Adicionar alguém…</option>${disponiveis
        .map((p) => `<option value="${esc(p.usuarioId)}">${esc(p.nome)}${p.pediu ? ' (pediu, foi tirado)' : ''}</option>`)
        .join('')}`
    : '<option value="">Todo mundo com acesso já está na roleta</option>';
  $('#pessoa-para-incluir').disabled = !disponiveis.length || sorteio.girando;
  $('#botao-incluir-pessoa').disabled = !disponiveis.length || sorteio.girando;
}

/** Põe ou tira alguém da roleta da rodada e recarrega a lista. */
async function ajustarRoleta(usuarioId, acao) {
  try {
    await api('/api/sorteio/participantes', {
      method: 'POST',
      corpo: { rodada: sorteio.rodadaEscolhida, usuarioId, acao }
    });
    // Quem foi posto à mão entra marcado, mesmo que já tenha ganhado: foi
    // escolha explícita do espremedor.
    await carregarSorteio(sorteio.rodadaEscolhida, acao === 'incluir' ? usuarioId : null);
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

async function renomearNaRoleta(usuarioId) {
  const pessoa = sorteio.dados.candidatos.find((c) => c.usuarioId === usuarioId);
  if (!pessoa) return;
  const nome = prompt(
    `Nome de ${pessoa.nomeDaConta} na roleta (deixe vazio para usar o nome da conta).\nO login da pessoa não muda.`,
    pessoa.nome
  );
  if (nome === null) return;
  try {
    await api('/api/sorteio/nome', { method: 'PUT', corpo: { usuarioId, nome } });
    await carregarSorteio(sorteio.rodadaEscolhida);
  } catch (falha) {
    torradeira(falha.message, true);
  }
}

/**
 * O aviso de quem está concorrendo fora da vez.
 *
 * Só avisa, não impede: a combinação é da turma, e às vezes tem motivo para
 * deixar alguém de novo na roleta (falta gente, o brinde é para todos...).
 */
function desenharAvisoDaVolta(candidatos, lista) {
  const aviso = $('#aviso-volta');
  const repetidos = lista.filter((p) => p.jaGanhou);
  if (!repetidos.length) {
    aviso.classList.add('escondido');
    return;
  }
  const faltam = candidatos.filter((c) => !c.jaGanhou).map((c) => c.nome);
  const plural = repetidos.length > 1;
  aviso.innerHTML =
    `<b>${esc(nomesComE(repetidos.map((p) => p.nome)))} já ${plural ? 'ganharam' : 'ganhou'} nesta volta.</b> ` +
    'A combinação é esperar todo mundo ganhar uma vez' +
    (faltam.length ? ` — ainda ${faltam.length > 1 ? 'faltam' : 'falta'} ${esc(nomesComE(faltam))}` : '') +
    '. Dá para sortear assim mesmo.';
  aviso.classList.remove('escondido');
}

function desenharHistoricoSorteios() {
  const sorteios = sorteio.dados ? sorteio.dados.sorteios : [];
  if (!sorteios.length) {
    $('#historico-sorteios').innerHTML = '<p class="vazio">Nenhum sorteio ainda.</p>';
    return;
  }
  $('#historico-sorteios').innerHTML = `
    <div class="tabela-rolavel">
      <table>
        <thead>
          <tr><th>Quando</th><th>Brinde</th><th>Quem ganhou</th><th>Rodada</th><th class="num">Na roleta</th><th></th></tr>
        </thead>
        <tbody>
          ${sorteios
            .map((s) => {
              const foraDaVez = s.participantes.some((p) => p.usuarioId === s.ganhadorId && p.jaGanhou);
              return `
            <tr data-id="${esc(s.id)}">
              <td>${quandoFoi(s.criadoEm)}</td>
              <td>${esc(s.brinde || '—')}</td>
              <td><b>${esc(s.ganhadorNome)}</b>${foraDaVez ? ' <span class="selo-volta">fora da vez</span>' : ''}</td>
              <td>${esc(s.rodadaNome || '—')}</td>
              <td class="num">${s.participantes.length}</td>
              <td class="num"><button type="button" class="botao perigo miudo" data-acao="apagar-sorteio">Apagar</button></td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/** Enquanto a roda gira, nada que mude a roleta pode ser mexido. */
function travarSorteio(travado) {
  sorteio.girando = travado;
  for (const elemento of [
    '#botao-girar',
    '#miolo-roleta',
    '#brinde',
    '#rodada-sorteio',
    '#marcar-todos',
    '#marcar-quem-falta'
  ]) {
    $(elemento).disabled = travado;
  }
  for (const controle of $$('#lista-participantes input, #lista-participantes button')) controle.disabled = travado;
  // O seletor de adicionar destrava só se houver alguém para pôr.
  desenharQuemDaParaIncluir();
  $('#botao-girar').textContent = travado ? 'Girando…' : 'Girar a roleta';
}

function esconderRevelacao() {
  $('#revelacao').classList.add('escondido');
  $('#controles-sorteio').classList.remove('escondido');
  $('#roleta').classList.remove('venceu');
  if (!sorteio.girando) $('#miolo-roleta').disabled = false;
  for (const fatia of $$('#roda .fatia')) fatia.classList.remove('vencedora', 'apagada');
}

async function girarRoleta() {
  if (sorteio.girando || !sorteio.dados || !sorteio.dados.rodada) return;
  const lista = participantesDaRoda();
  if (!lista.length) return torradeira('Marque pelo menos uma pessoa para participar.', true);

  esconderRevelacao();
  travarSorteio(true);
  prepararAudio();
  const reduzido = movimentoReduzido();
  const partida = sorteio.rotacao;

  const pedido = api('/api/sorteios', {
    method: 'POST',
    corpo: {
      rodada: sorteio.dados.rodada.id,
      participantes: lista.map((p) => p.usuarioId),
      brinde: $('#brinde').value
    }
  });
  // A puxada para trás, antes do arranque, cobre a ida ao servidor: a roda reage
  // ao clique na hora, e quando ela solta o ganhador já está escolhido.
  const puxada = reduzido ? Promise.resolve() : moverRoda(partida - 14, 460, suave);
  const [resultado] = await Promise.allSettled([pedido, puxada]);

  if (resultado.status === 'rejected') {
    await moverRoda(partida, 380, suave);
    travarSorteio(false);
    return torradeira(resultado.reason.message, true);
  }

  const resposta = resultado.value;
  const indice = lista.findIndex((p) => p.usuarioId === resposta.ganhador.usuarioId);
  if (indice < 0) {
    // Não deveria acontecer: o servidor só sorteia entre quem foi mandado.
    travarSorteio(false);
    carregarSorteio(sorteio.rodadaEscolhida);
    return torradeira('A roleta mudou no meio do caminho. Confira o sorteio anterior na lista.', true);
  }

  const fatia = 360 / lista.length;
  // Para num ponto qualquer da fatia, longe das bordas: parar sempre no meio
  // ficaria mecânico, e parar em cima do pino deixaria dúvida de quem ganhou.
  const dentro = 0.2 + Math.random() * 0.6;
  const destino = mod(-(indice + dentro) * fatia, 360);
  const de = sorteio.rotacao;
  const voltas = reduzido ? 1 : 6 + Math.floor(Math.random() * 3);

  $('#roleta').classList.add('girando');
  await moverRoda(
    de + voltas * 360 + mod(destino - de, 360),
    reduzido ? 900 : 6200 + Math.random() * 1600,
    reduzido ? suave : arrancadaEFreio
  );
  // Um respiro com a roda parada antes do anúncio: o ponteiro assenta e quem
  // está olhando já leu o nome na fatia.
  await esperar(reduzido ? 0 : 320);

  sorteio.rotacao = mod(sorteio.rotacao, 360);
  aplicarRotacao();
  travarSorteio(false);
  revelarGanhador(resposta);
}

function revelarGanhador({ ganhador, sorteio: registro }) {
  const roleta = $('#roleta');
  roleta.classList.remove('girando');
  roleta.classList.add('venceu');

  for (const fatia of $$('#roda .fatia')) {
    const venceu = fatia.dataset.usuario === ganhador.usuarioId;
    fatia.classList.toggle('vencedora', venceu);
    fatia.classList.toggle('apagada', !venceu);
    // Por último entre as fatias, para o contorno aceso passar por cima das vizinhas.
    if (venceu) $('#roda').insertBefore(fatia, $('#roda .divisoes'));
  }

  tocarFanfarra();
  const caixa = roleta.getBoundingClientRect();
  soltarConfete(caixa.left + caixa.width / 2, caixa.top + caixa.height * 0.4);

  // Letra por letra, cada uma com um atraso: o nome "cai" na tela. O título leva
  // o nome inteiro para o leitor de tela não soletrar.
  const letras = [...ganhador.nome]
    .map((letra, i) => `<span style="--i:${i}" aria-hidden="true">${esc(letra)}</span>`)
    .join('');
  $('#revelacao').innerHTML = `
    <p class="rotulo">${registro.brinde ? `Quem leva ${esc(registro.brinde)}` : 'Quem ganhou'}</p>
    <h3 aria-label="${esc(ganhador.nome)}">${letras}</h3>
    ${ganhador.jaGanhou ? '<p class="quem">Já tinha ganhado nesta volta — entrou na roleta por escolha sua.</p>' : ''}
    <button type="button" class="botao" id="proximo-sorteio">Próximo sorteio</button>`;
  $('#revelacao').classList.remove('escondido');
  $('#controles-sorteio').classList.add('escondido');
  // Até "Próximo sorteio", a roda fica mostrando quem ganhou.
  $('#miolo-roleta').disabled = true;

  sorteio.dados.sorteios.unshift(registro);
  desenharHistoricoSorteios();
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

$('#rodada-entrega').addEventListener('change', (evento) => carregarEntrega(null, evento.target.value));
$('#busca-entrega').addEventListener('input', (evento) => {
  entrega.busca = evento.target.value;
  desenharEntrega();
});
$('#botao-imprimir-entrega').addEventListener('click', imprimirEntrega);

$('#lista-entrega').addEventListener('change', async (evento) => {
  const caixa = evento.target.closest('input[data-acao="entregar"]');
  if (!caixa) return;
  const cartao = caixa.closest('.cartao-entrega');
  caixa.disabled = true;
  try {
    const { pedido } = await api(`/api/pedidos/${cartao.dataset.usuario}/entrega`, {
      method: 'PATCH',
      corpo: { entregue: caixa.checked, rodada: entrega.rodadaId }
    });
    // Só muda a marca local: recarregar a aba inteira a cada caixa entregue seria lento no celular.
    const pessoa = entrega.resumo.pessoas.find((p) => p.usuarioId === cartao.dataset.usuario);
    if (pessoa) pessoa.entregueEm = pedido.entregueEm;
    torradeira(caixa.checked ? `${pedido.nome} recebeu.` : 'Entrega desfeita.');
    desenharEntrega();
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
  if (!linha || (acao !== 'papel' && acao !== 'email' && acao !== 'nome')) return;

  // O nome é o login: antes de trocar, a tela pergunta, porque a pessoa vai
  // precisar entrar com o nome novo e talvez não saiba disso.
  if (acao === 'nome') {
    const campo = evento.target;
    const nome = campo.value.trim().replace(/\s+/g, ' ');
    const antigo = campo.dataset.valor || '';
    if (nome === antigo) return;
    if (!confirm(`Trocar "${antigo}" por "${nome}"? A pessoa passa a entrar com o nome novo.`)) {
      campo.value = antigo;
      return;
    }
    try {
      const dados = await api(`/api/usuarios/${linha.dataset.id}`, { method: 'PATCH', corpo: { nome } });
      campo.value = dados.usuario.nome;
      campo.dataset.valor = dados.usuario.nome;
      if (linha.dataset.id === estado.usuario.id) {
        estado.usuario.nome = dados.usuario.nome;
        $('#nome-usuario').textContent = dados.usuario.nome;
      }
      torradeira(`Nome trocado. Agora entra como "${dados.usuario.nome}".`);
    } catch (falha) {
      torradeira(falha.message, true);
      campo.value = antigo;
    }
    return;
  }

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

$('#botao-criar-pessoa').addEventListener('click', async () => {
  const nome = $('#nova-pessoa-nome').value.trim();
  const senha = $('#nova-pessoa-senha').value;
  const endereco = $('#nova-pessoa-email').value.trim();
  if (!nome || !senha) return torradeira('Preencha o nome e a senha inicial.', true);
  try {
    const dados = await api('/api/usuarios', { method: 'POST', corpo: { nome, senha, email: endereco } });
    for (const campo of ['#nova-pessoa-nome', '#nova-pessoa-senha', '#nova-pessoa-email']) $(campo).value = '';
    torradeira(`Acesso criado. Passe para ${dados.usuario.nome} o nome e a senha.`);
    carregarPessoas();
  } catch (falha) {
    torradeira(falha.message, true);
  }
});

desenharMoldura();
desenharBotaoSom();

$('#botao-girar').addEventListener('click', girarRoleta);
$('#miolo-roleta').addEventListener('click', girarRoleta);
$('#brinde').addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter') girarRoleta();
});

$('#botao-som').addEventListener('click', () => {
  sorteio.som = !sorteio.som;
  try {
    localStorage.setItem(CHAVE_SOM, sorteio.som ? 'ligado' : 'desligado');
  } catch {
    /* sem localStorage a escolha vale só até recarregar */
  }
  desenharBotaoSom();
  // Um tique de amostra: quem ligou o som quer saber se está ouvindo.
  if (sorteio.som) {
    prepararAudio();
    tocarTique();
  }
});

$('#rodada-sorteio').addEventListener('change', (evento) => carregarSorteio(evento.target.value));

$('#lista-participantes').addEventListener('change', (evento) => {
  const caixa = evento.target.closest('input[data-usuario]');
  if (!caixa || sorteio.girando) return;
  const id = caixa.dataset.usuario;
  if (caixa.checked) sorteio.marcados.add(id);
  else sorteio.marcados.delete(id);
  esconderRevelacao();
  desenharParticipantes();
  desenharRoda();
  // A lista foi redesenhada: devolve o foco a quem estava no teclado.
  const mesma = $(`#lista-participantes input[data-usuario="${CSS.escape(id)}"]`);
  if (mesma) mesma.focus();
});

$('#lista-participantes').addEventListener('click', (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao || sorteio.girando) return;
  const id = botao.closest('li[data-usuario]').dataset.usuario;
  if (botao.dataset.acao === 'renomear') renomearNaRoleta(id);
  // Sem confirmação: tirar é fácil de desfazer pelo "Adicionar alguém".
  if (botao.dataset.acao === 'remover') ajustarRoleta(id, 'remover');
});

$('#botao-incluir-pessoa').addEventListener('click', () => {
  const id = $('#pessoa-para-incluir').value;
  if (!id) return torradeira('Escolha quem vai entrar na roleta.', true);
  ajustarRoleta(id, 'incluir');
});

for (const [botao, filtro] of [
  ['#marcar-todos', () => true],
  ['#marcar-quem-falta', (c) => !c.jaGanhou]
]) {
  $(botao).addEventListener('click', () => {
    if (!sorteio.dados || sorteio.girando) return;
    sorteio.marcados = new Set(sorteio.dados.candidatos.filter(filtro).map((c) => c.usuarioId));
    esconderRevelacao();
    desenharParticipantes();
    desenharRoda();
  });
}

$('#revelacao').addEventListener('click', (evento) => {
  if (!evento.target.closest('#proximo-sorteio')) return;
  $('#brinde').value = '';
  carregarSorteio(sorteio.rodadaEscolhida).then(() => $('#brinde').focus());
});

$('#historico-sorteios').addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao="apagar-sorteio"]');
  if (!botao || sorteio.girando) return;
  if (!confirm('Apagar este sorteio? Ele deixa de contar em quem já ganhou.')) return;
  try {
    await api(`/api/sorteios/${botao.closest('tr[data-id]').dataset.id}`, { method: 'DELETE' });
    torradeira('Sorteio apagado.');
    carregarSorteio(sorteio.rodadaEscolhida);
  } catch (falha) {
    torradeira(falha.message, true);
  }
});

iniciar().catch((falha) => {
  document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif">Não deu para falar com o servidor: ${esc(falha.message)}</p>`;
});
