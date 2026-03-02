import crypto from "crypto";

const CLIENT_LISTING_ID = "40";

function normalizeText(str) {
  return (str || "").toString().trim();
}

function onlyDigits(str) {
  return (str || "").toString().replace(/\D/g, "");
}

async function postJson(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  return { status: resp.status, text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false });
  }

  // 🔐 Secret
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const incomingSecret = req.query?.secret;

  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const LASTRO_URL = process.env.LASTRO_URL;
  const AUDIT_URL = process.env.AUDIT_URL;
  const AUDIT_SECRET = process.env.AUDIT_SECRET;
  const ORIGIN = process.env.ORIGIN || "PropWebsiteLais";

  if (!LASTRO_URL || !AUDIT_URL || !AUDIT_SECRET) {
    return res.status(500).json({ success: false, message: "Missing env vars" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ success: false, message: "Invalid body" });
  }

  const name =
    normalizeText(body?.full_name) ||
    normalizeText([body?.first_name, body?.last_name].filter(Boolean).join(" ")) ||
    "Lead sem nome";

  const email = normalizeText(body?.email);
  const rawPhone = normalizeText(body?.phone);
  const message = normalizeText(body?.message);
  const url = normalizeText(body?.url) || normalizeText(body?.referrer);

  const digits = onlyDigits(rawPhone);
  let ddd = "";
  let phone = digits;

  if (digits.startsWith("55") && digits.length >= 12) {
    ddd = digits.slice(2, 4);
    phone = digits.slice(4);
  } else if (digits.length >= 10) {
    ddd = digits.slice(0, 2);
    phone = digits.slice(2);
  }

  const receiptId = crypto.randomUUID();

  // 📋 Auditoria RECEIVED
  await postJson(AUDIT_URL, {
    secret: AUDIT_SECRET,
    receiptId,
    empreendimento: "vivejo-praca-das-aguas",
    nome: name,
    telefone: phone,
    email,
    status: "RECEIVED",
    mensagem: message || "",
  });

  const lastroPayload = {
    name,
    phone,
    clientListingId: CLIENT_LISTING_ID,
    origin: ORIGIN,
    formText: `Lead via Poptin | Vivejo Praça das Aguas | Página: ${url || "(sem url)"} | Mensagem: ${message || "(sem mensagem)"}`,
  };

  if (ddd) lastroPayload.ddd = ddd;
  if (email) lastroPayload.email = email;
  if (url) lastroPayload.link = url;

  const lastroResp = await postJson(LASTRO_URL, lastroPayload);

  const forwardedOk =
    lastroResp.status === 200 || lastroResp.status === 201;

  // 📋 Auditoria FINAL
  await postJson(AUDIT_URL, {
    secret: AUDIT_SECRET,
    receiptId,
    empreendimento: "vivejo-praca-das-aguas",
    nome: name,
    telefone: phone,
    email,
    status: forwardedOk ? "FORWARDED" : "FAILED",
    lastroStatus: String(lastroResp.status),
    mensagem: forwardedOk ? "" : lastroResp.text,
  });

  return res.status(forwardedOk ? 201 : 502).json({
    success: forwardedOk,
    receiptId,
    lastroStatus: lastroResp.status,
  });
}