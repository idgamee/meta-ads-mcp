import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MetaClient } from "./meta.js";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_API_KEY;

function client() {
  const token = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("META_ACCESS_TOKEN and META_AD_ACCOUNT_ID must be set");
  return new MetaClient({ accessToken: token, adAccountId: accountId });
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

const datePreset = () =>
  z.enum(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month"])
    .default("last_7d")
    .describe("Date range preset");

const CTA_TYPES = [
  "SHOP_NOW", "LEARN_MORE", "SIGN_UP", "BOOK_TRAVEL",
  "CONTACT_US", "GET_QUOTE", "APPLY_NOW", "DOWNLOAD",
  "SEND_MESSAGE", "SUBSCRIBE", "WATCH_MORE", "NO_BUTTON",
];

function insightOpts({ date_preset, time_range_since, time_range_until }) {
  return time_range_since
    ? { time_range: { since: time_range_since, until: time_range_until } }
    : { date_preset };
}

function createMcpServer() {
  const server = new McpServer({ name: "meta-ads", version: "2.0.0" });

  // ── CAMPAIGNS ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_campaigns",
    "List all campaigns in the ad account with status, objective and budget",
    {},
    async () => ok(await client().listCampaigns())
  );

  server.tool(
    "create_campaign",
    "Create a new campaign. Budget in cents (5000 = R$50,00). Use daily_budget OR lifetime_budget, not both.",
    {
      name: z.string().describe("Campaign name"),
      objective: z.enum([
        "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_TRAFFIC",
        "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES",
      ]).describe("Campaign objective"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      daily_budget: z.number().int().positive().optional().describe("Daily budget in cents"),
      lifetime_budget: z.number().int().positive().optional().describe("Lifetime budget in cents (requires stop_time)"),
      start_time: z.string().optional().describe("ISO 8601 datetime e.g. 2025-06-01T08:00:00-0300"),
      stop_time: z.string().optional().describe("ISO 8601 datetime (required with lifetime_budget)"),
      special_ad_categories: z.array(z.string()).default([]).describe("[] for most campaigns. Use ['CREDIT','EMPLOYMENT','HOUSING'] when applicable"),
    },
    async (args) => ok(await client().createCampaign(args))
  );

  server.tool(
    "pause_campaign",
    "Pause a campaign",
    { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().pauseCampaign(campaign_id))
  );

  server.tool(
    "activate_campaign",
    "Activate (un-pause) a campaign",
    { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().activateCampaign(campaign_id))
  );

  server.tool(
    "delete_campaign",
    "Soft-delete a campaign",
    { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().deleteCampaign(campaign_id))
  );

  server.tool(
    "duplicate_campaign",
    "Duplicate a campaign. deep_copy=true also duplicates all ad sets and ads inside.",
    {
      campaign_id: z.string(),
      deep_copy: z.boolean().default(false).describe("Also copy ad sets and ads inside"),
    },
    async ({ campaign_id, deep_copy }) => ok(await client().duplicateCampaign(campaign_id, deep_copy))
  );

  server.tool(
    "set_campaign_budget",
    "Change campaign daily or lifetime budget. Amount in cents.",
    {
      campaign_id: z.string(),
      budget_type: z.enum(["daily_budget", "lifetime_budget"]),
      amount_cents: z.number().int().positive().describe("Amount in cents (5000 = R$50,00)"),
    },
    async ({ campaign_id, budget_type, amount_cents }) =>
      ok(await client().setCampaignBudget(campaign_id, budget_type, amount_cents))
  );

  // ── AD SETS ──────────────────────────────────────────────────────────────────

  server.tool(
    "list_adsets",
    "List ad sets, optionally filtered by campaign",
    { campaign_id: z.string().optional().describe("Filter by campaign ID (omit for all)") },
    async ({ campaign_id }) => ok(await client().listAdsets(campaign_id))
  );

  server.tool(
    "create_adset",
    "Create a new ad set with targeting, budget and delivery settings. Budget in cents.",
    {
      name: z.string(),
      campaign_id: z.string(),
      optimization_goal: z.enum([
        "LINK_CLICKS", "REACH", "IMPRESSIONS", "VIDEO_VIEWS",
        "LEAD_GENERATION", "OFFSITE_CONVERSIONS", "VALUE",
      ]).describe("What Meta optimizes for"),
      billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS"]).default("IMPRESSIONS"),
      targeting: z.string().describe(
        'Targeting spec as JSON string. Example: {"geo_locations":{"countries":["BR"]},"age_min":18,"age_max":65,"genders":[1,2]}'
      ),
      daily_budget: z.number().int().positive().optional().describe("Daily budget in cents"),
      lifetime_budget: z.number().int().positive().optional().describe("Lifetime budget in cents"),
      bid_amount: z.number().int().positive().optional().describe("Manual bid in cents (omit for auto-bid)"),
      start_time: z.string().optional().describe("ISO 8601 datetime"),
      end_time: z.string().optional().describe("ISO 8601 datetime"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async (args) => ok(await client().createAdset(args))
  );

  server.tool(
    "pause_adset",
    "Pause an ad set",
    { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().pauseAdset(adset_id))
  );

  server.tool(
    "activate_adset",
    "Activate an ad set",
    { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().activateAdset(adset_id))
  );

  server.tool(
    "delete_adset",
    "Soft-delete an ad set",
    { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().deleteAdset(adset_id))
  );

  server.tool(
    "duplicate_adset",
    "Duplicate an ad set",
    { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().duplicateAdset(adset_id))
  );

  server.tool(
    "set_adset_budget",
    "Change ad set budget. Amount in cents.",
    {
      adset_id: z.string(),
      budget_type: z.enum(["daily_budget", "lifetime_budget"]),
      amount_cents: z.number().int().positive(),
    },
    async ({ adset_id, budget_type, amount_cents }) =>
      ok(await client().setAdsetBudget(adset_id, budget_type, amount_cents))
  );

  server.tool(
    "set_adset_schedule",
    "Set start and/or end time for an ad set",
    {
      adset_id: z.string(),
      start_time: z.string().optional().describe("ISO 8601 datetime"),
      end_time: z.string().optional().describe("ISO 8601 datetime"),
    },
    async ({ adset_id, start_time, end_time }) =>
      ok(await client().setAdsetSchedule(adset_id, { start_time, end_time }))
  );

  // ── ADS ──────────────────────────────────────────────────────────────────────

  server.tool(
    "list_ads",
    "List ads, optionally filtered by ad set",
    { adset_id: z.string().optional().describe("Filter by ad set ID (omit for all)") },
    async ({ adset_id }) => ok(await client().listAds(adset_id))
  );

  server.tool(
    "create_ad",
    "Create an ad using an existing creative ID",
    {
      name: z.string(),
      adset_id: z.string(),
      creative_id: z.string().describe("Creative ID from get_ad_creatives or create_ad_creative"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async (args) => ok(await client().createAd(args))
  );

  server.tool(
    "pause_ad",
    "Pause an ad",
    { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().pauseAd(ad_id))
  );

  server.tool(
    "activate_ad",
    "Activate an ad",
    { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().activateAd(ad_id))
  );

  server.tool(
    "delete_ad",
    "Soft-delete an ad",
    { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().deleteAd(ad_id))
  );

  server.tool(
    "duplicate_ad",
    "Duplicate an ad",
    { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().duplicateAd(ad_id))
  );

  // ── CREATIVES ─────────────────────────────────────────────────────────────────

  server.tool(
    "get_ad_creatives",
    "List all ad creatives in the account",
    {},
    async () => ok(await client().getAdCreatives())
  );

  server.tool(
    "upload_image_asset",
    "Upload an image from a public URL to Meta's ad library. Returns the image_hash required to create creatives.",
    {
      image_url: z.string().url().describe("Public URL of the image (JPG, PNG). Min 600x600px recommended for feed ads."),
    },
    async ({ image_url }) => ok(await client().uploadImageFromUrl(image_url))
  );

  server.tool(
    "create_ad_creative",
    "Create an ad creative (link ad format) with copy, headline, image and CTA button",
    {
      name: z.string().describe("Internal creative name"),
      page_id: z.string().describe("Facebook Page ID that publishes the ad"),
      image_hash: z.string().describe("Image hash returned by upload_image_asset"),
      message: z.string().describe("Main ad copy (body text shown above the image)"),
      headline: z.string().describe("Link headline (bold title below the image)"),
      link_url: z.string().url().describe("Destination URL when user clicks the ad"),
      description: z.string().optional().describe("Small description text below the headline"),
      call_to_action_type: z.enum(CTA_TYPES).optional().describe("CTA button label"),
    },
    async (args) => ok(await client().createAdCreative(args))
  );

  server.tool(
    "create_ad_with_creative",
    "Full pipeline in one call: uploads image → creates creative → creates ad. Returns image_hash, creative_id and ad_id.",
    {
      ad_name: z.string().describe("Name for the ad (and creative if creative_name is omitted)"),
      adset_id: z.string(),
      page_id: z.string().describe("Facebook Page ID"),
      image_url: z.string().url().describe("Public URL of the image to upload"),
      message: z.string().describe("Main ad copy (body text)"),
      headline: z.string().describe("Link headline"),
      link_url: z.string().url().describe("Destination URL"),
      description: z.string().optional(),
      call_to_action_type: z.enum(CTA_TYPES).optional(),
      creative_name: z.string().optional().describe("Internal creative name (defaults to ad_name)"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ ad_name, adset_id, page_id, image_url, message, headline, link_url, description, call_to_action_type, creative_name, status }) => {
      const c = client();

      const imgResult = await c.uploadImageFromUrl(image_url);
      const firstImage = Object.values(imgResult.images ?? {})[0];
      if (!firstImage?.hash) throw new Error("Image upload failed: no hash returned");

      const creative = await c.createAdCreative({
        name: creative_name ?? ad_name,
        page_id,
        image_hash: firstImage.hash,
        message,
        headline,
        link_url,
        description,
        call_to_action_type,
      });

      const ad = await c.createAd({ name: ad_name, adset_id, creative_id: creative.id, status });

      return ok({ image_hash: firstImage.hash, creative_id: creative.id, ad_id: ad.id });
    }
  );

  // ── INSIGHTS ─────────────────────────────────────────────────────────────────

  server.tool(
    "get_insights",
    "Get account-level performance metrics (spend, impressions, clicks, reach, CPC, CPM, CTR, conversions)",
    {
      date_preset: datePreset(),
      time_range_since: z.string().optional().describe("Custom range start YYYY-MM-DD (overrides date_preset)"),
      time_range_until: z.string().optional().describe("Custom range end YYYY-MM-DD"),
    },
    async (args) => ok(await client().getInsights(insightOpts(args)))
  );

  server.tool(
    "get_insights_by_campaign",
    "Get performance metrics for a specific campaign",
    {
      campaign_id: z.string(),
      date_preset: datePreset(),
      time_range_since: z.string().optional(),
      time_range_until: z.string().optional(),
    },
    async ({ campaign_id, ...rest }) =>
      ok(await client().getInsightsByCampaign(campaign_id, insightOpts(rest)))
  );

  server.tool(
    "get_insights_by_adset",
    "Get performance metrics for a specific ad set",
    {
      adset_id: z.string(),
      date_preset: datePreset(),
      time_range_since: z.string().optional(),
      time_range_until: z.string().optional(),
    },
    async ({ adset_id, ...rest }) =>
      ok(await client().getInsightsByAdset(adset_id, insightOpts(rest)))
  );

  server.tool(
    "get_insights_by_ad",
    "Get performance metrics for a specific ad",
    {
      ad_id: z.string(),
      date_preset: datePreset(),
      time_range_since: z.string().optional(),
      time_range_until: z.string().optional(),
    },
    async ({ ad_id, ...rest }) =>
      ok(await client().getInsightsByAd(ad_id, insightOpts(rest)))
  );

  server.tool(
    "get_insights_by_day",
    "Get daily performance breakdown for a campaign, ad set or ad",
    {
      entity_id: z.string().describe("Campaign ID, Ad Set ID, or Ad ID"),
      date_preset: datePreset(),
      time_range_since: z.string().optional(),
      time_range_until: z.string().optional(),
    },
    async ({ entity_id, ...rest }) =>
      ok(await client().getInsightsByDay(entity_id, insightOpts(rest)))
  );

  server.tool(
    "get_insights_by_age_gender",
    "Get performance breakdown by age group and gender",
    {
      entity_id: z.string().describe("Campaign ID, Ad Set ID, or Ad ID"),
      date_preset: datePreset(),
    },
    async ({ entity_id, date_preset }) =>
      ok(await client().getInsightsByAgeGender(entity_id, { date_preset }))
  );

  server.tool(
    "get_insights_by_placement",
    "Get performance breakdown by placement (Feed, Stories, Reels, Audience Network, etc.)",
    {
      entity_id: z.string().describe("Campaign ID, Ad Set ID, or Ad ID"),
      date_preset: datePreset(),
    },
    async ({ entity_id, date_preset }) =>
      ok(await client().getInsightsByPlacement(entity_id, { date_preset }))
  );

  server.tool(
    "compare_periods",
    "Compare performance metrics between two date ranges side by side",
    {
      entity_id: z.string().optional().describe("Campaign/AdSet/Ad ID. Omit for account level."),
      period1_since: z.string().describe("Period 1 start YYYY-MM-DD"),
      period1_until: z.string().describe("Period 1 end YYYY-MM-DD"),
      period2_since: z.string().describe("Period 2 start YYYY-MM-DD"),
      period2_until: z.string().describe("Period 2 end YYYY-MM-DD"),
    },
    async ({ entity_id, period1_since, period1_until, period2_since, period2_until }) => {
      const c = client();
      const id = entity_id ?? c.act;
      return ok(await c.comparePeriods(id,
        { since: period1_since, until: period1_until },
        { since: period2_since, until: period2_until }
      ));
    }
  );

  server.tool(
    "get_account_spend",
    "Quick summary of account total spend and key metrics",
    { date_preset: datePreset() },
    async ({ date_preset }) => ok(await client().getAccountSpend({ date_preset }))
  );

  server.tool(
    "get_billing_info",
    "Get ad account info: balance, total spend, currency, timezone and funding source",
    {},
    async () => ok(await client().getBillingInfo())
  );

  // ── AUDIENCES ─────────────────────────────────────────────────────────────────

  server.tool(
    "get_audience_size",
    "Estimate potential reach for a targeting spec before creating an ad set",
    {
      targeting: z.string().describe(
        'Targeting spec as JSON string. Example: {"geo_locations":{"countries":["BR"]},"age_min":25,"age_max":54}'
      ),
    },
    async ({ targeting }) => ok(await client().getAudienceSize(targeting))
  );

  server.tool(
    "list_custom_audiences",
    "List all custom audiences in the account",
    {},
    async () => ok(await client().listCustomAudiences())
  );

  server.tool(
    "create_custom_audience",
    "Create a custom audience. WEBSITE type requires pixel_id + retention_days. ENGAGEMENT requires a rule JSON.",
    {
      name: z.string(),
      description: z.string().optional(),
      subtype: z.enum(["WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT"]).describe(
        "WEBSITE = pixel visitors | ENGAGEMENT = page/Instagram interactions"
      ),
      pixel_id: z.string().optional().describe("Meta Pixel ID (required for WEBSITE subtype)"),
      retention_days: z.number().int().min(1).max(180).optional().describe(
        "Days to keep users in the audience (1-180). Required for WEBSITE."
      ),
      rule: z.string().optional().describe("JSON rule string for advanced audience definition"),
      customer_file_source: z.string().optional().describe(
        "USER_PROVIDED_ONLY | PARTNER_PROVIDED_ONLY | BOTH_USER_AND_PARTNER_PROVIDED"
      ),
    },
    async (args) => ok(await client().createCustomAudience(args))
  );

  server.tool(
    "create_lookalike_audience",
    "Create a Lookalike Audience based on an existing custom audience",
    {
      name: z.string(),
      origin_audience_id: z.string().describe("ID of the source custom audience to base the lookalike on"),
      country: z.string().length(2).describe("2-letter country code (e.g. BR, US, PT)"),
      ratio: z.number().min(0.01).max(0.2).default(0.01).describe(
        "Size ratio: 0.01 = top 1% most similar (most targeted), 0.1 = top 10% (broader reach)"
      ),
    },
    async (args) => ok(await client().createLookalikeAudience(args))
  );

  return server;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkApiKey(req, res) {
  if (!MCP_API_KEY) return true;
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"];
  if (key !== MCP_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── MCP Endpoint ─────────────────────────────────────────────────────────────

async function handleMcp(req, res) {
  if (!checkApiKey(req, res)) return;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("finish", () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    configured: {
      accessToken: !!process.env.META_ACCESS_TOKEN,
      adAccountId: !!process.env.META_AD_ACCOUNT_ID,
    },
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Meta Ads MCP Server v2.0 running on port ${PORT}`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
