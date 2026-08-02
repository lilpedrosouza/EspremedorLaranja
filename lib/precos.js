'use strict';

/**
 * Análise dos preços guardados na tabela `precos`.
 *
 * Só contas: não fala com o banco nem com o HTTP. Recebe os pontos no formato
 * { preco, em } e devolve o que a tela mostra — se o preço de hoje está acima ou
 * abaixo do normal daquele sabor, e qual dia da semana costuma sair mais barato.
 *
 * A ideia toda depende de um detalhe: cada ponto vale do momento em que foi
 * gravado até o ponto seguinte. Preço não é uma medição pontual como temperatura,
 * é um degrau que fica de pé até alguém mudar.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Fuso de Brasília. O servidor roda em UTC na Railway, e "que dia da semana era"
 * precisa ser respondido no fuso de quem compra: um preço gravado às 01:00 de
 * terça em UTC ainda é segunda à noite aqui, e entraria no dia errado da conta.
 * O Brasil não tem mais horário de verão desde 2019, então o -3 fixo serve.
 */
const FUSO_BRASIL_MS = 3 * 60 * 60 * 1000;

const NOMES_DOS_DIAS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado'
];

/** Quantos dias de histórico até valer a pena falar em "média". */
const MINIMO_DIAS = 7;

/** Diferença de até 1% para cima ou para baixo conta como "na média". */
const FAIXA_NEUTRA = 0.01;

/** Três semanas: o mínimo para cada dia da semana ter aparecido umas três vezes. */
const MINIMO_DIAS_OBSERVADOS = 21;

/** Sem preço mudando não existe "melhor dia" — existe um preço só. */
const MINIMO_MUDANCAS = 4;

/** Abaixo de meio por cento de diferença entre o melhor e o pior dia, é ruído. */
const DIFERENCA_MINIMA = 0.005;

/** O dia (à meia-noite de Brasília) em que um instante caiu, como número. */
function marcaDoDia(quando) {
  const data = new Date(new Date(quando).getTime() - FUSO_BRASIL_MS);
  return Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate());
}

function diaDaSemana(marca) {
  return new Date(marca).getUTCDay();
}

/**
 * Média ponderada pelo tempo: cada preço pesa quanto tempo ficou valendo.
 *
 * A média simples dos pontos mentiria. Um sabor que passou cinco meses a R$ 25 e
 * dois dias em promoção a R$ 18 tem média simples de R$ 21,50 — como se metade do
 * semestre tivesse sido promoção. Ponderando pelo tempo dá ~R$ 24,90, que é o
 * preço que a pessoa realmente encontraria num dia qualquer.
 */
function mediaPonderada(pontos, agora) {
  if (!pontos.length) return null;

  const fim = new Date(agora).getTime();
  let soma = 0;
  let tempo = 0;

  for (let i = 0; i < pontos.length; i += 1) {
    const inicio = new Date(pontos[i].em).getTime();
    const termino = i + 1 < pontos.length ? new Date(pontos[i + 1].em).getTime() : fim;
    const duracao = Math.max(termino - inicio, 0);
    soma += pontos[i].preco * duracao;
    tempo += duracao;
  }

  // Ponto único recém-gravado: não há tempo decorrido para ponderar.
  return tempo > 0 ? soma / tempo : pontos[pontos.length - 1].preco;
}

/**
 * O veredito de um produto: o preço de agora contra a própria média dele.
 *
 * `situacao` é 'abaixo' | 'acima' | 'media' | 'sem-dados'. O 'sem-dados' não é
 * erro: é o estado normal de quem acabou de instalar o sistema, e a tela precisa
 * saber a diferença entre "está no preço de sempre" e "ainda não sei dizer".
 */
function resumo(pontos, precoAtual, agora = Date.now()) {
  const lista = (pontos || []).filter((ponto) => Number(ponto.preco) > 0);
  const preco = Number(precoAtual) || 0;

  const vazio = {
    situacao: 'sem-dados',
    media: null,
    minimo: null,
    maximo: null,
    diferenca: null,
    percentual: null,
    pontos: lista.length,
    dias: 0,
    desde: lista.length ? lista[0].em : null
  };
  if (!lista.length || preco <= 0) return vazio;

  const dias = Math.max(0, (new Date(agora).getTime() - new Date(lista[0].em).getTime()) / DIA_MS);
  const media = mediaPonderada(lista, agora);
  const valores = [...lista.map((ponto) => ponto.preco), preco];

  const base = {
    media,
    minimo: Math.min(...valores),
    maximo: Math.max(...valores),
    pontos: lista.length,
    dias: Math.round(dias),
    desde: lista[0].em
  };

  // Histórico curto demais para chamar de média: mostra os números, mas não
  // afirma "está barato". Uma semana com um preço só é o preço, não a média dele.
  if (dias < MINIMO_DIAS || !media) {
    return { ...base, situacao: 'sem-dados', diferenca: null, percentual: null };
  }

  const diferenca = preco - media;
  const percentual = diferenca / media;
  const situacao = Math.abs(percentual) < FAIXA_NEUTRA ? 'media' : percentual < 0 ? 'abaixo' : 'acima';

  return { ...base, situacao, diferenca, percentual };
}

/**
 * O preço em vigor em cada dia, do primeiro ponto até hoje.
 *
 * Arrastar o último preço conhecido dia a dia é o que permite responder "quanto
 * custava na terça" nas terças em que nada mudou. Sem isso a conta por dia da
 * semana só enxergaria os dias de mudança — que são poucos, e cairiam quase
 * sempre no dia em que o site resolveu mexer no preço, não no dia barato.
 */
function serieDiaria(pontos, agora = Date.now()) {
  if (!pontos || !pontos.length) return [];

  const ordenados = [...pontos].sort((a, b) => new Date(a.em) - new Date(b.em));
  const hoje = marcaDoDia(agora);
  const dias = [];

  let indice = 0;
  let preco = ordenados[0].preco;

  for (let dia = marcaDoDia(ordenados[0].em); dia <= hoje; dia += DIA_MS) {
    while (indice < ordenados.length && marcaDoDia(ordenados[indice].em) <= dia) {
      preco = ordenados[indice].preco;
      indice += 1;
    }
    dias.push({ dia, preco });
  }
  return dias;
}

/**
 * Qual dia da semana costuma ter os preços mais baixos.
 *
 * Cada produto entra pela variação relativa à média dele mesmo, e não pelo valor
 * em reais: senão as cápsulas caras decidiriam a resposta sozinhas, só por serem
 * caras. O resultado é "na terça os preços ficam 2% abaixo do normal", que é o
 * que interessa para escolher o dia da compra.
 *
 * Devolve `suficiente: false` enquanto não houver histórico que sustente a
 * conclusão — é melhor dizer "ainda não sei" do que apontar um dia sorteado no
 * ruído de duas semanas de dados.
 */
function melhorDiaDaSemana(historicoPorProduto, agora = Date.now()) {
  const acumulado = Array.from({ length: 7 }, () => ({ total: 0, amostras: 0 }));
  let diasObservados = 0;
  let mudancas = 0;
  let produtos = 0;

  for (const pontos of historicoPorProduto.values()) {
    // Preço que nunca mudou não diz nada sobre dia da semana: entraria com
    // variação zero em todos os sete dias e só diluiria quem tem o que dizer.
    if (!pontos || pontos.length < 2) continue;

    const serie = serieDiaria(pontos, agora);
    if (!serie.length) continue;

    const media = serie.reduce((soma, dia) => soma + dia.preco, 0) / serie.length;
    if (!(media > 0)) continue;

    produtos += 1;
    mudancas += pontos.length - 1;
    diasObservados = Math.max(diasObservados, serie.length);

    for (const { dia, preco } of serie) {
      const indice = diaDaSemana(dia);
      acumulado[indice].total += (preco - media) / media;
      acumulado[indice].amostras += 1;
    }
  }

  const dias = acumulado.map((soma, indice) => ({
    dia: indice,
    nome: NOMES_DOS_DIAS[indice],
    percentual: soma.amostras ? soma.total / soma.amostras : null,
    amostras: soma.amostras
  }));

  const comDados = dias.filter((dia) => dia.percentual !== null);
  const base = { dias, diasObservados, mudancas, produtos, melhor: null, pior: null, espalhamento: null };

  if (!produtos || comDados.length < 7 || diasObservados < MINIMO_DIAS_OBSERVADOS || mudancas < MINIMO_MUDANCAS) {
    const faltam = Math.max(0, MINIMO_DIAS_OBSERVADOS - diasObservados);
    return {
      ...base,
      suficiente: false,
      motivo: !produtos
        ? 'O histórico de preços começa a ser gravado na próxima leitura do site. Volte aqui em algumas semanas.'
        : faltam > 0
          ? `Faltam cerca de ${faltam} dias de histórico para comparar os dias da semana com alguma segurança.`
          : `Os preços mudaram só ${mudancas} vez(es) até agora — pouco para dizer que um dia é melhor que outro.`
    };
  }

  const ordenados = [...comDados].sort((a, b) => a.percentual - b.percentual);
  const melhor = ordenados[0];
  const pior = ordenados[ordenados.length - 1];
  const espalhamento = pior.percentual - melhor.percentual;

  // Sete dias praticamente iguais é uma resposta legítima: o site não mexe em
  // preço por dia da semana. Apontar um "melhor dia" aí seria inventar padrão.
  if (espalhamento < DIFERENCA_MINIMA) {
    return {
      ...base,
      suficiente: true,
      espalhamento,
      motivo: 'Os preços praticamente não mudam conforme o dia da semana — pode comprar no dia que for melhor pra você.'
    };
  }

  return { ...base, suficiente: true, melhor, pior, espalhamento, motivo: null };
}

/**
 * Como o total da lista de hoje se compara com o que ela custaria, em média, nos
 * últimos meses. É a pergunta prática do comprador na hora de fechar a rodada:
 * compro agora ou espero?
 */
function momentoDaLista(itens, historicoPorProduto, agora = Date.now()) {
  let total = 0;
  let totalMedio = 0;
  let itensComHistorico = 0;

  for (const item of itens || []) {
    const quantidade = Number(item.quantidade) || 0;
    const preco = Number(item.preco) || 0;
    if (quantidade <= 0 || preco <= 0) continue;

    total += preco * quantidade;

    const analise = resumo(historicoPorProduto.get(item.produtoId) || [], preco, agora);
    if (analise.media && analise.situacao !== 'sem-dados') {
      totalMedio += analise.media * quantidade;
      itensComHistorico += 1;
    } else {
      // Sem história, o preço de hoje é a melhor estimativa que existe do preço
      // normal dele — entra dos dois lados e não distorce a comparação.
      totalMedio += preco * quantidade;
    }
  }

  if (!total || !itensComHistorico) {
    return { suficiente: false, total, totalMedio: null, diferenca: null, percentual: null, situacao: 'sem-dados', itensComHistorico };
  }

  const percentual = (total - totalMedio) / totalMedio;
  const situacao = Math.abs(percentual) < FAIXA_NEUTRA ? 'media' : percentual < 0 ? 'abaixo' : 'acima';

  return {
    suficiente: true,
    total,
    totalMedio,
    diferenca: total - totalMedio,
    percentual,
    situacao,
    itensComHistorico
  };
}

module.exports = {
  NOMES_DOS_DIAS,
  marcaDoDia,
  mediaPonderada,
  resumo,
  serieDiaria,
  melhorDiaDaSemana,
  momentoDaLista
};
