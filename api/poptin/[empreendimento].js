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
 * Handler
 * =========================
 */
export default async function handler(req, res) {
  if (req.query?.debug === "1") { const e = process.env.WEBHOOK_SECRET || ""; const i = String(req.query?.secret || ""); return res.status(200).json({ env_len: e.length, env_f2: e.slice(0,2), env_l2: e.slice(-2), in_len: i.length, in_f2: i.slice(0,2), in_l2: i.slice(-2), matches: i===e, lais_url_set: !!process.env.LAIS_URL, origin: process.env.ORIGIN || null }); } // Só POST
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

    // 4) Envia pro Lastro/Lais
    const lastroResp = await safePostJson(LAIS_URL, lastroPayload);

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
      });
    }

    return res.status(502).json({
      success: false,
      receiptId,
      empreendimento: slug,
      clientListingIdResolved: clientListingId,
      message: "Lastro returned non-success status",
      lastroStatus: lastroResp.status,
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
