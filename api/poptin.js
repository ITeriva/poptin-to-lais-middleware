function normalize(str) {
    return (str || "")
      .toString()
      .trim()
      .toLowerCase();
  }

  function normalizePoptinName(str) {
    let s = (str || "").toString().trim().toLowerCase();
  
    // Remove prefixos comuns (adicione outros se existirem)
    s = s.replace(/^simula[cç][aã]o de financiamento\s*-\s*/i, "");
    s = s.replace(/^simulacao de financiamento\s*-\s*/i, ""); // redundante, mas ok
  
    // Normaliza espaços múltiplos
    s = s.replace(/\s+/g, " ").trim();
  
    return s;
  }
  
  async function getMappingFromCsv(csvUrl) {
    const resp = await fetch(csvUrl);
    if (!resp.ok) throw new Error(`Failed to fetch CSV: ${resp.status}`);
    const text = await resp.text();
  
    // CSV simples: poptin_name,clientListingId,active
    // Aceita ; ou , como separador (tem planilha que exporta com ;)
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return new Map();
  
    const header = lines[0];
    const delimiter = header.includes(";") ? ";" : ",";
    const headers = header.split(delimiter).map(h => normalize(h));
  
    const idxPoptin = headers.indexOf("poptin_name");
    const idxClient = headers.indexOf("clientlistingid");
    const idxActive = headers.indexOf("active");
  
    const map = new Map();
  
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delimiter);
      const poptinName = normalizePoptinName(cols[idxPoptin]);
      const clientListingId = (cols[idxClient] || "").toString().trim();
      const active = idxActive >= 0 ? normalize(cols[idxActive]) : "true";
  
      if (!poptinName || !clientListingId) continue;
      if (active && active !== "true" && active !== "1" && active !== "yes") continue;
  
      map.set(poptinName, clientListingId);
    }
  
    return map;
  }
  
  export default async function handler(req, res) {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, message: "Method not allowed" });
    }

    const expectedSecret = process.env.WEBHOOK_SECRET;
    const incomingSecret = req.query?.secret;

    if (!expectedSecret) {
      return res.status(500).json({
        success: false,
        message: "Missing WEBHOOK_SECRET env var",
      });
    }

    if (!incomingSecret || incomingSecret !== expectedSecret) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }
  
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  
      const LASTRO_URL = process.env.LASTRO_URL;
      const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
      const DEFAULT_CLIENT_LISTING_ID = process.env.DEFAULT_CLIENT_LISTING_ID || "site-poptin";
      const ORIGIN = process.env.ORIGIN || "PropWebsiteLais";
  
      if (!LASTRO_URL) {
        return res.status(500).json({ success: false, message: "Missing LASTRO_URL env var" });
      }
      if (!SHEET_CSV_URL) {
        return res.status(500).json({ success: false, message: "Missing SHEET_CSV_URL env var" });
      }
  
      // Poptin fields
      const name =
        body.full_name ||
        [body.first_name, body.last_name].filter(Boolean).join(" ").trim() ||
        "Lead sem nome";
  
      const email = body.email || "";
      const rawPhone = (body.phone || "").toString();
      const message = (body.message || "").toString().trim();
      const url = body.url || body.referrer || "";
  
      // Identify empreendimento by poptin_name (or fallback)
      const poptinName = normalizePoptinName(body.poptin_name || body.source || ""); // source="Poptin" não ajuda, mas fica como fallback
  
      const mapping = await getMappingFromCsv(SHEET_CSV_URL);
      const clientListingId = mapping.get(poptinName) || DEFAULT_CLIENT_LISTING_ID;
  
      // formText nunca vazio
      const formText = `Lead via Poptin | Poptin: ${body.poptin_name || "(sem nome)"} | Página: ${url || "(sem url)"} | Mensagem: ${message || "(sem mensagem)"}`;
  
      // telefone: tenta separar ddd
      const digits = rawPhone.replace(/\D/g, "");
      let ddd = "";
      let phone = digits;
  
      if (digits.startsWith("55") && digits.length >= 12) {
        ddd = digits.slice(2, 4);
        phone = digits.slice(4);
      } else if (digits.length >= 10) {
        ddd = digits.slice(0, 2);
        phone = digits.slice(2);
      }
  
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
  
      const resp = await fetch(LASTRO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastroPayload),
      });
  
      const respText = await resp.text();
  
      if (resp.status === 200 || resp.status === 201) {
        return res.status(201).json({
          success: true,
          message: "Forwarded to Lastro",
          lastroStatus: resp.status,
          clientListingIdResolved: clientListingId,
        });
      }
  
      return res.status(502).json({
        success: false,
        message: "Lastro returned non-success status",
        lastroStatus: resp.status,
        lastroBody: respText.slice(0, 2000),
      });
    } catch (err) {
      return res.status(400).json({ success: false, message: "Invalid request body", error: String(err) });
    }
  }