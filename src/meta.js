import crypto from "node:crypto";

// ── Config (env-overridable) ────────────────────────────────────────────────
const API_VERSION = process.env.GRAPH_API_VERSION || "v23.0";
const META_BASE   = `https://graph.facebook.com/${API_VERSION}`;
const TIMEOUT_MS  = Number(process.env.META_TIMEOUT_MS  || 60000);
const MAX_RETRIES = Number(process.env.META_MAX_RETRIES || 3);
const MAX_PAGES   = Number(process.env.META_MAX_PAGES   || 25);
const PAGE_LIMIT  = Number(process.env.META_PAGE_LIMIT  || 100);

// Meta error codes that are transient (rate limits / temporary failures).
const RETRYABLE_CODES = new Set([
  1, 2, 4, 17, 32, 341, 613,
  80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400);

// ── PII hashing helpers (Meta requires SHA-256 of normalized values) ─────────
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const hashEmail = (v) => sha256(String(v).trim().toLowerCase());
const hashPhone = (v) => sha256(String(v).replace(/[^0-9]/g, ""));       // digits only, include country code
const hashText  = (v) => sha256(String(v).trim().toLowerCase().replace(/\s+/g, ""));

function metaError(e, status) {
  const head = [`Meta API: ${e.message}`];
  if (e.error_user_title) head.push(`| ${e.error_user_title}`);
  if (e.error_user_msg)   head.push(`: ${e.error_user_msg}`);
  const tail = [`code ${e.code}`];
  if (e.error_subcode) tail.push(`subcode ${e.error_subcode}`);
  if (e.fbtrace_id)    tail.push(`fbtrace ${e.fbtrace_id}`);
  const err = new Error(`${head.join(" ")} (${tail.join(", ")})`);
  err.meta = e;
  err.status = status;
  return err;
}

export class MetaClient {
  constructor({ accessToken, adAccountId }) {
    this.token = accessToken;
    this.act = `act_${adAccountId}`;
  }

  // ── Low-level request with retry + timeout ────────────────────────────────
  async _fetchWithRetry(url, opts) {
    let attempt = 0;
    let lastErr;
    while (attempt <= MAX_RETRIES) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(timer);
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }

        if (data.error) {
          const retryable = RETRYABLE_CODES.has(data.error.code) || res.status >= 500;
          if (retryable && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); attempt++; continue; }
          throw metaError(data.error, res.status);
        }
        if (!res.ok) {
          if (res.status >= 500 && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); attempt++; continue; }
          throw new Error(`Meta API HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return data;
      } catch (err) {
        clearTimeout(timer);
        const transient = err.name === "AbortError" || err.name === "FetchError" ||
                          ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(err.code);
        if (transient && attempt < MAX_RETRIES) { lastErr = err; await sleep(backoff(attempt)); attempt++; continue; }
        throw err;
      }
    }
    throw lastErr || new Error("Meta API: retries exhausted");
  }

  _headers(json = true) {
    const h = { Authorization: `Bearer ${this.token}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  request(path, method = "GET", body = null) {
    const url = `${META_BASE}${path}`;
    const opts = { method, headers: this._headers(!!body) };
    if (body) opts.body = JSON.stringify(body);
    return this._fetchWithRetry(url, opts);
  }

  // GET that auto-follows paging.next and aggregates .data across pages.
  async requestPaged(path) {
    const sep = path.includes("?") ? "&" : "?";
    let url = `${META_BASE}${path}${sep}limit=${PAGE_LIMIT}`;
    const all = [];
    let pages = 0;
    while (url && pages < MAX_PAGES) {
      const data = await this._fetchWithRetry(url, { method: "GET", headers: this._headers(false) });
      if (!Array.isArray(data.data)) return data;
      all.push(...data.data);
      url = data.paging?.next || null;
      pages++;
    }
    return { data: all, _count: all.length, _pages: pages, _truncated: !!url };
  }

  // ── Setup / discovery ─────────────────────────────────────────────────────
  debugToken() {
    return this.request(`/debug_token?input_token=${this.token}`);
  }

  listAdAccounts() {
    return this.requestPaged(
      `/me/adaccounts?fields=id,name,account_status,currency,timezone_name,amount_spent,balance,disable_reason`
    );
  }

  listPages() {
    return this.requestPaged(
      `/me/accounts?fields=id,name,category,tasks,instagram_business_account{id,username},link`
    );
  }

  getBillingInfo() {
    return this.request(
      `/${this.act}?fields=name,account_status,disable_reason,currency,timezone_name,amount_spent,balance,spend_cap,funding_source_details,business{id,name}`
    );
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  listCampaigns() {
    return this.requestPaged(
      `/${this.act}/campaigns?fields=id,name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget,start_time,stop_time,created_time`
    );
  }

  createCampaign({ name, objective, status, daily_budget, lifetime_budget, bid_strategy, start_time, stop_time, special_ad_categories }) {
    const body = { name, objective, status, special_ad_categories: special_ad_categories ?? [] };
    if (daily_budget != null)    body.daily_budget = String(daily_budget);
    if (lifetime_budget != null) body.lifetime_budget = String(lifetime_budget);
    if (bid_strategy)            body.bid_strategy = bid_strategy;
    if (start_time)              body.start_time = start_time;
    if (stop_time)               body.stop_time = stop_time;
    return this.request(`/${this.act}/campaigns`, "POST", body);
  }

  pauseCampaign(id)    { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateCampaign(id) { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteCampaign(id)   { return this.request(`/${id}`, "DELETE"); }
  duplicateCampaign(id, deepCopy = false) { return this.request(`/${id}/copies`, "POST", { deep_copy: deepCopy }); }
  setCampaignBudget(id, budgetType, amountCents) { return this.request(`/${id}`, "POST", { [budgetType]: String(amountCents) }); }

  // ── Ad Sets ───────────────────────────────────────────────────────────────
  listAdsets(campaignId = null) {
    const parent = campaignId ? `/${campaignId}` : `/${this.act}`;
    return this.requestPaged(
      `${parent}/adsets?fields=id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,bid_strategy,bid_amount,promoted_object,start_time,end_time`
    );
  }

  createAdset({ name, campaign_id, status, daily_budget, lifetime_budget, optimization_goal, billing_event, bid_strategy, bid_amount, targeting, promoted_object, destination_type, start_time, end_time }) {
    const body = { name, campaign_id, status, optimization_goal, billing_event };
    const t = typeof targeting === "string" ? JSON.parse(targeting) : targeting;
    if (t) body.targeting = t;
    if (promoted_object) body.promoted_object = typeof promoted_object === "string" ? JSON.parse(promoted_object) : promoted_object;
    if (destination_type) body.destination_type = destination_type;
    if (daily_budget != null)    body.daily_budget = String(daily_budget);
    if (lifetime_budget != null) body.lifetime_budget = String(lifetime_budget);
    if (bid_strategy)            body.bid_strategy = bid_strategy;
    if (bid_amount != null)      body.bid_amount = String(bid_amount);
    if (start_time)              body.start_time = start_time;
    if (end_time)                body.end_time = end_time;
    return this.request(`/${this.act}/adsets`, "POST", body);
  }

  pauseAdset(id)     { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateAdset(id)  { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteAdset(id)    { return this.request(`/${id}`, "DELETE"); }
  duplicateAdset(id) { return this.request(`/${id}/copies`, "POST", {}); }
  setAdsetBudget(id, budgetType, amountCents) { return this.request(`/${id}`, "POST", { [budgetType]: String(amountCents) }); }

  setAdsetSchedule(id, { start_time, end_time }) {
    const body = {};
    if (start_time) body.start_time = start_time;
    if (end_time)   body.end_time = end_time;
    return this.request(`/${id}`, "POST", body);
  }

  // ── Ads ───────────────────────────────────────────────────────────────────
  listAds(adsetId = null) {
    const parent = adsetId ? `/${adsetId}` : `/${this.act}`;
    return this.requestPaged(
      `${parent}/ads?fields=id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url},issues_info,created_time`
    );
  }

  createAd({ name, adset_id, creative_id, status }) {
    return this.request(`/${this.act}/ads`, "POST", { name, adset_id, creative: { creative_id }, status });
  }

  pauseAd(id)    { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateAd(id) { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteAd(id)   { return this.request(`/${id}`, "DELETE"); }
  duplicateAd(id) { return this.request(`/${id}/copies`, "POST", {}); }

  // ── Delivery diagnostics ──────────────────────────────────────────────────
  diagnoseAd(id) {
    return this.request(
      `/${id}?fields=id,name,status,effective_status,configured_status,issues_info,ad_review_feedback,recommendations`
    );
  }

  getRecommendations(id) {
    return this.request(`/${id}?fields=recommendations`);
  }

  async diagnoseAccount() {
    const res = await this.requestPaged(
      `/${this.act}/ads?fields=id,name,effective_status,issues_info,adset{id,name},campaign{id,name}`
    );
    const ads = res.data ?? [];
    const problems = ads.filter(
      (a) => (a.issues_info && a.issues_info.length) ||
             ["DISAPPROVED", "WITH_ISSUES", "PENDING_REVIEW", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "PENDING_BILLING_INFO"].includes(a.effective_status)
    );
    return { total_ads: ads.length, problems_found: problems.length, problems };
  }

  // ── Creatives ─────────────────────────────────────────────────────────────
  getAdCreatives() {
    return this.requestPaged(
      `/${this.act}/adcreatives?fields=id,name,object_story_spec,thumbnail_url,status,created_time`
    );
  }

  uploadImageFromUrl(imageUrl) {
    return this.request(`/${this.act}/adimages`, "POST", { url: imageUrl });
  }

  uploadVideoFromUrl(videoUrl, name) {
    const body = { file_url: videoUrl };
    if (name) body.name = name;
    return this.request(`/${this.act}/advideos`, "POST", body);
  }

  getVideoStatus(videoId) {
    return this.request(`/${videoId}?fields=id,status,title,length,created_time`);
  }

  createAdCreative({ name, page_id, image_hash, message, headline, description, link_url, call_to_action_type }) {
    const link_data = { image_hash, message, name: headline, link: link_url };
    if (description) link_data.description = description;
    if (call_to_action_type) link_data.call_to_action = { type: call_to_action_type };
    return this.request(`/${this.act}/adcreatives`, "POST", {
      name,
      object_story_spec: { page_id, link_data },
    });
  }

  createVideoCreative({ name, page_id, video_id, image_url, image_hash, message, headline, link_url, description, call_to_action_type }) {
    const video_data = { video_id, message, title: headline };
    if (image_url)  video_data.image_url = image_url;
    if (image_hash) video_data.image_hash = image_hash;
    if (description) video_data.link_description = description;
    if (call_to_action_type) {
      video_data.call_to_action = { type: call_to_action_type, value: link_url ? { link: link_url } : undefined };
    }
    return this.request(`/${this.act}/adcreatives`, "POST", {
      name,
      object_story_spec: { page_id, video_data },
    });
  }

  createCarouselCreative({ name, page_id, message, link_url, cards, call_to_action_type }) {
    const child_attachments = (typeof cards === "string" ? JSON.parse(cards) : cards).map((c) => {
      const att = { link: c.link || link_url, image_hash: c.image_hash, name: c.headline, description: c.description };
      if (call_to_action_type) att.call_to_action = { type: call_to_action_type };
      return att;
    });
    return this.request(`/${this.act}/adcreatives`, "POST", {
      name,
      object_story_spec: { page_id, link_data: { message, link: link_url, child_attachments, multi_share_optimized: true } },
    });
  }

  createCreativeFromPost({ name, object_story_id, call_to_action_type, link_url }) {
    const body = { name, object_story_id };
    if (call_to_action_type) {
      body.call_to_action = { type: call_to_action_type };
      if (link_url) body.call_to_action.value = { link: link_url };
    }
    return this.request(`/${this.act}/adcreatives`, "POST", body);
  }

  generatePreview(creativeId, adFormat) {
    return this.request(`/${creativeId}/previews?ad_format=${adFormat}`);
  }

  // ── Insights ──────────────────────────────────────────────────────────────
  _insightsPath(entity, opts = {}) {
    const {
      fields = "spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,actions,action_values,cost_per_action_type",
      date_preset,
      time_range,
      breakdowns,
      time_increment,
      level,
      action_attribution_windows,
      action_breakdowns,
    } = opts;

    let path = `/${entity}/insights?fields=${fields}`;
    if (date_preset)     path += `&date_preset=${date_preset}`;
    if (time_range)      path += `&time_range=${encodeURIComponent(JSON.stringify(time_range))}`;
    if (breakdowns)      path += `&breakdowns=${breakdowns}`;
    if (time_increment)  path += `&time_increment=${time_increment}`;
    if (level)           path += `&level=${level}`;
    if (action_attribution_windows) path += `&action_attribution_windows=${encodeURIComponent(JSON.stringify(action_attribution_windows))}`;
    if (action_breakdowns)          path += `&action_breakdowns=${action_breakdowns}`;
    return path;
  }

  getInsights(opts)               { return this.request(this._insightsPath(this.act, opts)); }
  getInsightsByCampaign(id, opts) { return this.request(this._insightsPath(id, opts)); }
  getInsightsByAdset(id, opts)    { return this.request(this._insightsPath(id, opts)); }
  getInsightsByAd(id, opts)       { return this.request(this._insightsPath(id, opts)); }
  getInsightsByDay(id, opts)      { return this.request(this._insightsPath(id, { ...opts, time_increment: 1 })); }

  getInsightsByAgeGender(id, opts) {
    return this.request(this._insightsPath(id, { fields: "spend,impressions,clicks,reach,cpc,cpm,ctr", breakdowns: "age,gender", ...opts }));
  }

  getInsightsByPlacement(id, opts) {
    return this.request(this._insightsPath(id, { fields: "spend,impressions,clicks,reach,cpc,cpm,ctr", breakdowns: "publisher_platform,platform_position", ...opts }));
  }

  // ROAS-focused report: purchases, revenue, ROAS, CPA, broken down by child level.
  getRoasReport(entity, opts = {}) {
    return this.request(this._insightsPath(entity ?? this.act, {
      fields: "spend,impressions,clicks,ctr,cpc,reach,actions,action_values,purchase_roas,website_purchase_roas,cost_per_action_type,cost_per_purchase",
      level: opts.level ?? "campaign",
      action_attribution_windows: opts.action_attribution_windows ?? ["7d_click", "1d_view"],
      ...opts,
    }));
  }

  async comparePeriods(id, period1, period2) {
    const fields = "spend,impressions,clicks,reach,cpc,cpm,ctr,actions,action_values,purchase_roas";
    const [r1, r2] = await Promise.all([
      this.request(this._insightsPath(id, { fields, time_range: period1 })),
      this.request(this._insightsPath(id, { fields, time_range: period2 })),
    ]);
    return {
      period1: { ...period1, metrics: r1.data?.[0] ?? {} },
      period2: { ...period2, metrics: r2.data?.[0] ?? {} },
    };
  }

  getAccountSpend(opts) {
    return this.request(this._insightsPath(this.act, { fields: "spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,purchase_roas", ...opts }));
  }

  // ── Targeting search ──────────────────────────────────────────────────────
  searchInterests(q, limit = 25) {
    return this.request(`/search?type=adinterest&q=${encodeURIComponent(q)}&limit=${limit}`);
  }

  searchGeo(q, locationTypes, limit = 25) {
    let path = `/search?type=adgeolocation&q=${encodeURIComponent(q)}&limit=${limit}`;
    if (locationTypes) path += `&location_types=${encodeURIComponent(JSON.stringify(locationTypes))}`;
    return this.request(path);
  }

  searchTargetingCategory(cls, limit = 100) {
    return this.request(`/search?type=adTargetingCategory&class=${encodeURIComponent(cls)}&limit=${limit}`);
  }

  getInterestSuggestions(interestList, limit = 25) {
    const list = Array.isArray(interestList) ? interestList : [interestList];
    return this.request(`/search?type=adinterestsuggestion&interest_list=${encodeURIComponent(JSON.stringify(list))}&limit=${limit}`);
  }

  getDeliveryEstimate(targeting, optimizationGoal = "REACH") {
    const spec = typeof targeting === "string" ? targeting : JSON.stringify(targeting);
    return this.request(`/${this.act}/delivery_estimate?targeting_spec=${encodeURIComponent(spec)}&optimization_goal=${optimizationGoal}`);
  }

  // ── Audiences ─────────────────────────────────────────────────────────────
  getAudienceSize(targeting) {
    const spec = typeof targeting === "string" ? targeting : JSON.stringify(targeting);
    return this.request(`/${this.act}/reachestimate?targeting_spec=${encodeURIComponent(spec)}&optimization_goal=LINK_CLICKS`);
  }

  listCustomAudiences() {
    return this.requestPaged(
      `/${this.act}/customaudiences?fields=id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,data_source,created_time`
    );
  }

  createCustomAudience({ name, description, subtype, pixel_id, retention_days, rule, customer_file_source }) {
    const body = { name, subtype };
    if (description) body.description = description;
    if (pixel_id) body.pixel_id = pixel_id;
    if (retention_days) body.retention_days = retention_days;
    if (customer_file_source) body.customer_file_source = customer_file_source;
    if (rule) body.rule = typeof rule === "string" ? rule : JSON.stringify(rule);
    return this.request(`/${this.act}/customaudiences`, "POST", body);
  }

  // Empty CRM-list audience ready to receive hashed user uploads.
  createCrmAudience({ name, description }) {
    return this.request(`/${this.act}/customaudiences`, "POST", {
      name,
      description: description ?? "Base de clientes (CRM)",
      subtype: "CUSTOM",
      customer_file_source: "USER_PROVIDED_ONLY",
    });
  }

  createLookalikeAudience({ name, origin_audience_id, country, ratio }) {
    return this.request(`/${this.act}/customaudiences`, "POST", {
      name,
      subtype: "LOOKALIKE",
      origin_audience_id,
      lookalike_spec: { ratio, country },
    });
  }

  _buildUserPayload(users) {
    // users: array of { email, phone, first_name, last_name, city, state, zip, country, external_id }
    const schema = ["EMAIL", "PHONE", "FN", "LN", "CT", "ST", "ZIP", "COUNTRY", "EXTERN_ID"];
    const data = users.map((u) => [
      u.email      ? hashEmail(u.email) : "",
      u.phone      ? hashPhone(u.phone) : "",
      u.first_name ? hashText(u.first_name) : "",
      u.last_name  ? hashText(u.last_name) : "",
      u.city       ? hashText(u.city) : "",
      u.state      ? hashText(u.state) : "",
      u.zip        ? hashText(u.zip) : "",
      u.country    ? hashText(u.country) : "",
      u.external_id ? hashText(u.external_id) : "",
    ]);
    return { schema, data };
  }

  addUsersToAudience(audienceId, users) {
    const list = typeof users === "string" ? JSON.parse(users) : users;
    return this.request(`/${audienceId}/users`, "POST", { payload: this._buildUserPayload(list) });
  }

  removeUsersFromAudience(audienceId, users) {
    const list = typeof users === "string" ? JSON.parse(users) : users;
    return this.request(`/${audienceId}/users`, "DELETE", { payload: this._buildUserPayload(list) });
  }

  // ── Pixels & Conversions API ──────────────────────────────────────────────
  listPixels() {
    return this.requestPaged(`/${this.act}/adspixels?fields=id,name,code,last_fired_time,is_unavailable`);
  }

  getPixelStats(pixelId, aggregation = "event") {
    return this.request(`/${pixelId}/stats?aggregation=${aggregation}`);
  }

  listCustomConversions() {
    return this.requestPaged(
      `/${this.act}/customconversions?fields=id,name,custom_event_type,rule,default_conversion_value,pixel,is_archived,creation_time`
    );
  }

  createCustomConversion({ name, pixel_id, custom_event_type, rule, default_conversion_value }) {
    const body = { name, pixel_id, custom_event_type };
    if (rule) body.rule = typeof rule === "string" ? rule : JSON.stringify(rule);
    if (default_conversion_value != null) body.default_conversion_value = default_conversion_value;
    return this.request(`/${this.act}/customconversions`, "POST", body);
  }

  // Server-side event (CAPI). action_source "physical_store" = offline/in-store sale.
  sendConversionEvent(datasetId, event) {
    const e = typeof event === "string" ? JSON.parse(event) : event;
    const user_data = {};
    if (e.email)  user_data.em = [hashEmail(e.email)];
    if (e.phone)  user_data.ph = [hashPhone(e.phone)];
    if (e.first_name) user_data.fn = [hashText(e.first_name)];
    if (e.last_name)  user_data.ln = [hashText(e.last_name)];
    if (e.city)   user_data.ct = [hashText(e.city)];
    if (e.state)  user_data.st = [hashText(e.state)];
    if (e.zip)    user_data.zp = [hashText(e.zip)];
    if (e.country) user_data.country = [hashText(e.country)];
    if (e.external_id) user_data.external_id = [hashText(e.external_id)];
    // Non-hashed signals (improve match on web events).
    if (e.client_ip_address) user_data.client_ip_address = e.client_ip_address;
    if (e.client_user_agent) user_data.client_user_agent = e.client_user_agent;
    if (e.fbc) user_data.fbc = e.fbc;
    if (e.fbp) user_data.fbp = e.fbp;

    const custom_data = {};
    if (e.value != null) custom_data.value = e.value;
    if (e.currency)      custom_data.currency = e.currency;
    if (e.order_id)      custom_data.order_id = e.order_id;
    if (e.content_ids)   custom_data.content_ids = e.content_ids;
    if (e.content_type)  custom_data.content_type = e.content_type;
    if (e.content_name)  custom_data.content_name = e.content_name;
    if (e.num_items != null) custom_data.num_items = e.num_items;

    const eventData = {
      event_name: e.event_name,
      event_time: e.event_time ?? Math.floor(Date.now() / 1000),
      action_source: e.action_source ?? "website",
      user_data,
    };
    if (e.event_source_url) eventData.event_source_url = e.event_source_url;
    if (e.event_id)         eventData.event_id = e.event_id;
    if (Object.keys(custom_data).length) eventData.custom_data = custom_data;

    const body = { data: [eventData] };
    if (e.test_event_code) body.test_event_code = e.test_event_code;
    return this.request(`/${datasetId}/events`, "POST", body);
  }

  // ── Automated Rules ───────────────────────────────────────────────────────
  listRules() {
    return this.requestPaged(
      `/${this.act}/adrules_library?fields=id,name,status,evaluation_spec,execution_spec,schedule_spec,created_time`
    );
  }

  createRule({ name, evaluation_spec, execution_spec, schedule_spec }) {
    const body = {
      name,
      evaluation_spec: typeof evaluation_spec === "string" ? JSON.parse(evaluation_spec) : evaluation_spec,
      execution_spec:  typeof execution_spec  === "string" ? JSON.parse(execution_spec)  : execution_spec,
    };
    if (schedule_spec) body.schedule_spec = typeof schedule_spec === "string" ? JSON.parse(schedule_spec) : schedule_spec;
    return this.request(`/${this.act}/adrules_library`, "POST", body);
  }

  enableRule(id)  { return this.request(`/${id}`, "POST", { status: "ENABLED" }); }
  disableRule(id) { return this.request(`/${id}`, "POST", { status: "DISABLED" }); }
  deleteRule(id)  { return this.request(`/${id}`, "DELETE"); }
  runRule(id)     { return this.request(`/${id}/execute`, "POST", {}); }
}
