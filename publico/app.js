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
  if (!resposta.ok) throw new Error(dados.erro || `Falha na comunicação (${resposta.status}).`);
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

function ajustarEntrada() {
  const criando = modoEntrada === 'criar';
  $('#aba-entrar').setAttribute('aria-pressed', String(!criando));
  $('#aba-criar').setAttribute('aria-pressed', String(criando));
  $('#botao-entrada').textContent = criando ? 'Criar acesso' : 'Entrar';
  $('#campo-senha').setAttribute('autocomplete', criando ? 'new-password' : 'current-password');
  $('#dica-entrada').textContent = criando
    ? 'Use seu primeiro nome. A senha serve só pra ninguém pedir no seu lugar.'
    : 'Ainda não tem acesso? Toque em “Criar acesso”.';
  $('#erro-entrada').classList.add('escondido');
}

function mostrarErroEntrada(mensagem) {
  const caixa = $('#erro-entrada');
  caixa.textContent = mensagem;
  caixa.classList.remove('escondido');
}

async function enviarEntrada() {
  const nome = $('#campo-nome').value.trim();
  const senha = $('#campo-senha').value;
  if (!nome || !senha) return mostrarErroEntrada('Preencha nome e senha.');

  const botao = $('#botao-entrada');
  botao.disabled = true;
  try {
    const rota = modoEntrada === 'criar' ? '/api/cadastro' : '/api/entrar';
    const conta = await api(rota, { method: 'POST', corpo: { nome, senha } });
    guardarToken(conta.token);
    $('#campo-senha').value = '';
    await iniciar();
  } catch (falha) {
    mostrarErroEntrada(falha.message);
  } finally {
    botao.disabled = false;
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
  for (const nome of ['loja', 'fechamento', 'catalogo', 'pessoas']) {
    $(`#aba-${nome}`).classList.toggle('escondido', nome !== aba);
  }
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
          </div>
        </article>`;
    })
    .join('');
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
    mostrarAviso('O comprador ainda não cadastrou a chave Pix. Combine o pagamento com ele.', 'neutro');
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
    mostrarAviso(`O comprador confirmou seu pagamento em ${quandoFoi(pedido.confirmadoEm)}.`, 'bom');
  } else if (pedido.pagoEm) {
    botao.disabled = false;
    botao.textContent = 'Avisei que paguei — desfazer';
    mostrarAviso(`Você avisou que pagou em ${quandoFoi(pedido.pagoEm)}. Falta o comprador confirmar.`, 'neutro');
  } else {
    botao.disabled = false;
    botao.textContent = 'Já paguei';
    esconderAviso();
  }
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
/* Fechamento                                                          */
/* ------------------------------------------------------------------ */

let fechamentoAtual = null;

async function carregarFechamento() {
  try {
    const dados = await api('/api/fechamento');
    fechamentoAtual = dados;
    desenharFechamento(dados);
    const historico = await api('/api/rodadas');
    desenharHistorico(historico.rodadas);
  } catch (falha) {
    torradeira(falha.message, true);
  }
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
    .map(([rotulo, valor]) => `<div class="numero"><b>${esc(valor)}</b><span>${esc(rotulo)}</span></div>`)
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
  const comprador = estado.usuario && estado.usuario.papel === 'comprador';
  $('#bloco-pessoas').classList.toggle('escondido', !comprador);
  $('#titulo-conta').textContent = comprador ? 'Pessoas' : 'Minha conta';
  $('#subtitulo-conta').textContent = comprador
    ? 'Quem tem acesso e quem faz a compra.'
    : 'Troque sua senha quando quiser.';
  if (!comprador) return;

  try {
    const dados = await api('/api/usuarios');
    $('#tabela-pessoas').innerHTML = `
      <table>
        <thead><tr><th>Nome</th><th>Perfil</th><th>Desde</th><th></th></tr></thead>
        <tbody>
          ${dados.usuarios
            .map(
              (pessoa) => `
            <tr data-id="${esc(pessoa.id)}">
              <td>${esc(pessoa.nome)}</td>
              <td>
                <select data-acao="papel" style="padding:5px 8px;border:1px solid var(--linha);border-radius:6px">
                  <option value="colega" ${pessoa.papel === 'colega' ? 'selected' : ''}>colega</option>
                  <option value="comprador" ${pessoa.papel === 'comprador' ? 'selected' : ''}>comprador</option>
                </select>
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
    await api('/api/minha-senha', { method: 'POST', corpo: { atual, nova } });
    $('#senha-atual').value = '';
    $('#senha-nova').value = '';
    torradeira('Senha trocada.');
  } catch (falha) {
    torradeira(falha.message, true);
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
  const sessao = await carregarSessao();

  if (!sessao.usuario) {
    $('#tela-app').classList.add('escondido');
    $('#tela-entrada').classList.remove('escondido');
    if (sessao.primeiroAcesso) {
      modoEntrada = 'criar';
      ajustarEntrada();
      $('#dica-entrada').textContent =
        'Ninguém se cadastrou ainda. O primeiro acesso criado vira o comprador da turma.';
    } else {
      ajustarEntrada();
    }
    $('#campo-nome').focus();
    return;
  }

  $('#tela-entrada').classList.add('escondido');
  $('#tela-app').classList.remove('escondido');
  $('#nome-usuario').textContent = sessao.usuario.nome;

  const comprador = sessao.usuario.papel === 'comprador';
  $('#selo-comprador').classList.toggle('escondido', !comprador);
  for (const elemento of $$('.so-comprador')) elemento.classList.toggle('escondido', !comprador);

  await carregarProdutos();
  await carregarMeuPedido();
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
$('#botao-entrada').addEventListener('click', enviarEntrada);
for (const campo of ['#campo-nome', '#campo-senha']) {
  $(campo).addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter') enviarEntrada();
  });
}

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
  mudarQuantidade(cartao.dataset.id, botao.dataset.acao === 'mais' ? 1 : -1);
});

$('#botao-enviar').addEventListener('click', enviarPedido);
$('#botao-cancelar').addEventListener('click', cancelarPedido);

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
    torradeira(resposta.pedido.pagoEm ? 'Avisado. O comprador vai confirmar.' : 'Aviso de pagamento desfeito.');
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
  if (!linha || evento.target.dataset.acao !== 'papel') return;
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
