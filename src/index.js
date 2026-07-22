import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MetaClient } from "./meta.js";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_API_KEY;
const VERSION = "3.0.0";

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

const OBJECTIVES = [
  "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_TRAFFIC",
  "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES",
];

const BID_STRATEGIES = [
  "LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS",
];

const OPTIMIZATION_GOALS = [
  "LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS", "VIDEO_VIEWS", "THRUPLAY",
  "POST_ENGAGEMENT", "PAGE_LIKES", "LEAD_GENERATION", "QUALITY_LEAD", "CONVERSATIONS",
  "OFFSITE_CONVERSIONS", "VALUE",
];

const CTA_TYPES = [
  "SHOP_NOW", "LEARN_MORE", "SIGN_UP", "BOOK_TRAVEL", "BOOK_NOW", "ORDER_NOW",
  "CONTACT_US", "GET_QUOTE", "APPLY_NOW", "DOWNLOAD", "GET_DIRECTIONS", "CALL_NOW",
  "SEND_MESSAGE", "WHATSAPP_MESSAGE", "SUBSCRIBE", "WATCH_MORE", "NO_BUTTON",
];

const AD_FORMATS = [
  "DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD", "MOBILE_FEED_BASIC",
  "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "INSTAGRAM_REELS",
  "FACEBOOK_STORY_MOBILE", "FACEBOOK_REELS_MOBILE",
];

const ACTION_SOURCES = [
  "website", "app", "phone_call", "chat", "email",
  "physical_store", "system_generated", "business_messaging", "other",
];

const CONVERSION_EVENTS = [
  "PURCHASE", "LEAD", "COMPLETE_REGISTRATION", "ADD_TO_CART", "ADD_PAYMENT_INFO",
  "INITIATE_CHECKOUT", "ADD_TO_WISHLIST", "CONTENT_VIEW", "SEARCH", "SUBSCRIBE",
  "START_TRIAL", "SCHEDULE", "CONTACT", "OTHER",
];

function insightOpts({ date_preset, time_range_since, time_range_until }) {
  return time_range_since
    ? { time_range: { since: time_range_since, until: time_range_until } }
    : { date_preset };
}

function createMcpServer() {
  const server = new McpServer({ name: "meta-ads", version: VERSION });

  // ══ SETUP & DISCOVERY ═════════════════════════════════════════════════════

  server.tool(
    "check_setup",
    "Health check: validates the access token (type, scopes, expiry) and returns the active ad account info. Run this first if something is not working.",
    {},
    async () => {
      const c = client();
      const [token, account] = await Promise.all([c.debugToken(), c.getBillingInfo()]);
      return ok({ token: token.data, account });
    }
  );

  server.tool(
    "list_ad_accounts",
    "List every ad account the token can access (for multi-account Business Managers). Shows status, currency and spend.",
    {},
    async () => ok(await client().listAdAccounts())
  );

  server.tool(
    "list_pages",
    "List Facebook Pages and their linked Instagram business accounts. Use this to find the page_id needed to create creatives.",
    {},
    async () => ok(await client().listPages())
  );

  // ══ CAMPAIGNS ═════════════════════════════════════════════════════════════

  server.tool(
    "list_campaigns",
    "List all campaigns with status, effective_status (real delivery state), objective, bid strategy and budget",
    {},
    async () => ok(await client().listCampaigns())
  );

  server.tool(
    "create_campaign",
    "Create a new campaign. Budget in cents (5000 = R$50,00). Use daily_budget OR lifetime_budget at campaign level to enable Advantage+ CBO (budget shared across ad sets).",
    {
      name: z.string().describe("Campaign name"),
      objective: z.enum(OBJECTIVES).describe("Campaign objective"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      daily_budget: z.number().int().positive().optional().describe("Daily budget in cents (campaign-level = CBO)"),
      lifetime_budget: z.number().int().positive().optional().describe("Lifetime budget in cents (requires stop_time)"),
      bid_strategy: z.enum(BID_STRATEGIES).optional().describe("Bid strategy. COST_CAP / LOWEST_COST_WITH_MIN_ROAS need a bid/roas on the ad set"),
      start_time: z.string().optional().describe("ISO 8601 e.g. 2026-06-01T08:00:00-0300"),
      stop_time: z.string().optional().describe("ISO 8601 (required with lifetime_budget)"),
      special_ad_categories: z.array(z.string()).default([]).describe("[] for most. Use ['CREDIT','EMPLOYMENT','HOUSING','FINANCIAL_PRODUCTS_SERVICES'] when applicable"),
    },
    async (args) => ok(await client().createCampaign(args))
  );

  server.tool("pause_campaign", "Pause a campaign", { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().pauseCampaign(campaign_id)));
  server.tool("activate_campaign", "Activate (un-pause) a campaign", { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().activateCampaign(campaign_id)));
  server.tool("delete_campaign", "Soft-delete a campaign", { campaign_id: z.string() },
    async ({ campaign_id }) => ok(await client().deleteCampaign(campaign_id)));

  server.tool("duplicate_campaign", "Duplicate a campaign. deep_copy=true also duplicates all ad sets and ads inside.",
    { campaign_id: z.string(), deep_copy: z.boolean().default(false) },
    async ({ campaign_id, deep_copy }) => ok(await client().duplicateCampaign(campaign_id, deep_copy)));

  server.tool("set_campaign_budget", "Change campaign daily or lifetime budget. Amount in cents.",
    { campaign_id: z.string(), budget_type: z.enum(["daily_budget", "lifetime_budget"]), amount_cents: z.number().int().positive() },
    async ({ campaign_id, budget_type, amount_cents }) => ok(await client().setCampaignBudget(campaign_id, budget_type, amount_cents)));

  // ══ AD SETS ═══════════════════════════════════════════════════════════════

  server.tool(
    "list_adsets",
    "List ad sets (with effective_status and promoted_object), optionally filtered by campaign",
    { campaign_id: z.string().optional().describe("Filter by campaign ID (omit for all)") },
    async ({ campaign_id }) => ok(await client().listAdsets(campaign_id))
  );

  server.tool(
    "create_adset",
    "Create an ad set with targeting, budget and delivery. For conversion optimization (OFFSITE_CONVERSIONS) you MUST pass promoted_object with the pixel_id + custom_event_type.",
    {
      name: z.string(),
      campaign_id: z.string(),
      optimization_goal: z.enum(OPTIMIZATION_GOALS).describe("What Meta optimizes for"),
      billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]).default("IMPRESSIONS"),
      targeting: z.string().describe('Targeting spec JSON. Example: {"geo_locations":{"countries":["BR"]},"age_min":18,"age_max":65,"genders":[1,2],"flexible_spec":[{"interests":[{"id":"6003...","name":"Barba"}]}]}'),
      promoted_object: z.string().optional().describe('JSON for conversion goals. Example: {"pixel_id":"123","custom_event_type":"PURCHASE"} or {"pixel_id":"123","custom_conversion_id":"456"} or {"page_id":"789"}'),
      destination_type: z.string().optional().describe("e.g. WEBSITE, MESSENGER, WHATSAPP, ON_AD (for lead forms)"),
      daily_budget: z.number().int().positive().optional().describe("Daily budget in cents (omit if campaign uses CBO)"),
      lifetime_budget: z.number().int().positive().optional(),
      bid_strategy: z.enum(BID_STRATEGIES).optional(),
      bid_amount: z.number().int().positive().optional().describe("Bid/cost cap in cents (required for COST_CAP / BID_CAP)"),
      start_time: z.string().optional().describe("ISO 8601"),
      end_time: z.string().optional().describe("ISO 8601"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async (args) => ok(await client().createAdset(args))
  );

  server.tool("pause_adset", "Pause an ad set", { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().pauseAdset(adset_id)));
  server.tool("activate_adset", "Activate an ad set", { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().activateAdset(adset_id)));
  server.tool("delete_adset", "Soft-delete an ad set", { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().deleteAdset(adset_id)));
  server.tool("duplicate_adset", "Duplicate an ad set", { adset_id: z.string() },
    async ({ adset_id }) => ok(await client().duplicateAdset(adset_id)));

  server.tool("set_adset_budget", "Change ad set budget. Amount in cents.",
    { adset_id: z.string(), budget_type: z.enum(["daily_budget", "lifetime_budget"]), amount_cents: z.number().int().positive() },
    async ({ adset_id, budget_type, amount_cents }) => ok(await client().setAdsetBudget(adset_id, budget_type, amount_cents)));

  server.tool("set_adset_schedule", "Set start and/or end time for an ad set",
    { adset_id: z.string(), start_time: z.string().optional(), end_time: z.string().optional() },
    async ({ adset_id, start_time, end_time }) => ok(await client().setAdsetSchedule(adset_id, { start_time, end_time })));

  // ══ ADS ═══════════════════════════════════════════════════════════════════

  server.tool(
    "list_ads",
    "List ads with effective_status and issues_info (delivery problems), optionally filtered by ad set",
    { adset_id: z.string().optional().describe("Filter by ad set ID (omit for all)") },
    async ({ adset_id }) => ok(await client().listAds(adset_id))
  );

  server.tool("create_ad", "Create an ad using an existing creative ID",
    { name: z.string(), adset_id: z.string(), creative_id: z.string(), status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED") },
    async (args) => ok(await client().createAd(args)));

  server.tool("pause_ad", "Pause an ad", { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().pauseAd(ad_id)));
  server.tool("activate_ad", "Activate an ad", { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().activateAd(ad_id)));
  server.tool("delete_ad", "Soft-delete an ad", { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().deleteAd(ad_id)));
  server.tool("duplicate_ad", "Duplicate an ad", { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().duplicateAd(ad_id)));

  // ══ DELIVERY DIAGNOSTICS ══════════════════════════════════════════════════

  server.tool(
    "diagnose_ad",
    "Why is an ad not delivering? Returns effective_status, issues_info, ad_review_feedback (rejection reasons) and recommendations.",
    { ad_id: z.string() },
    async ({ ad_id }) => ok(await client().diagnoseAd(ad_id))
  );

  server.tool(
    "diagnose_account",
    "Scan the whole account and list every ad with a delivery problem (disapproved, pending review, with issues, paused parent, billing).",
    {},
    async () => ok(await client().diagnoseAccount())
  );

  server.tool(
    "get_recommendations",
    "Get Meta's optimization recommendations for a campaign, ad set or ad",
    { entity_id: z.string() },
    async ({ entity_id }) => ok(await client().getRecommendations(entity_id))
  );

  // ══ TARGETING SEARCH ══════════════════════════════════════════════════════

  server.tool(
    "search_interests",
    "Search detailed-targeting interests by name and get their IDs + audience size. Use the IDs inside targeting.flexible_spec.",
    { query: z.string().describe('e.g. "barba", "moda masculina", "barbearia"'), limit: z.number().int().min(1).max(100).default(25) },
    async ({ query, limit }) => ok(await client().searchInterests(query, limit))
  );

  server.tool(
    "search_geo_locations",
    "Search geo targeting keys (cities, regions, countries, zips) by name. Returns keys to use in targeting.geo_locations.",
    {
      query: z.string().describe('e.g. "Oswaldo Cruz", "Rio de Janeiro"'),
      location_types: z.array(z.string()).optional().describe('Filter: ["city"], ["region"], ["country"], ["zip"], ["neighborhood"]'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ query, location_types, limit }) => ok(await client().searchGeo(query, location_types, limit))
  );

  server.tool(
    "browse_targeting_categories",
    "Browse Meta's targeting taxonomy for behaviors, demographics or broad interests",
    { category: z.enum(["behaviors", "demographics", "interests", "life_events", "industries", "income", "family_statuses"]).describe("Category class to browse") },
    async ({ category }) => ok(await client().searchTargetingCategory(category))
  );

  server.tool(
    "get_interest_suggestions",
    "Given seed interest names, get related interest suggestions to expand targeting",
    { interests: z.array(z.string()).describe('Seed interests, e.g. ["Barbearia","Barba"]'), limit: z.number().int().min(1).max(100).default(25) },
    async ({ interests, limit }) => ok(await client().getInterestSuggestions(interests, limit))
  );

  server.tool(
    "get_delivery_estimate",
    "Estimate daily results (reach/conversions) for a targeting spec + optimization goal before launching",
    { targeting: z.string().describe("Targeting spec JSON"), optimization_goal: z.enum(OPTIMIZATION_GOALS).default("REACH") },
    async ({ targeting, optimization_goal }) => ok(await client().getDeliveryEstimate(targeting, optimization_goal))
  );

  // ══ CREATIVES ═════════════════════════════════════════════════════════════

  server.tool("get_ad_creatives", "List all ad creatives in the account", {},
    async () => ok(await client().getAdCreatives()));

  server.tool(
    "upload_image_asset",
    "Upload an image from a public URL. Returns the image_hash needed for creatives. Min 600x600px recommended.",
    { image_url: z.string().url() },
    async ({ image_url }) => ok(await client().uploadImageFromUrl(image_url))
  );

  server.tool(
    "upload_video_asset",
    "Upload a video from a public URL to the ad account. Returns a video_id. Videos need processing time; check with get_video_status before using.",
    { video_url: z.string().url(), name: z.string().optional() },
    async ({ video_url, name }) => ok(await client().uploadVideoFromUrl(video_url, name))
  );

  server.tool("get_video_status", "Check processing status of an uploaded video", { video_id: z.string() },
    async ({ video_id }) => ok(await client().getVideoStatus(video_id)));

  server.tool(
    "create_ad_creative",
    "Create a single-image link creative with copy, headline, image and CTA",
    {
      name: z.string(), page_id: z.string(), image_hash: z.string(),
      message: z.string().describe("Main ad copy (body text)"),
      headline: z.string().describe("Link headline (bold title)"),
      link_url: z.string().url(),
      description: z.string().optional(),
      call_to_action_type: z.enum(CTA_TYPES).optional(),
    },
    async (args) => ok(await client().createAdCreative(args))
  );

  server.tool(
    "create_video_creative",
    "Create a video creative (Reels/Feed). Needs a processed video_id and a thumbnail (image_url or image_hash).",
    {
      name: z.string(), page_id: z.string(), video_id: z.string(),
      message: z.string(), headline: z.string(), link_url: z.string().url(),
      image_url: z.string().url().optional().describe("Thumbnail URL"),
      image_hash: z.string().optional().describe("Thumbnail hash (alternative to image_url)"),
      description: z.string().optional(),
      call_to_action_type: z.enum(CTA_TYPES).optional(),
    },
    async (args) => ok(await client().createVideoCreative(args))
  );

  server.tool(
    "create_carousel_creative",
    "Create a multi-card carousel creative (2-10 cards). Each card: {image_hash, headline, description?, link?}.",
    {
      name: z.string(), page_id: z.string(), message: z.string(), link_url: z.string().url(),
      cards: z.string().describe('JSON array, e.g. [{"image_hash":"abc","headline":"Corte + Barba","link":"https://..."}]'),
      call_to_action_type: z.enum(CTA_TYPES).optional(),
    },
    async (args) => ok(await client().createCarouselCreative(args))
  );

  server.tool(
    "create_ad_from_post",
    "Boost an existing Facebook/Instagram post as an ad by referencing its object_story_id (format: PAGEID_POSTID).",
    {
      name: z.string(), object_story_id: z.string().describe("PAGEID_POSTID of the existing post"),
      call_to_action_type: z.enum(CTA_TYPES).optional(),
      link_url: z.string().url().optional(),
    },
    async (args) => ok(await client().createCreativeFromPost(args))
  );

  server.tool(
    "generate_ad_preview",
    "Get a rendered HTML preview (iframe) of a creative in a given placement, before publishing",
    { creative_id: z.string(), ad_format: z.enum(AD_FORMATS).default("MOBILE_FEED_STANDARD") },
    async ({ creative_id, ad_format }) => ok(await client().generatePreview(creative_id, ad_format))
  );

  server.tool(
    "create_ad_with_creative",
    "Full pipeline in one call: uploads image, creates a link creative, creates the ad. Returns image_hash, creative_id and ad_id.",
    {
      ad_name: z.string(), adset_id: z.string(), page_id: z.string(),
      image_url: z.string().url(), message: z.string(), headline: z.string(), link_url: z.string().url(),
      description: z.string().optional(), call_to_action_type: z.enum(CTA_TYPES).optional(),
      creative_name: z.string().optional(), status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ ad_name, adset_id, page_id, image_url, message, headline, link_url, description, call_to_action_type, creative_name, status }) => {
      const c = client();
      const imgResult = await c.uploadImageFromUrl(image_url);
      const firstImage = Object.values(imgResult.images ?? {})[0];
      if (!firstImage?.hash) throw new Error("Image upload failed: no hash returned");
      const creative = await c.createAdCreative({
        name: creative_name ?? ad_name, page_id, image_hash: firstImage.hash,
        message, headline, link_url, description, call_to_action_type,
      });
      const ad = await c.createAd({ name: ad_name, adset_id, creative_id: creative.id, status });
      return ok({ image_hash: firstImage.hash, creative_id: creative.id, ad_id: ad.id });
    }
  );

  // ══ INSIGHTS ══════════════════════════════════════════════════════════════

  const insightRange = {
    date_preset: datePreset(),
    time_range_since: z.string().optional().describe("Custom range start YYYY-MM-DD (overrides date_preset)"),
    time_range_until: z.string().optional().describe("Custom range end YYYY-MM-DD"),
  };

  server.tool("get_insights", "Account-level metrics (spend, impressions, clicks, reach, CPC, CPM, CTR, conversions)",
    { ...insightRange }, async (args) => ok(await client().getInsights(insightOpts(args))));

  server.tool("get_insights_by_campaign", "Metrics for a specific campaign",
    { campaign_id: z.string(), ...insightRange },
    async ({ campaign_id, ...rest }) => ok(await client().getInsightsByCampaign(campaign_id, insightOpts(rest))));

  server.tool("get_insights_by_adset", "Metrics for a specific ad set",
    { adset_id: z.string(), ...insightRange },
    async ({ adset_id, ...rest }) => ok(await client().getInsightsByAdset(adset_id, insightOpts(rest))));

  server.tool("get_insights_by_ad", "Metrics for a specific ad",
    { ad_id: z.string(), ...insightRange },
    async ({ ad_id, ...rest }) => ok(await client().getInsightsByAd(ad_id, insightOpts(rest))));

  server.tool("get_insights_by_day", "Daily breakdown for a campaign, ad set or ad",
    { entity_id: z.string(), ...insightRange },
    async ({ entity_id, ...rest }) => ok(await client().getInsightsByDay(entity_id, insightOpts(rest))));

  server.tool("get_insights_by_age_gender", "Breakdown by age group and gender",
    { entity_id: z.string(), date_preset: datePreset() },
    async ({ entity_id, date_preset }) => ok(await client().getInsightsByAgeGender(entity_id, { date_preset })));

  server.tool("get_insights_by_placement", "Breakdown by placement (Feed, Stories, Reels, Audience Network, etc.)",
    { entity_id: z.string(), date_preset: datePreset() },
    async ({ entity_id, date_preset }) => ok(await client().getInsightsByPlacement(entity_id, { date_preset })));

  server.tool(
    "get_roas_report",
    "Revenue-focused report: purchases, revenue, purchase_roas, cost per purchase, broken down by level. This is the money report.",
    {
      entity_id: z.string().optional().describe("Campaign/AdSet/Ad ID. Omit for account level."),
      level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
      ...insightRange,
    },
    async ({ entity_id, level, ...rest }) => ok(await client().getRoasReport(entity_id, { level, ...insightOpts(rest) }))
  );

  server.tool("compare_periods", "Compare metrics between two date ranges side by side",
    {
      entity_id: z.string().optional().describe("Campaign/AdSet/Ad ID. Omit for account level."),
      period1_since: z.string(), period1_until: z.string(), period2_since: z.string(), period2_until: z.string(),
    },
    async ({ entity_id, period1_since, period1_until, period2_since, period2_until }) => {
      const c = client();
      const id = entity_id ?? c.act;
      return ok(await c.comparePeriods(id, { since: period1_since, until: period1_until }, { since: period2_since, until: period2_until }));
    });

  server.tool("get_account_spend", "Quick summary of total spend and key metrics", { date_preset: datePreset() },
    async ({ date_preset }) => ok(await client().getAccountSpend({ date_preset })));

  server.tool("get_billing_info", "Ad account balance, spend, currency, timezone, spend cap and funding source", {},
    async () => ok(await client().getBillingInfo()));

  // ══ AUDIENCES ═════════════════════════════════════════════════════════════

  server.tool("get_audience_size", "Estimate potential reach for a targeting spec before creating an ad set",
    { targeting: z.string().describe("Targeting spec JSON") },
    async ({ targeting }) => ok(await client().getAudienceSize(targeting)));

  server.tool("list_custom_audiences", "List all custom audiences with size and status", {},
    async () => ok(await client().listCustomAudiences()));

  server.tool(
    "create_custom_audience",
    "Create a custom audience. WEBSITE needs pixel_id + retention_days. ENGAGEMENT needs a rule JSON.",
    {
      name: z.string(), description: z.string().optional(),
      subtype: z.enum(["WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT", "CUSTOM"]),
      pixel_id: z.string().optional(), retention_days: z.number().int().min(1).max(180).optional(),
      rule: z.string().optional(),
      customer_file_source: z.string().optional().describe("USER_PROVIDED_ONLY | PARTNER_PROVIDED_ONLY | BOTH_USER_AND_PARTNER_PROVIDED"),
    },
    async (args) => ok(await client().createCustomAudience(args))
  );

  server.tool(
    "create_crm_audience",
    "Create an empty CRM audience ready to receive your customer list via add_users_to_audience. Use this to sync clients from Asaas/AppBarber.",
    { name: z.string(), description: z.string().optional() },
    async (args) => ok(await client().createCrmAudience(args))
  );

  server.tool(
    "add_users_to_audience",
    "Add customers to a custom audience. PII (email/phone/name) is SHA-256 hashed locally before sending. Phone must include country code (e.g. 5521987654321).",
    {
      audience_id: z.string(),
      users: z.string().describe('JSON array of users, e.g. [{"email":"a@b.com","phone":"5521999998888","first_name":"Joao","external_id":"cliente_123"}]'),
    },
    async ({ audience_id, users }) => ok(await client().addUsersToAudience(audience_id, users))
  );

  server.tool(
    "remove_users_from_audience",
    "Remove customers from a custom audience (hashed locally). Same user format as add_users_to_audience.",
    { audience_id: z.string(), users: z.string().describe("JSON array of users") },
    async ({ audience_id, users }) => ok(await client().removeUsersFromAudience(audience_id, users))
  );

  server.tool(
    "create_lookalike_audience",
    "Create a Lookalike from an existing custom audience",
    {
      name: z.string(),
      origin_audience_id: z.string(),
      country: z.string().length(2).describe("2-letter country code (BR, US, PT)"),
      ratio: z.number().min(0.01).max(0.2).default(0.01).describe("0.01 = top 1% (most similar), 0.1 = top 10% (broader)"),
    },
    async (args) => ok(await client().createLookalikeAudience(args))
  );

  // ══ PIXELS & CONVERSIONS API ══════════════════════════════════════════════

  server.tool("list_pixels", "List Meta Pixels / datasets in the account (id, name, last fired time)", {},
    async () => ok(await client().listPixels()));

  server.tool("get_pixel_stats", "Get recent event stats for a pixel",
    { pixel_id: z.string(), aggregation: z.enum(["event", "device_type", "browser_type", "url"]).default("event") },
    async ({ pixel_id, aggregation }) => ok(await client().getPixelStats(pixel_id, aggregation)));

  server.tool("list_custom_conversions", "List custom conversions defined in the account", {},
    async () => ok(await client().listCustomConversions()));

  server.tool(
    "create_custom_conversion",
    "Create a custom conversion (e.g. 'Purchase over R$100') from a pixel + rule",
    {
      name: z.string(), pixel_id: z.string(),
      custom_event_type: z.enum(CONVERSION_EVENTS),
      rule: z.string().optional().describe('JSON rule, e.g. {"and":[{"event":{"eq":"Purchase"}},{"value":{"gte":100}}]}'),
      default_conversion_value: z.number().optional(),
    },
    async (args) => ok(await client().createCustomConversion(args))
  );

  server.tool(
    "send_conversion_event",
    "Send a server-side conversion event (Conversions API). action_source='physical_store' logs an IN-STORE/offline sale. PII is hashed locally. This is how you feed real barbershop sales (Asaas/AppBarber) back to Meta.",
    {
      dataset_id: z.string().describe("Pixel/dataset ID (from list_pixels)"),
      event_name: z.string().describe("e.g. Purchase, Lead, Schedule, CompleteRegistration"),
      action_source: z.enum(ACTION_SOURCES).default("website"),
      event_time: z.number().int().optional().describe("Unix seconds (defaults to now). Offline events can be backdated up to 7 days."),
      event_source_url: z.string().url().optional().describe("Required for website events"),
      email: z.string().optional(), phone: z.string().optional(),
      first_name: z.string().optional(), last_name: z.string().optional(),
      city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(), country: z.string().optional(),
      external_id: z.string().optional().describe("Your internal customer ID"),
      value: z.number().optional().describe("Purchase value (e.g. 80.00)"),
      currency: z.string().optional().describe("e.g. BRL"),
      order_id: z.string().optional(),
      client_ip_address: z.string().optional(), client_user_agent: z.string().optional(),
      fbc: z.string().optional(), fbp: z.string().optional(),
      test_event_code: z.string().optional().describe("Use while testing in Events Manager"),
    },
    async (args) => {
      const { dataset_id, ...event } = args;
      return ok(await client().sendConversionEvent(dataset_id, event));
    }
  );

  // ══ AUTOMATED RULES ═══════════════════════════════════════════════════════

  server.tool("list_rules", "List automated rules in the account", {},
    async () => ok(await client().listRules()));

  server.tool(
    "create_rule",
    "Create an automated rule (auto pause/scale). Provide evaluation_spec and execution_spec as JSON. Example evaluation: {\"evaluation_type\":\"SCHEDULE\",\"filters\":[{\"field\":\"cost_per_result\",\"value\":30,\"operator\":\"GREATER_THAN\"}]}. Example execution: {\"execution_type\":\"PAUSE\",\"execution_options\":[{\"field\":\"user_ids\",\"value\":[],\"operator\":\"EQUAL\"}]}.",
    {
      name: z.string(),
      evaluation_spec: z.string().describe("JSON evaluation spec (filters + evaluation_type)"),
      execution_spec: z.string().describe("JSON execution spec (PAUSE / UNPAUSE / CHANGE_BUDGET / NOTIFICATION ...)"),
      schedule_spec: z.string().optional().describe("JSON schedule spec (optional)"),
    },
    async (args) => ok(await client().createRule(args))
  );

  server.tool("enable_rule", "Enable an automated rule", { rule_id: z.string() },
    async ({ rule_id }) => ok(await client().enableRule(rule_id)));
  server.tool("disable_rule", "Disable an automated rule", { rule_id: z.string() },
    async ({ rule_id }) => ok(await client().disableRule(rule_id)));
  server.tool("delete_rule", "Delete an automated rule", { rule_id: z.string() },
    async ({ rule_id }) => ok(await client().deleteRule(rule_id)));
  server.tool("run_rule", "Run an automated rule immediately", { rule_id: z.string() },
    async ({ rule_id }) => ok(await client().runRule(rule_id)));

  return server;
}

// ══ Auth ══════════════════════════════════════════════════════════════════

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

// ══ MCP Endpoint ════════════════════════════════════════════════════════════

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

// ══ Health ══════════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    graph_api: process.env.GRAPH_API_VERSION || "v23.0",
    auth_enabled: !!MCP_API_KEY,
    configured: {
      accessToken: !!process.env.META_ACCESS_TOKEN,
      adAccountId: !!process.env.META_AD_ACCOUNT_ID,
    },
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Meta Ads MCP Server v${VERSION} running on port ${PORT}`);
  console.log(`Graph API: ${process.env.GRAPH_API_VERSION || "v23.0"} | Auth: ${MCP_API_KEY ? "ON" : "OFF (set MCP_API_KEY)"}`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
