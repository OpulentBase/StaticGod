export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Only allow kie.ai and related domains
  const allowed = [
    "tempfile.redpandaai.co",
    "kieai.redpandaai.co",
    "kie.ai",
    "api.kie.ai",
    "file.aiquickdraw.com",
  ];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const isAllowed = allowed.some((domain) => parsedUrl.hostname.endsWith(domain));
  if (!isAllowed) {
    return res.status(403).json({ error: "Domain not allowed" });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: "Upstream error" });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = await response.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
