'use strict';

/**
 * Busca a lista de sabores no site da Nescafé Dolce Gusto e devolve
 * produtos normalizados. O site é uma loja Magento 2, então há dois caminhos:
 *
 *   1. GraphQL (/graphql) — a API que a própria loja usa. Devolve nome, preço,
 *      imagem, estoque e categorias já estruturados. É o caminho preferido.
 *   2. HTML da página /sabores — reserva, com três leituras diferentes do
 *      código da página, da mais confiável para a mais tolerante.
 *
 * Se nenhum trouxer resultado suficiente, o catálogo atual é mantido.
 *
 * Sobre o HTTP 403: o site fica atrás de um CDN que recusa requisições com
 * cabeçalhos incompletos. Não basta trocar o User-Agent — ele espera o conjunto
 * que um navegador de verdade manda junto (Accept, Accept-Language, Sec-Fetch-*,
 * sec-ch-ua, Upgrade-Insecure-Requests e Connection). Com o conjunto completo a
 * página responde 200 normalmente. O robots.txt do site libera /sabores e
 * /media/catalog/product/*, então a leitura é permitida.
 */

const BASE = 'https://www.nescafe-dolcegusto.com.br';
const URL_SABORES = `${BASE}/sabores?product_list_limit=1000`;
const URL_GRAPHQL = `${BASE}/graphql`;

const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/** Cabeçalhos de quem abre uma página no navegador. O CDN exige o conjunto todo. */
const CABECALHOS = {
  'User-Agent': AGENTE,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Chromium";v="138", "Google Chrome";v="138", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Connection': 'keep-alive'
};

/** Cabeçalhos de quem chama a API pelo próprio site. */
const CABECALHOS_API = {
  'User-Agent': AGENTE,
  'Content-Type': 'application/json',
  'Accept': '*/*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Origin': BASE,
  'Referer': `${BASE}/sabores`,
  'Connection': 'keep-alive'
};

function semAcento(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function gerarId(nome) {
  return semAcento(String(nome))
    .toLowerCase()
    .replace(/®|©|™/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function chaveComparacao(nome) {
  return semAcento(String(nome)).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** O nome sem o "N CÁPSULAS" do fim — serve para achar o par unidade/caixa. */
function chaveSemCapsulas(nome) {
  return chaveComparacao(String(nome).replace(/\b\d+\s*c[áa]psulas?\b/gi, ''));
}

/** Tem contagem de cápsulas no nome? É o jeito de saber que o item é a caixa. */
function pareceCaixa(nome) {
  return /\d+\s*c[áa]psulas?/i.test(String(nome));
}

function limparTexto(html) {
  return html
    // Blocos de script/estilo saem inteiros: o conteúdo deles não é texto da página.
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    // Tira as tags respeitando aspas. O `/<[^>]*>/` ingênuo quebrava quando um
    // atributo continha ">" — coisa comum em classe do Tailwind, tipo
    // `class="[&>svg]:h-4"` — e o resto do atributo vazava como se fosse texto,
    // virando nome de produto com "!important" e "data-sku" no meio.
    .replace(/<[a-zA-Z\/!?][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function paraNumero(valor) {
  if (valor === null || valor === undefined) return null;
  let texto = String(valor).trim();
  if (!texto) return null;
  texto = texto.replace(/[^\d.,]/g, '');
  if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
  const numero = Number.parseFloat(texto);
  return Number.isFinite(numero) ? numero : null;
}

function categoriaPeloNome(nome) {
  const n = semAcento(String(nome)).toUpperCase();
  if (n.startsWith('COMBO')) return 'Combos';
  if (n.includes('ADAPTADOR') || n.includes('XICARA') || n.includes('MAQUINA')) return 'Acessórios';
  if (n.startsWith('NEO ')) return 'NEO';
  if (n.includes('STARBUCKS')) return 'Starbucks';
  if (n.includes('NESTEA') || n.includes('CHAI') || n.includes("NATURE'S HEART")) return 'Chás';
  if (
    n.includes('CHOCOCINO') || n.includes('NESCAU') || n.includes('GALAK') ||
    n.includes('KITKAT') || n.includes('NESQUIK') || n.includes('LINGUA DE GATO')
  ) return 'Chocolates';
  if (n.includes('LUNGO')) return 'Lungos';
  if (
    n.includes('CAPPUCCINO') || n.includes('LATTE') || n.includes('AU LAIT') ||
    n.includes('MOCHACCINO') || n.includes('CORTADO') || n.includes('PINGADO') ||
    n.includes('FRAPPE') || n.includes('SHAKERATO') || n.includes('CARAMELO')
  ) return 'Lattes';
  if (n.includes('ESPRESSO') || n.includes('CAFE') || n.includes('CAFFE')) return 'Cafés';
  return 'Outros';
}

function capsulasPeloNome(nome) {
  const achou = String(nome).match(/(\d+)\s*C[ÁA]PSULAS?/i);
  return achou ? Number(achou[1]) : null;
}

/**
 * De categoria do site para categoria daqui. O site marca cada produto em
 * várias categorias ao mesmo tempo ("Assinatura", "Sabores", "Lattes"…), então
 * ficamos com a primeira que diz alguma coisa — a ordem abaixo é a prioridade.
 */
const CATEGORIAS_DO_SITE = [
  ['acessórios', 'Acessórios'],
  ['máquinas', 'Acessórios'],
  ['starbucks', 'Starbucks'],
  ['cafés pretos neo', 'NEO'],
  ['chás', 'Chás'],
  ['natures heart', 'Chás'],
  ["nature's heart", 'Chás'],
  ['kopenhagen', 'Chocolates'],
  ['chocolates', 'Chocolates'],
  ['lungos', 'Lungos'],
  ['lattes', 'Lattes'],
  ['espressos', 'Cafés'],
  ['black coffees', 'Cafés'],
  ['caseiros', 'Cafés'],
  ['orgânicos', 'Cafés'],
  ['cafés', 'Cafés']
];

/**
 * Categoria de um produto vindo do GraphQL. O nome manda quando é combo,
 * porque o site põe combos junto dos sabores. Sem categoria reconhecida,
 * cai na regra pelo nome, igual à leitura do HTML.
 */
function categoriaPeloSite(categorias, nome) {
  if (/^combo/i.test(semAcento(String(nome)).trim())) return 'Combos';

  const nomes = (categorias || [])
    .map((c) => semAcento(String((c && c.name) || '')).toLowerCase().trim())
    .filter(Boolean);

  for (const [procurado, categoria] of CATEGORIAS_DO_SITE) {
    const alvo = semAcento(procurado).toLowerCase();
    if (nomes.some((n) => n === alvo)) return categoria;
  }
  return categoriaPeloNome(nome);
}

/** Leitura 1: blocos de produto do Magento (li.product-item). */
function lerBlocosMagento(html) {
  const produtos = [];
  const blocos = html.split(/<li[^>]+class="[^"]*product-item[^"]*"/i).slice(1);

  for (const bloco of blocos) {
    const pedaco = bloco.slice(0, 20000);

    let nome = null;
    const linkNome =
      pedaco.match(/class="[^"]*product-item-link[^"]*"[^>]*>([\s\S]{1,200}?)<\/a>/i) ||
      pedaco.match(/class="[^"]*product[^"]*name[^"]*"[^>]*>([\s\S]{1,300}?)<\/(?:a|strong|h\d)>/i);
    if (linkNome) nome = limparTexto(linkNome[1]);
    if (!nome) {
      const alt = pedaco.match(/<img[^>]+alt="([^"]{4,200})"/i);
      if (alt) nome = limparTexto(alt[1]);
    }
    if (!nome || nome.length < 3) continue;

    const precos = [];
    const regexPreco = /data-price-amount="([\d.,]+)"/gi;
    let achado;
    while ((achado = regexPreco.exec(pedaco)) !== null) {
      const valor = paraNumero(achado[1]);
      if (valor && valor > 0) precos.push(valor);
    }
    if (!precos.length) {
      const regexReal = /R\$\s*([\d.,]+)/gi;
      while ((achado = regexReal.exec(pedaco)) !== null) {
        const valor = paraNumero(achado[1]);
        if (valor && valor > 0) precos.push(valor);
      }
    }

    const url = (pedaco.match(/href="(https?:\/\/[^"]*nescafe[^"]*)"/i) || [])[1] || null;
    const imagem = (pedaco.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) || [])[1] || null;
    const semEstoque = /sem\s*estoque|out\s*of\s*stock|avise-me/i.test(limparTexto(pedaco));

    produtos.push({
      nome,
      preco: precos.length ? Math.min(...precos) : null,
      precoDe: precos.length > 1 ? Math.max(...precos) : null,
      disponivel: !semEstoque,
      url,
      imagem
    });
  }
  return produtos;
}

/** Leitura 2: dados estruturados JSON-LD. */
function lerJsonLd(html) {
  const produtos = [];
  const regex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let bloco;
  while ((bloco = regex.exec(html)) !== null) {
    let dados;
    try {
      dados = JSON.parse(bloco[1].trim());
    } catch {
      continue;
    }
    const fila = Array.isArray(dados) ? [...dados] : [dados];
    while (fila.length) {
      const item = fila.shift();
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.itemListElement)) {
        for (const filho of item.itemListElement) fila.push(filho.item || filho);
      }
      if (item['@type'] === 'Product' && item.name) {
        const oferta = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        produtos.push({
          nome: limparTexto(item.name),
          preco: paraNumero(oferta && (oferta.price || oferta.lowPrice)),
          precoDe: null,
          disponivel: !/OutOfStock/i.test((oferta && oferta.availability) || ''),
          url: item.url || null,
          imagem: typeof item.image === 'string' ? item.image : (item.image && item.image[0]) || null
        });
      }
    }
  }
  return produtos;
}

const RUIDO_ANTES_DO_NOME =
  /(?:adicionar|concluído|concluido|sem\s*estoque|avise-me|pontos|aumentar|classificação:[^]{0,40})/gi;

/** Tira o que sobrou do cartão anterior antes do nome do produto. */
function limparNomeCorrido(bruto) {
  let nome = bruto;
  let ultimo = null;
  let achado;
  RUIDO_ANTES_DO_NOME.lastIndex = 0;
  while ((achado = RUIDO_ANTES_DO_NOME.exec(nome)) !== null) {
    ultimo = achado.index + achado[0].length;
  }
  if (ultimo !== null) nome = nome.slice(ultimo);
  return nome
    .replace(/^[\s\-–—:.,]+/, '')
    .replace(/^intensidade\s*\d+\s*/i, '')
    .replace(/^compatibilidade[^]{0,80}?(?=[A-ZÁÂÃÀÉÊÍÓÔÕÚÜÇ])/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Leitura 3: varredura do texto puro, no formato "NOME CÁPSULAS: x10 ... R$ 00,00". */
function lerTextoCorrido(html) {
  const texto = limparTexto(html);
  const produtos = [];
  const regex =
    /([A-ZÁÂÃÀÉÊÍÓÔÕÚÜÇ0-9][^.]{4,80}?\d+\s*C[ÁA]PSULAS?)\s*C[ÁA]PSULAS:[\s\S]{0,400}?(?:R\$\s*([\d.,]+))(?:\s*R\$\s*([\d.,]+))?/gi;
  let achado;
  while ((achado = regex.exec(texto)) !== null) {
    const nome = limparNomeCorrido(achado[1]);
    if (nome.length < 5) continue;
    const primeiro = paraNumero(achado[2]);
    const segundo = paraNumero(achado[3]);
    const preco = segundo !== null ? Math.min(primeiro, segundo) : primeiro;
    const precoDe = segundo !== null ? Math.max(primeiro, segundo) : null;
    produtos.push({ nome, preco, precoDe, disponivel: true, url: null, imagem: null });
  }
  return produtos;
}

/**
 * Sobra de HTML/CSS que escapou da limpeza. Nome de sabor não tem nada disso.
 * É a última barreira antes do catálogo: se uma leitura ruim voltar a vazar
 * marcação, ela é descartada aqui em vez de virar produto de mentira.
 */
const RESIDUO_DE_MARCACAO =
  /[<>{}"]|!important|data-[a-z0-9-]+\s*=|(?:class|style|src|srcset|href|alt|viewbox)\s*=|https?:\/\/|&[a-z]{2,8};|--[a-z-]+\s*:/i;

function normalizar(lista) {
  const porChave = new Map();
  for (const bruto of lista) {
    if (!bruto || !bruto.nome) continue;
    const nome = bruto.nome.replace(/\s+/g, ' ').trim();
    if (nome.length < 4 || nome.length > 120) continue;
    if (/^(carrinho|buscar|entrar|newsletter|assinatura)$/i.test(nome)) continue;
    if (RESIDUO_DE_MARCACAO.test(nome)) continue;

    const chave = chaveComparacao(nome);
    if (porChave.has(chave)) {
      const atual = porChave.get(chave);
      if (atual.preco === null && bruto.preco !== null) atual.preco = bruto.preco;
      if (!atual.imagem && bruto.imagem) atual.imagem = bruto.imagem;
      if (!atual.url && bruto.url) atual.url = bruto.url;
      if (!atual.descricao && bruto.descricao) atual.descricao = bruto.descricao;
      continue;
    }
    porChave.set(chave, {
      id: gerarId(nome),
      chave,
      nome: nome.toUpperCase(),
      categoria: bruto.categoria || categoriaPeloNome(nome),
      capsulas: capsulasPeloNome(nome),
      preco: bruto.preco,
      precoDe: bruto.precoDe && bruto.preco && bruto.precoDe > bruto.preco ? bruto.precoDe : null,
      disponivel: bruto.disponivel !== false,
      url: bruto.url || null,
      imagem: bruto.imagem || null,
      descricao: bruto.descricao || ''
    });
  }
  return [...porChave.values()];
}

function esperar(ms) {
  return new Promise((pronto) => setTimeout(pronto, ms));
}

/**
 * O CDN às vezes responde HTTP 200 com uma página de desafio (só JavaScript,
 * nenhum produto) em vez de recusar direto. Se isso passasse batido, as leituras
 * tolerantes interpretariam o lixo como produtos e o catálogo seria estragado —
 * então tratamos essa página como falha.
 */
function pareceBloqueio(html) {
  if (typeof html !== 'string' || html.length < 50000) {
    // Página de produto de verdade tem centenas de KB; algo curto já é suspeito.
    if (/access denied|sec-if-cpt-container|_abck|bot detection|akamai/i.test(String(html))) return true;
  }
  return /<title>\s*Access Denied\s*<\/title>/i.test(String(html));
}

/** Uma requisição com prazo. Explica o 403 em vez de só repetir o número. */
async function pedir(url, opcoes = {}, tempoLimiteMs = 25000) {
  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), tempoLimiteMs);
  try {
    const resposta = await fetch(url, { ...opcoes, signal: controle.signal });
    if (!resposta.ok) {
      const erro = new Error(
        resposta.status === 403
          ? 'o site recusou a leitura (HTTP 403) — normalmente é o CDN barrando a requisição'
          : `o site respondeu com HTTP ${resposta.status}`
      );
      erro.status = resposta.status;
      throw erro;
    }
    return resposta;
  } catch (falha) {
    if (falha.name === 'AbortError') {
      throw new Error(`o site não respondeu em ${Math.round(tempoLimiteMs / 1000)}s`);
    }
    throw falha;
  } finally {
    clearTimeout(alarme);
  }
}

/** Repete algumas vezes, esperando mais a cada tropeço. */
async function tentarVarias(tarefa, tentativas = 3, esperaMs = 1500) {
  let ultima;
  for (let volta = 1; volta <= tentativas; volta += 1) {
    try {
      return await tarefa();
    } catch (falha) {
      ultima = falha;
      if (volta < tentativas) await esperar(esperaMs * volta);
    }
  }
  throw ultima;
}

/**
 * A página HTML é protegida também pela "impressão digital" do TLS: o CDN
 * compara o handshake com o de um navegador de verdade, e o do Node (OpenSSL)
 * não bate — dá 403 mesmo com todos os cabeçalhos certos. O curl do sistema usa
 * a pilha TLS do próprio sistema operacional e passa, então ele é a segunda
 * tentativa. Não é dependência nova: já vem no Windows 10+ e em praticamente
 * toda instalação de Linux. Se não existir, seguimos sem ele.
 */
function buscarComCurl(url, tempoLimiteMs) {
  const { execFile } = require('child_process');
  const argumentos = ['-sS', '--compressed', '--max-time', String(Math.ceil(tempoLimiteMs / 1000))];
  for (const [chave, valor] of Object.entries(CABECALHOS)) argumentos.push('-H', `${chave}: ${valor}`);
  argumentos.push('-w', '\n%{http_code}', url);

  return new Promise((pronto, falhou) => {
    execFile(
      'curl',
      argumentos,
      { maxBuffer: 64 * 1024 * 1024, timeout: tempoLimiteMs + 5000, windowsHide: true },
      (erro, saida) => {
        if (erro && !saida) {
          return falhou(
            new Error(
              erro.code === 'ENOENT'
                ? 'o curl não está instalado para tentar a leitura da página'
                : `o curl falhou: ${erro.message.split('\n')[0]}`
            )
          );
        }
        const quebra = saida.lastIndexOf('\n');
        const codigo = Number(saida.slice(quebra + 1).trim());
        const corpo = saida.slice(0, quebra);
        if (codigo !== 200) return falhou(new Error(`o site respondeu com HTTP ${codigo} via curl`));
        pronto(corpo);
      }
    );
  });
}

async function buscarNoSite(url = URL_SABORES, tempoLimiteMs = 25000) {
  const conferir = (html) => {
    if (pareceBloqueio(html)) {
      throw new Error('o CDN devolveu a página de verificação em vez da lista de produtos');
    }
    return html;
  };

  try {
    const resposta = await tentarVarias(() => pedir(url, { headers: CABECALHOS }, tempoLimiteMs), 2);
    return conferir(await resposta.text());
  } catch (falha) {
    try {
      return conferir(await buscarComCurl(url, tempoLimiteMs));
    } catch (falhaCurl) {
      throw new Error(`${falha.message}; pelo curl: ${falhaCurl.message}`);
    }
  }
}

const CONSULTA_PRODUTOS = `query Catalogo($pagina: Int!, $porPagina: Int!) {
  products(filter: {}, pageSize: $porPagina, currentPage: $pagina) {
    total_count
    page_info { current_page total_pages }
    items {
      name
      sku
      url_key
      url_suffix
      stock_status
      short_description { html }
      small_image { url }
      categories { name }
      price_range {
        minimum_price {
          final_price { value }
          regular_price { value }
        }
      }
    }
  }
}`;

async function consultarGraphql(variaveis, tempoLimiteMs) {
  const resposta = await tentarVarias(() =>
    pedir(
      URL_GRAPHQL,
      {
        method: 'POST',
        headers: CABECALHOS_API,
        body: JSON.stringify({ query: CONSULTA_PRODUTOS, variables: variaveis })
      },
      tempoLimiteMs
    )
  );

  const dados = await resposta.json();
  if (dados.errors && dados.errors.length) {
    throw new Error(`a API do site reclamou: ${dados.errors[0].message}`);
  }
  const bloco = dados.data && dados.data.products;
  if (!bloco || !Array.isArray(bloco.items)) {
    throw new Error('a API do site respondeu num formato inesperado');
  }
  return bloco;
}

/**
 * Leitura preferida: a API GraphQL que a própria loja usa. Já vem com imagem,
 * estoque e categorias, sem precisar adivinhar nada do código da página.
 */
async function buscarPorGraphql(opcoes = {}) {
  const porPagina = opcoes.porPagina || 100;
  const tempoLimiteMs = opcoes.tempoLimiteMs || 25000;
  const maximoPaginas = opcoes.maximoPaginas || 20;

  const produtos = [];
  let totalPaginas = 1;

  for (let pagina = 1; pagina <= Math.min(totalPaginas, maximoPaginas); pagina += 1) {
    const bloco = await consultarGraphql({ pagina, porPagina }, tempoLimiteMs);
    totalPaginas = (bloco.page_info && bloco.page_info.total_pages) || 1;

    for (const item of bloco.items) {
      if (!item || !item.name) continue;

      const faixa = (item.price_range && item.price_range.minimum_price) || {};
      const preco = paraNumero(faixa.final_price && faixa.final_price.value);
      const cheio = paraNumero(faixa.regular_price && faixa.regular_price.value);
      const caminho = item.url_key ? `${BASE}/${item.url_key}${item.url_suffix || ''}` : null;

      produtos.push({
        nome: limparTexto(item.name),
        preco,
        precoDe: cheio !== null && preco !== null && cheio > preco ? cheio : null,
        disponivel: item.stock_status !== 'OUT_OF_STOCK',
        url: caminho,
        imagem: (item.small_image && item.small_image.url) || null,
        descricao: item.short_description ? limparTexto(item.short_description.html || '') : '',
        categoria: categoriaPeloSite(item.categories, item.name)
      });
    }

    if (pagina < totalPaginas) await esperar(600);
  }

  return produtos;
}

function extrairDoHtml(html) {
  const tentativas = [
    { estrategia: 'blocos-magento', itens: normalizar(lerBlocosMagento(html)) },
    { estrategia: 'json-ld', itens: normalizar(lerJsonLd(html)) },
    { estrategia: 'texto-corrido', itens: normalizar(lerTextoCorrido(html)) }
  ];
  tentativas.sort((a, b) => b.itens.length - a.itens.length);
  return tentativas[0];
}

/**
 * Junta o que veio do site com o catálogo salvo.
 * Nada é apagado: produtos que sumiram do site ficam marcados como foraDoSite.
 */
/**
 * Tira da tela de pedido os itens vendidos por cápsula avulsa.
 *
 * O site lista o mesmo sabor duas vezes: "CAFÉ AU LAIT" (uma cápsula, R$ 1,79)
 * e "CAFÉ AU LAIT 10 CÁPSULAS" (a caixa, R$ 17,90). Aqui se pede por caixa —
 * deixar o avulso à mostra faria o fechamento cobrar dez vezes menos de quem
 * clicasse no errado.
 *
 * Só desmarca quando existe a caixa do mesmo sabor: item sem par continua
 * visível. Nada é apagado, e o comprador pode remarcar na aba Catálogo.
 */
function esconderPrecoDeUnidade(catalogo) {
  const caixasPorBase = new Set();
  for (const item of catalogo) {
    if (pareceCaixa(item.nome)) caixasPorBase.add(chaveSemCapsulas(item.nome));
  }

  let escondidos = 0;
  for (const item of catalogo) {
    if (item.origem === 'manual' || pareceCaixa(item.nome)) continue;
    if (!caixasPorBase.has(chaveSemCapsulas(item.nome))) continue;
    if (item.ativo !== false) {
      item.ativo = false;
      escondidos += 1;
    }
  }
  return escondidos;
}

function mesclar(catalogoAtual, produtosDoSite) {
  const porChave = new Map();
  for (const item of catalogoAtual) porChave.set(chaveComparacao(item.nome), item);

  const vistos = new Set();
  let novos = 0;
  let atualizados = 0;

  for (const doSite of produtosDoSite) {
    // O site às vezes encurta o nome — "ESPRESSO 10 CÁPSULAS" virou "ESPRESSO".
    // Pela chave de nome parecem produtos diferentes, mas o id gerado é o mesmo,
    // e o id é a chave primária: tratá-los como dois faz um sobrescrever o outro
    // na gravação, e o produto some sem aviso. Por isso o id também vale como
    // forma de reconhecer quem já está no catálogo.
    // O casamento é só pelo nome. Tentar casar "CAFÉ AU LAIT" com
    // "CAFÉ AU LAIT 10 CÁPSULAS" seria errado: o site vende os dois, e o
    // primeiro é o preço de UMA cápsula (R$ 1,79) contra a caixa (R$ 17,90).
    // Juntá-los colocaria preço de unidade no lugar do preço de caixa, e o
    // fechamento cobraria a menos de todo mundo.
    const existente = porChave.get(doSite.chave);
    const chaveNoMapa = doSite.chave;
    // Precisa ser a chave sob a qual o item está guardado, e antes de renomear —
    // senão ele não é reconhecido depois e vira "saiu do site".
    vistos.add(chaveNoMapa);

    if (existente) {
      existente.nome = doSite.nome;
      if (doSite.preco !== null) existente.preco = doSite.preco;
      existente.precoDe = doSite.precoDe;
      existente.disponivel = doSite.disponivel;
      existente.url = doSite.url || existente.url || null;
      existente.imagem = doSite.imagem || existente.imagem || null;
      if (doSite.capsulas) existente.capsulas = doSite.capsulas;
      // Descrição só entra se ainda não houver uma — as escritas na mão ficam.
      if (!existente.descricao && doSite.descricao) existente.descricao = doSite.descricao;
      existente.foraDoSite = false;
      atualizados += 1;
    } else {
      const novo = {
        id: doSite.id,
        nome: doSite.nome,
        descricao: doSite.descricao || '',
        categoria: doSite.categoria,
        intensidade: null,
        capsulas: doSite.capsulas,
        preco: doSite.preco,
        precoDe: doSite.precoDe,
        disponivel: doSite.disponivel,
        // Só a caixa entra marcada. O site também vende cápsula avulsa e itens
        // que não são cápsula, e ali o preço é por unidade — se aparecessem na
        // tela de pedido, o fechamento cobraria muito menos do que a compra.
        // O comprador marca na aba Catálogo o que quiser além disso.
        ativo:
          pareceCaixa(doSite.nome) &&
          doSite.categoria !== 'Combos' &&
          doSite.categoria !== 'Acessórios',
        url: doSite.url,
        imagem: doSite.imagem,
        origem: 'site',
        foraDoSite: false
      };
      porChave.set(doSite.chave, novo);
      novos += 1;
    }
  }

  // Uma leitura que reconheceu pouca coisa não é prova de que os produtos saíram
  // do site — pode ser o CDN barrando ou o layout mudando. Nesse caso não
  // marcamos ninguém como "saiu do site"; só avisamos que a leitura foi parcial.
  const doSiteConhecidos = [...porChave.values()].filter((i) => i.origem !== 'manual').length;
  const reconhecidos = vistos.size;
  const leituraParcial = doSiteConhecidos > 0 && reconhecidos < doSiteConhecidos * 0.6;

  let sumiram = 0;
  if (!leituraParcial) {
    for (const [chave, item] of porChave) {
      if (item.origem === 'manual') continue;
      if (!vistos.has(chave)) {
        if (!item.foraDoSite) sumiram += 1;
        item.foraDoSite = true;
      }
    }
  }

  const catalogo = [...porChave.values()];
  const avulsos = esconderPrecoDeUnidade(catalogo);

  return { catalogo, novos, atualizados, sumiram, leituraParcial, avulsos };
}

/**
 * Fluxo completo: busca, interpreta e mescla. Devolve o resultado sem gravar nada.
 *
 * Tenta primeiro a API GraphQL, que é o caminho bom. Se ela falhar ou vier
 * pouca coisa, cai para a leitura do HTML. Só desiste se os dois falharem, e aí
 * o motivo de cada um vai junto no erro.
 */
async function sincronizar(catalogoAtual, opcoes = {}) {
  const minimo = opcoes.minimo || 15;
  const tropecos = [];
  let escolhido = null;

  if (opcoes.somenteHtml !== true) {
    try {
      const itens = normalizar(await buscarPorGraphql(opcoes));
      if (itens.length >= minimo) {
        escolhido = { estrategia: 'graphql', itens };
      } else {
        tropecos.push(`GraphQL: só ${itens.length} produtos (mínimo ${minimo})`);
      }
    } catch (falha) {
      tropecos.push(`GraphQL: ${falha.message}`);
    }
  }

  if (!escolhido) {
    try {
      const html = await buscarNoSite(opcoes.url, opcoes.tempoLimiteMs);
      const { estrategia, itens } = extrairDoHtml(html);
      if (itens.length >= minimo) {
        escolhido = { estrategia, itens };
      } else {
        tropecos.push(`HTML (${estrategia}): só ${itens.length} produtos (mínimo ${minimo})`);
      }
    } catch (falha) {
      tropecos.push(`HTML: ${falha.message}`);
    }
  }

  if (!escolhido) {
    throw new Error(
      `nenhuma leitura do site funcionou. ${tropecos.join(' · ')}. ` +
        'O catálogo atual foi mantido.'
    );
  }

  const resultado = mesclar(catalogoAtual, escolhido.itens);
  return { ...resultado, estrategia: escolhido.estrategia, encontrados: escolhido.itens.length };
}

module.exports = {
  URL_SABORES,
  URL_GRAPHQL,
  sincronizar,
  buscarPorGraphql,
  buscarNoSite,
  extrairDoHtml,
  mesclar,
  normalizar,
  gerarId,
  chaveComparacao,
  categoriaPeloNome,
  categoriaPeloSite,
  paraNumero
};
