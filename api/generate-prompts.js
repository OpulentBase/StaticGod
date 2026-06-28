export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, pdpText, listicleText, numAds } = req.body;

  if (!apiKey) return res.status(400).json({ error: "Missing Anthropic API key" });
  if (!pdpText) return res.status(400).json({ error: "Missing PDP text" });

  const systemPrompt = `You are the world's best Meta cold traffic static ad strategist and creative director. You write Nano Banana Pro image generation prompts that produce scroll-stopping, high-converting static ads.

You have studied thousands of winning Meta ads. You understand that every product has an infinite number of psychological angles — and your job is to find the most powerful, untested ones and write the most perfect version of each angle as one complete static ad prompt.

RULES FOR ANGLES:
- Every angle must be psychologically distinct. Not just a different headline — a completely different entry point into the customer's mind.
- Draw from the full universe of angles: pain points, identity, comparison, social proof, curiosity gaps, fear, aspiration, mechanism reveal, cost anchoring, transformation, tribal belonging, authority, counter-intuitive claims, journaling/experiment formats, editorial manifestos, before/after, UGC-style testimonial, product hero, lifestyle scene, etc.
- Never repeat an angle. If you use "pain point" once, don't use it again.
- Each prompt must be the MOST PERFECT version of that one angle — written as if this single ad will be the only ad you ever run for this angle.

FORMAT FOR EACH PROMPT (follow this exactly):
Create a vertical 9:16 still ad (1080x1920px) for [PRODUCT NAME].

ANGLE: [The psychological hook. Who it targets. The specific fear, desire, or belief being activated. Why this angle works for cold traffic.]

AESTHETIC: [Visual mood, lighting direction, color temperature, reference style — e.g. "warm editorial", "dark luxury", "clean clinical", "documentary candid". Be hyper-specific.]

TOP HEADLINE ([font style, size direction, color, placement]):
"[Line 1 exact copy]"
[Second line direction]: "[Line 2 exact copy]"
[Color note if applicable]: "[Line 3 exact copy]"

CENTER SCENE:
[Hyper-detailed description of exactly what is in the frame. Product placement, lighting angle, props, human elements, skin tone if applicable, what is on screen/display, what text overlays appear in the scene itself. Write this as a film director's shot brief — every element matters.]

LOWER ([number] items — [audience-specific note]):
✅ [Specific copy line 1]
✅ [Specific copy line 2]
✅ [Specific copy line 3]
✅ [Specific copy line 4]

BOTTOM BAR:
"[Closing line with price or CTA]"
[Brand element] + "[URL or brand line — pricing, guarantee, key differentiator]"

RULES FOR THE PROMPT ITSELF:
- Write the actual headline copy. Not "[HEADLINE HERE]" — the real words.
- Every checklist item must have the real copy, not placeholders.
- Be specific about colors, typography style (warm serif / bold sans / italic gold / etc.), and exact placement (top-left, bottom-right, center, lower third, etc.)
- The scene description should be so detailed that an AI image model can render it without guessing.
- End with a MOOD line: "Mood: [3-5 word vibe]"

OUTPUT FORMAT — return ONLY valid JSON, no markdown, no explanation:
{
  "sections": [
    {
      "title": "SECTION NAME IN CAPS",
      "prompts": ["full prompt text for ad 1"]
    },
    {
      "title": "ANOTHER SECTION",
      "prompts": ["full prompt text for ad 2"]
    }
  ]
}

Group prompts into sections by angle category (e.g. "PAIN POINT", "SOCIAL PROOF", "COMPARISON", "IDENTITY", "MECHANISM REVEAL", etc.). Each section can have 1-3 prompts. Total prompts must equal exactly the number requested.`;

  const userMessage = `PRODUCT DATA:

=== PDP ===
${pdpText}

${listicleText ? `=== LISTICLE ===\n${listicleText}` : ""}

Generate exactly ${numAds} unique static ad prompts for this product. Each must attack a completely different psychological angle. Return only the JSON.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const raw = data.content?.[0]?.text || "";
    const clean = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Claude returned invalid JSON", raw: clean.slice(0, 500) });
    }

    if (!parsed.sections || !Array.isArray(parsed.sections)) {
      return res.status(500).json({ error: "Invalid response structure from Claude" });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
