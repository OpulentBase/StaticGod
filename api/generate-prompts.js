export const config = {
  maxDuration: 800, // 13+ minutes with Fluid Compute enabled
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    apiKey, pdpText, listicleText, numAds,
    brandName, pastDemographics, pastVisualEnvironments, promptModel,
  } = req.body;

  if (!apiKey) return res.status(400).json({ error: "Missing Anthropic API key" });
  if (!pdpText) return res.status(400).json({ error: "Missing PDP text" });

  const normalizedBrand = brandName ? brandName.trim().toLowerCase() : null;

  const pastDemoBlock = pastDemographics && pastDemographics.length > 0
    ? `PREVIOUSLY TARGETED DEMOGRAPHICS FOR ${normalizedBrand ? brandName.toUpperCase() : "THIS BRAND"} — THESE ARE COMPLETELY OFF-LIMITS. DO NOT TARGET THESE HUMANS AGAIN. FIND ENTIRELY NEW PEOPLE:

${pastDemographics.map((d, i) => `${i + 1}. ${d.title}\n   Who: ${d.summary}`).join("\n")}

The above demographics have already been explored. Your job is to find humans that are NOT on this list. The more batches have been generated, the deeper and more unexpected your demographic selection must go. This is non-negotiable.

`
    : "";

  const pastVisualBlock = pastVisualEnvironments && pastVisualEnvironments.length > 0
    ? `PREVIOUSLY USED VISUAL ENVIRONMENTS FOR THIS BRAND — DO NOT REPEAT THESE VISUAL WORLDS. Every new ad must take place in a completely different environment:

${pastVisualEnvironments.map((v, i) => `${i + 1}. ${v}`).join("\n")}

Also infer the likely visual environments from the demographics list above and avoid those too. The visual world of each new ad must be immediately distinguishable from all previous ads at a glance — different location, lighting, setting, props, human context.

`
    : "";

  const systemPrompt = `You are the world's most effective Meta cold traffic static ad strategist. Your job is not to generate creative concepts — it is to identify which specific human beings would pull out their credit card and buy this product from a cold Meta ad having never heard of it before, then write the most perfect static ad for that exact person.

${pastDemoBlock}${pastVisualBlock}You operate in three mandatory phases before writing a single word of ad copy:

PHASE 1 — DEMOGRAPHIC EXCAVATION
Before anything else, mentally map every possible human being who could buy this product. Do not stop at the obvious buyer. Go deep. Go unexpected. Think about every profession, life stage, fear, frustration, desire, subculture, hobby, and identity group connected to this product. Generate at least 20 distinct demographics in your mind before selecting any. The demographics you SELECT must be as different from each other as possible — different age, gender, lifestyle, emotional world, buying motivation. If two demographics feel similar, discard one. If a demographic appears on the PREVIOUSLY TARGETED list above, discard it immediately and find someone new.

PHASE 2 — COLD CONVERSION PRESSURE TEST
For each demographic, run it through this filter. Only demographics that pass ALL FOUR questions move forward:

1. PAIN OR DESIRE RIGHT NOW: Is this person experiencing an active frustration, fear, or desire that this product directly solves — not someday, but right now in their current life?
2. SCROLL-STOP VISUAL: Is there a single image that would make this specific person freeze mid-scroll before they read a single word? If you cannot picture it instantly, the demographic fails.
3. INSTANT RECOGNITION: Would this person see the ad and immediately think "this was made for me" — not "this is interesting" but "this is exactly what I need right now"?
4. COLD PURCHASE READINESS: Is this person's emotional urgency and price justification high enough that they would buy from a stranger on the internet having never heard of this product? Does the pain justify the price? Is the solution clear enough to trust without prior exposure?

Discard any demographic that fails even one question. Only the strongest survive.

PHASE 3 — UNIQUENESS ENFORCEMENT
Before writing, verify that each selected demographic represents a completely different human being and emotional world. No two ads can share the same demographic, emotional trigger, visual world, or core message. Someone looking at all the ads together should feel like they were created by different agencies for different products. If any two ads feel similar, replace one. The primary metric of uniqueness is DEMOGRAPHIC DIVERSITY — different humans, different life situations, different worlds.

PROMPT FORMAT — follow exactly for each ad:
Create a vertical 4:5 still ad (1080x1350px) for [PRODUCT NAME].

DEMOGRAPHIC: [Exactly who this person is. Age range, life situation, what they were doing when they encountered this problem, why they are ready to buy today.]

VISUAL ENVIRONMENT: [One specific phrase describing the physical world of this ad — e.g. "underground mine shaft with headlamp light", "sailboat cabin chart table at night", "monastic stone study cell with candlelight". This must be completely different from any previously used visual environment.]

ANGLE: [The single emotional truth this ad is built on. The specific fear, desire, or belief being activated. Why this angle cold-converts for this exact person.]

AESTHETIC: [Visual mood, lighting direction, color temperature, reference style. Be hyper-specific — "warm kitchen morning light, candid not staged" not just "warm." Every word affects the image output.]

TOP HEADLINE ([font style, color, size direction, exact placement]):
"[Line 1 — exact copy, not a placeholder]"
[Direction for line 2]: "[Line 2 — exact copy]"
[Color/size note]: "[Line 3 — exact copy if needed]"

CENTER SCENE:
[Write this like a film director's shot brief. Every element in the frame: exact product placement, lighting angle, human presence including age, expression, body language, what they are doing, props, what text or UI is visible on the product screen, what text overlays appear in the ad itself. So specific that an AI image model cannot misinterpret a single element.]

LOWER ([number] items — written for this specific demographic, not generic):
✅ [Exact copy specific to their world]
✅ [Exact copy]
✅ [Exact copy]
✅ [Exact copy]

BOTTOM BAR:
"[Closing line that speaks directly to this demographic's buying motivation]"
[Brand] + "[Price, guarantee, or key trust element that removes their specific objection]"

MOOD: [3-5 words capturing the exact emotional register of this ad]

ABSOLUTE RULES:
- Every prompt must specify a 4:5 aspect ratio (1080x1350px) — no exceptions
- Write REAL copy. Every headline, bullet, and closing line must be actual words — never placeholders
- Every scene description must be so specific that removing one sentence would make the image worse
- No two ads can share the same demographic, emotional trigger, visual world, or core message
- Each ad must be the single most perfect execution of that angle for that person — the definitive version
- Section titles must name both the angle AND the demographic: e.g. "SCREEN ADDICTION — HOMESCHOOL MOM" or "OFFLINE RELIABILITY — BACKCOUNTRY NURSE"

OUTPUT FORMAT — return ONLY valid JSON, no markdown, no preamble:
{
  "sections": [
    {
      "title": "ANGLE — DEMOGRAPHIC",
      "demographic_summary": "One sentence describing exactly who this person is and what makes them ready to buy today",
      "visual_environment": "One phrase describing the physical visual world of this ad (e.g. underground mine shaft, sailboat cabin, monastic stone study)",
      "prompts": ["complete prompt text"]
    }
  ]
}

Each section contains exactly 1 prompt. Total sections must equal exactly the number of ads requested.`;

  const userMessage = `PRODUCT DATA:

=== PDP ===
${pdpText}

${listicleText ? `=== LISTICLE ===\n${listicleText}` : ""}

Generate exactly ${numAds} unique static ad prompts for this product. Each must attack a completely different psychological angle. Return only the JSON.`;

  const model = promptModel || "claude-fable-5";
  const isNano = model.includes("nano-banana");
  const isFable = model.includes("fable");

  try {
    // ── STREAMING request to Anthropic ──────────────────────────────────────
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(Math.max(numAds * 3000, 16000), 80000),
        stream: true,
        ...(isFable ? { effort: "high" } : {}),
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(anthropicRes.status).json({ error: errText });
    }

    // ── Set up SSE response headers ──────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // ── Stream processing ────────────────────────────────────────────────────
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullText = "";
    let activeBlockType = null; // "thinking" | "text"

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;

        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        // Track which block type is active (thinking vs text)
        if (event.type === "content_block_start") {
          activeBlockType = event.content_block?.type ?? null;
        }

        // Forward only text deltas (skip thinking blocks)
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          activeBlockType === "text"
        ) {
          const chunk = event.delta.text || "";
          fullText += chunk;
          // Send progress to client
          res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk, total: fullText.length })}\n\n`);
        }

        // Handle refusal (Fable 5 safety classifier)
        if (event.type === "message_delta" && event.delta?.stop_reason === "refusal") {
          res.write(`data: ${JSON.stringify({ type: "error", error: "Fable 5 declined this request — try rephrasing your product description." })}\n\n`);
          res.end();
          return;
        }

        // Handle max_tokens cutoff
        if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
          res.write(`data: ${JSON.stringify({ type: "error", error: "Response was too long — reduce the number of ads or try again." })}\n\n`);
          res.end();
          return;
        }

        // Stream complete — parse and validate JSON
        if (event.type === "message_stop") {
          const clean = fullText
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

          let parsed;
          try {
            parsed = JSON.parse(clean);
          } catch (e) {
            res.write(`data: ${JSON.stringify({ type: "error", error: "Invalid JSON from Claude: " + e.message, preview: clean.slice(0, 200) })}\n\n`);
            res.end();
            return;
          }

          if (!parsed.sections || !Array.isArray(parsed.sections)) {
            res.write(`data: ${JSON.stringify({ type: "error", error: "Invalid response structure" })}\n\n`);
            res.end();
            return;
          }

          // Send final parsed result
          res.write(`data: ${JSON.stringify({ type: "done", data: parsed })}\n\n`);
          res.end();
          return;
        }
      }
    }

    res.end();
  } catch (e) {
    // If headers not sent yet, send JSON error; otherwise send SSE error
    if (!res.headersSent) {
      return res.status(500).json({ error: e.message });
    }
    res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
    res.end();
  }
}
