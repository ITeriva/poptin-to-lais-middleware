// Deprecated endpoint.
// We moved to per-empreendimento routes: /api/poptin/<slug>?secret=...
// This file is kept only to avoid confusion and to return a clear error.

export default async function handler(req, res) {
  // Allow simple health check in browser
  if (req.method === "GET") {
    return res.status(200).send(
      "OK. Use /api/poptin/<empreendimento>?secret=... (this /api/poptin endpoint is deprecated)."
    );
  }

  return res.status(410).json({
    success: false,
    message:
      "Deprecated endpoint. Use /api/poptin/<empreendimento>?secret=... instead of /api/poptin.",
  });
}