'use strict';

/**
 * Envio de e-mail pela API do Brevo.
 *
 * HTTP puro com `fetch`, sem dependência nova — a mesma forma que
 * `lib/catalogo-nescafe.js` usa para falar com o site da Nescafé. Só monta a
 * requisição e traduz a falha para português; quem decide o que escrever é o
 * `servidor.js`.
 *
 * Precisa de duas variáveis de ambiente:
 *   BREVO_API_KEY     a chave em Brevo → SMTP & API → API Keys
 *   EMAIL_REMETENTE   o endereço verificado em Brevo → Senders
 *
 * Sem elas o módulo não quebra: `configurado()` devolve false e as rotas
 * explicam para a pessoa que o caminho do e-mail não está disponível. O sistema
 * inteiro continua funcionando sem e-mail nenhum.
 */

const URL_BREVO = 'https://api.brevo.com/v3/smtp/email';
const TEMPO_LIMITE_MS = 15000;

function chave() {
  return (process.env.BREVO_API_KEY || '').trim();
}

function remetente() {
  return (process.env.EMAIL_REMETENTE || '').trim();
}

function nomeDoRemetente() {
  return (process.env.EMAIL_REMETENTE_NOME || 'Espremedor de Laranja').trim();
}

/** Dá para enviar e-mail nesta instalação? */
function configurado() {
  return Boolean(chave() && remetente());
}

/**
 * Conferência de e-mail deliberadamente frouxa.
 *
 * Validar endereço por expressão regular é uma armadilha conhecida: as regras
 * de verdade são absurdas e toda regex "completa" acaba recusando endereço
 * válido de gente real. Aqui só barramos o que claramente não é endereço; quem
 * digitar errado descobre porque o link não chega.
 */
function pareceEmail(bruto) {
  const texto = String(bruto || '').trim();
  return texto.length >= 5 && texto.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(texto);
}

function normalizarEmail(bruto) {
  return String(bruto || '').trim().toLowerCase();
}

/**
 * Manda um e-mail. Devolve o id da mensagem no Brevo, ou levanta erro com o
 * motivo em português.
 */
async function enviar({ para, nomeDoDestinatario, assunto, texto, html }) {
  if (!configurado()) throw new Error('o envio de e-mail não está configurado neste servidor');
  if (!pareceEmail(para)) throw new Error('endereço de e-mail inválido');

  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);

  try {
    const resposta = await fetch(URL_BREVO, {
      method: 'POST',
      headers: {
        'api-key': chave(),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: remetente(), name: nomeDoRemetente() },
        to: [{ email: para, ...(nomeDoDestinatario ? { name: nomeDoDestinatario } : {}) }],
        subject: assunto,
        textContent: texto,
        htmlContent: html
      }),
      signal: controle.signal
    });

    if (!resposta.ok) {
      // O Brevo devolve o motivo em JSON; o texto cru serve de reserva quando
      // vem uma página de erro do proxy dele.
      let detalhe = '';
      try {
        const corpo = await resposta.json();
        detalhe = corpo && (corpo.message || corpo.code) ? ` — ${corpo.message || corpo.code}` : '';
      } catch {
        detalhe = '';
      }
      if (resposta.status === 401) {
        throw new Error(`o Brevo recusou a chave de API (HTTP 401)${detalhe}`);
      }
      if (resposta.status === 400) {
        throw new Error(
          `o Brevo recusou a mensagem (HTTP 400)${detalhe}. Confira se o EMAIL_REMETENTE está verificado em Brevo → Senders.`
        );
      }
      throw new Error(`o Brevo respondeu HTTP ${resposta.status}${detalhe}`);
    }

    const corpo = await resposta.json().catch(() => ({}));
    return corpo.messageId || null;
  } catch (falha) {
    if (falha.name === 'AbortError') {
      throw new Error(`o Brevo não respondeu em ${Math.round(TEMPO_LIMITE_MS / 1000)}s`);
    }
    throw falha;
  } finally {
    clearTimeout(alarme);
  }
}

module.exports = { configurado, enviar, pareceEmail, normalizarEmail };
