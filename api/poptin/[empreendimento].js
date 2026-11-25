import crypto from "crypto";

/**
 * =========================
 * 1) CONFIG: slugs -> clientListingId
 * =========================
 * Slug é o que vai na URL: /api/poptin/<slug>
 * Ex: /api/poptin/recanto-da-mata
 */
const CLIENT_LISTING_BY_SLUG = {
  "teriva-alto-vila-paiva": "24",
  "teriva-bela-vista-campina-grande": "Campina Grande",
  "teriva-campina-grande": "23",
  "teriva-horizonte-vila-paiva": "26",
  "teriva-imperatriz": "4",
  "teriva-innovare": "18",
  "teriva-isla": "41",
  "teriva-praca-da-mata": "17",
  "teriva-recanto-da-mata": "43",
  "teriva-reserva-vila-paiva": "6",
  "teriva-vista-da-serra": "16",
  "terras-alphaville": "31", 
  "vivejo-mirante-da-pedra": "3",
  "vivejo-praca-das-aguas": "40",
  "vivejo-tangara": "38",
  "vivejo-terra-dos-ventos": "35",
};

/**
 * Fallback se o slug não existir no mapa
 * Você pode trocar para um id real, ou manter "site-poptin"
 */
const DEFAULT_CLIENT_LISTING_ID = "site-poptin";

/**
 * =========================
 * Helpers
 * =========================
 */
function onlyDigits(str) {
  return (str || "").toString().replace(/\D/g, "");
}

function normalizePoptinName(str) {
  let s = (str || "").toString().trim();

  // Remove prefixo "Simulação de financiamento - "
  s = s.replace(/^simula[cç][aã]o de financiamento\s*-\s*/i, "");

  // Normaliza espaços
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function buildReceiptId() {
  // ID curto pra auditoria/garantia
  return crypto.randomBytes(10).toString("hex"); // 20 chars
}

async function safePostJson(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

/**
 * =========================
 * Facilita (envio paralelo, em teste)
 * =========================
 * Liga só quando as TRÊS variáveis existem:
 *   FACILITA_URL      = https://teriva.api.facilitavendas.com/public/trackerform
 *   FACILITA_SELECTOR = id do formulário capturado no Facilita (um só para todo o Poptin).
 *                       NÃO MUDAR depois de configurado: o Facilita exige refazer o mapeamento.
 *                       O 1º POST com um selector novo só registra o formulário (o lead se perde):
 *                       configure o formulário no Facilita ANTES de apontar leads reais para ele.
 *   FACILITA_SLUGS    = lista separada por vírgula (ex: "teriva-recanto-da-mata")
 *                       ou "*" para todos os slugs do mapa.
 * Sem elas, nada muda: o lead segue só para a Laís, como antes.
 * O envio ao Facilita nunca altera a resposta dada ao Poptin (a Laís continua mandando).
 *
 * O formulário no Facilita lê o empreendimento do campo "empreendimento" do POST,
 * que precisa ser o ID do produto no Facilita (o NOME não é reconhecido).
 * ID ausente ou desconhecido: o lead cai no empreendimento padrão da fila.
 */
const FACILITA_TIMEOUT_MS = 8000;

/**
 * slug -> ID do empreendimento no Facilita (conferido no painel em 06/11/2026).
 * São os mesmos números do mapa da Laís, exceto Bela Vista (lá está "Campina Grande").
 * null = ID não confirmado: o lead vai sem empreendimento e cai no padrão da fila.
 */
const FACILITA_PRODUCT_ID_BY_SLUG = {
  "teriva-alto-vila-paiva": 24,
  "teriva-bela-vista-campina-grande": 15,
  "teriva-campina-grande": 23, // no Facilita o 23 é "Teriva Campina Grande 2 - Lago dos Ipês" (igual à Laís)
  "teriva-horizonte-vila-paiva": 26,
  "teriva-imperatriz": null, // a Laís usa 4; não confirmado no Facilita
  "teriva-innovare": 18,
  "teriva-isla": 41,
  "teriva-praca-da-mata": 17,
  "teriva-recanto-da-mata": 43,
  "teriva-reserva-vila-paiva": 6,
  "teriva-vista-da-serra": 16,
  "terras-alphaville": 31,
  "vivejo-mirante-da-pedra": null, // a Laís usa 3; não confirmado no Facilita
  "vivejo-praca-das-aguas": 40,
  "vivejo-tangara": 38,
  "vivejo-terra-dos-ventos": 35,
};

function facilitaEnabledFor(slug) {
  const url = process.env.FACILITA_URL;
  const selector = (process.env.FACILITA_SELECTOR || "").trim();
  const list = (process.env.FACILITA_SLUGS || "").trim();
  if (!url || !selector || !list) return false;
  if (!Object.prototype.hasOwnProperty.call(FACILITA_PRODUCT_ID_BY_SLUG, slug)) return false;
  if (list === "*") return true;
  return list.split(",").map((s) => s.trim().toLowerCase()).includes(slug);
}

/**
 * Lê a resposta do trackerform (sempre HTTP 200, o resultado vem no JSON):
 *   OK                  lead criado no empreendimento enviado
 *   OK_EMPREENDIMENTO_PADRAO  lead criado, mas sem empreendimento reconhecido (foi para o da fila)
 *   SO_REGISTROU        "data": false = formulário não configurado ou captura desligada: lead PERDIDO
 *   FAILED_<http>       erro HTTP, rede/timeout (0) ou JSON inesperado
 */
function readFacilitaResult(resp, sentProductId) {
  if (!resp || !resp.ok) return `FAILED_${resp ? resp.status : 0}`;
  let json;
  try {
    json = JSON.parse(resp.text);
  } catch {
    return `FAILED_${resp.status}_NAO_JSON`;
  }
  if (!json || json.status !== "success") return `FAILED_${resp.status}_STATUS`;
  if (!json.data) return "SO_REGISTROU";
  const gotProductId = Number(json.data.deal && json.data.deal.product_id) || 0;
  if (sentProductId && gotProductId === sentProductId) return "OK";
  return "OK_EMPREENDIMENTO_PADRAO";
}

async function safePostForm(url, fields) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(FACILITA_TIMEOUT_MS),
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (err) {
    // status 0 = não houve resposta (timeout ou rede). Não prova que o Facilita não recebeu.
    return { ok: false, status: 0, text: String(err) };
  }
}

/**
 * =========================
 * Handler
 * =========================
 */
export default async function handler(req, res) {
  // Só POST
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  // Secret via querystring (Poptin não manda header custom confiável)
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const incomingSecret = req.query?.secret;

  if (!expectedSecret) {
    return res.status(500).json({ success: false, message: "Missing WEBHOOK_SECRET env var" });
  }
  if (!incomingSecret || incomingSecret !== expectedSecret) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  // Vars
  const LAIS_URL = process.env.LAIS_URL;     // seu endpoint do Lastro/Lais
  const ORIGIN = process.env.ORIGIN || "PropWebsiteLais";

  // Auditoria (Apps Script)
  const AUDIT_URL = process.env.AUDIT_URL;       // https://script.google.com/macros/s/.../exec
  const AUDIT_SECRET = process.env.AUDIT_SECRET; // secret do Apps Script (pode ser igual ao WEBHOOK_SECRET ou outro)

  if (!LAIS_URL) {
    return res.status(500).json({ success: false, message: "Missing LAIS_URL env var" });
  }

  const receiptId = buildReceiptId();

  try {
    // Corpo do Poptin (pode vir como string ou objeto)
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // 1) Slug do empreendimento vindo da rota /api/poptin/<slug>
    const slugRaw = req.query?.empreendimento;
    const slug = (slugRaw || "").toString().trim().toLowerCase();

    const clientListingId = CLIENT_LISTING_BY_SLUG[slug] || DEFAULT_CLIENT_LISTING_ID;

    // 2) Campos do lead
    const name =
      body.full_name ||
      [body.first_name, body.last_name].filter(Boolean).join(" ").trim() ||
      "Lead sem nome";

    const email = (body.email || "").toString().trim();
    const message = (body.message || "").toString().trim();

    const rawPhone = (body.phone || "").toString();
    const digits = onlyDigits(rawPhone);

    // DDD e telefone
    let ddd = "";
    let phone = digits;

    if (digits.startsWith("55") && digits.length >= 12) {
      ddd = digits.slice(2, 4);
      phone = digits.slice(4);
    } else if (digits.length >= 10) {
      ddd = digits.slice(0, 2);
      phone = digits.slice(2);
    }

    const url = (body.url || body.referrer || "").toString().trim();

    const poptinTitle = normalizePoptinName(body.poptin_name || "");

    const formText =
      `Lead via Poptin | EmpreendimentoSlug: ${slug || "(sem slug)"} | ` +
      `Poptin: ${poptinTitle || "(sem nome)"} | Página: ${url || "(sem url)"} | ` +
      `Mensagem: ${message || "(sem mensagem)"}`;

    // 3) Payload pro Lastro/Lais
    const lastroPayload = {
      name,
      phone,
      formText,
      clientListingId,
      origin: ORIGIN,
    };

    if (ddd) lastroPayload.ddd = ddd;
    if (email) lastroPayload.email = email;
    if (url) lastroPayload.link = url;

    // 3b) Payload pro Facilita (só se ligado para este slug)
    const sendFacilita = facilitaEnabledFor(slug);
    const facilitaProductId = sendFacilita ? FACILITA_PRODUCT_ID_BY_SLUG[slug] : null;
    let facilitaPromise = Promise.resolve(null);

    if (sendFacilita) {
      const pageUrl = url || `https://${req.headers.host}/api/poptin/${slug}`;
      const facilitaFields = {
        facilita_custom_page: `Poptin - ${poptinTitle || slug}`,
        facilita_custom_url: pageUrl,
        facilita_custom_selector: process.env.FACILITA_SELECTOR.trim(),
        name,
        email,
        // telefone completo com DDD, sem o 55 (o mapeamento no Facilita escolhe qual usar)
        phone: `${ddd}${phone}`,
        mobile: `${ddd}${phone}`,
        message,
        obs: formText,
        empreendimento: facilitaProductId, // omitido quando null (safePostForm ignora vazios)
      };
      facilitaPromise = safePostForm(process.env.FACILITA_URL, facilitaFields);
    }

    // 4) Envia pro Lastro/Lais (e pro Facilita em paralelo, se ligado)
    const [lastroSettled, facilitaSettled] = await Promise.allSettled([
      safePostJson(LAIS_URL, lastroPayload),
      facilitaPromise,
    ]);

    // Mantém o comportamento antigo: erro de rede na Laís cai no catch abaixo
    if (lastroSettled.status === "rejected") throw lastroSettled.reason;
    const lastroResp = lastroSettled.value;

    const facilitaResp = facilitaSettled.status === "fulfilled" ? facilitaSettled.value : null;
    const facilitaStatus = !sendFacilita ? "SKIPPED" : readFacilitaResult(facilitaResp, facilitaProductId);

    // Log sem dados do lead. Corpo da resposta do Facilita só com FACILITA_DEBUG=1 (remover após o teste).
    if (sendFacilita) {
      console.log("facilita", { receiptId, slug, productId: facilitaProductId, facilitaStatus });
      if (process.env.FACILITA_DEBUG === "1" && facilitaResp) {
        console.log("facilita body", { receiptId, body: (facilitaResp.text || "").slice(0, 500) });
      }
    }

    // 5) Auditoria (não quebra o fluxo se falhar)
    if (AUDIT_URL && AUDIT_SECRET) {
      const auditPayload = {
        secret: AUDIT_SECRET,
        receiptId,
        empreendimento: slug,
        nome: name,
        telefone: phone,
        email,
        status: lastroResp.ok ? "SENT" : "FAILED",
        lastroStatus: lastroResp.status,
        facilitaStatus, // o Apps Script atual ignora; vira coluna se adicionarmos lá
        mensagem: message,
      };

      // fire-and-forget (mas aguardando pra registrar certinho)
      await safePostJson(AUDIT_URL, auditPayload);
    }

    // 6) Resposta
    if (lastroResp.ok && (lastroResp.status === 200 || lastroResp.status === 201)) {
      return res.status(201).json({
        success: true,
        receiptId,
        empreendimento: slug,
        clientListingIdResolved: clientListingId,
        lastroStatus: lastroResp.status,
        facilitaStatus,
      });
    }

    return res.status(502).json({
      success: false,
      receiptId,
      empreendimento: slug,
      clientListingIdResolved: clientListingId,
      message: "Lastro returned non-success status",
      lastroStatus: lastroResp.status,
      facilitaStatus,
      lastroBody: (lastroResp.text || "").slice(0, 2000),
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      receiptId,
      message: "Invalid request body",
      error: String(err),
    });
  }
}
