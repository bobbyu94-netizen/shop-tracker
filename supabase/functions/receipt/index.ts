// Receipt reader: takes a receipt photo (base64 data URL), returns extracted
// {vendor, date, total, category, note} via Claude vision.
// Deployed with verify_jwt=false so the browser CORS preflight passes;
// real auth is the getUser() check below — only signed-in users can spend AI credits.
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Mirrors EXPENSE_CATS in app.js.
const CATEGORIES = ["Materials", "Supplies", "Equipment", "Shop Improvements", "Software", "Startup Costs", "Other"];

const SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: "string", description: "Store or vendor name as printed on the receipt" },
    date: { type: "string", description: "Purchase date in YYYY-MM-DD format; empty string if unreadable" },
    total: { type: "number", description: "Final total paid, including tax" },
    category: { type: "string", enum: CATEGORIES },
    note: { type: "string", description: "Very short summary of what was bought, e.g. 'saw blades, sandpaper'" },
  },
  required: ["vendor", "date", "total", "category", "note"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "auth" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "no-key" });

  let image: string;
  try { ({ image } = await req.json()); } catch { return json({ error: "bad-request" }, 400); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image ?? "");
  if (!m) return json({ error: "bad-image" }, 400);

  const client = new Anthropic({ apiKey });
  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: m[1] as "image/jpeg", data: m[2] } },
          {
            type: "text",
            text: "Extract the purchase details from this receipt photo for a small cabinet shop's expense ledger. " +
              "vendor: the store name. date: purchase date as YYYY-MM-DD (empty string if you can't read it). " +
              "total: the final amount paid including tax. category: pick the best fit — lumber/sheet goods/paint for a " +
              "specific job is Materials; consumables like blades, screws, sandpaper are Supplies; tools and machines are " +
              "Equipment. note: a few words on what was bought.",
          },
        ],
      }],
    });
    const text = msg.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return json({ error: "ai-empty" });
    return json({ result: JSON.parse(text.text) });
  } catch (e) {
    return json({ error: "ai", message: String((e as Error)?.message ?? e) });
  }
});
