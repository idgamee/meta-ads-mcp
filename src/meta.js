const META_BASE = "https://graph.facebook.com/v21.0";

export class MetaClient {
  constructor({ accessToken, adAccountId }) {
    this.token = accessToken;
    this.act = `act_${adAccountId}`;
  }

  async request(path, method = "GET", body = null) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${META_BASE}${path}${sep}access_token=${this.token}`;
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const data = await res.json();

    if (data.error) throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
    return data;
  }

  // ── Campaigns ────────────────────────────────────────────────────────────────

  listCampaigns() {
    return this.request(
      `/${this.act}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time`
    );
  }

  createCampaign({ name, objective, status, daily_budget, lifetime_budget, start_time, stop_time, special_ad_categories }) {
    const body = { name, objective, status, special_ad_categories: special_ad_categories ?? [] };
    if (daily_budget != null) body.daily_budget = String(daily_budget);
    if (lifetime_budget != null) body.lifetime_budget = String(lifetime_budget);
    if (start_time) body.start_time = start_time;
    if (stop_time) body.stop_time = stop_time;
    return this.request(`/${this.act}/campaigns`, "POST", body);
  }

  pauseCampaign(id)    { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateCampaign(id) { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteCampaign(id)   { return this.request(`/${id}`, "DELETE"); }

  duplicateCampaign(id, deepCopy = false) {
    return this.request(`/${id}/copies`, "POST", { deep_copy: deepCopy });
  }

  setCampaignBudget(id, budgetType, amountCents) {
    return this.request(`/${id}`, "POST", { [budgetType]: String(amountCents) });
  }

  // ── Ad Sets ──────────────────────────────────────────────────────────────────

  listAdsets(campaignId = null) {
    const parent = campaignId ? `/${campaignId}` : `/${this.act}`;
    return this.request(
      `${parent}/adsets?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,bid_amount,start_time,end_time`
    );
  }

  createAdset({ name, campaign_id, status, daily_budget, lifetime_budget, optimization_goal, billing_event, bid_amount, targeting, start_time, end_time }) {
    const body = { name, campaign_id, status, optimization_goal, billing_event };
    const t = typeof targeting === "string" ? JSON.parse(targeting) : targeting;
    if (t) body.targeting = t;
    if (daily_budget != null) body.daily_budget = String(daily_budget);
    if (lifetime_budget != null) body.lifetime_budget = String(lifetime_budget);
    if (bid_amount != null) body.bid_amount = String(bid_amount);
    if (start_time) body.start_time = start_time;
    if (end_time) body.end_time = end_time;
    return this.request(`/${this.act}/adsets`, "POST", body);
  }

  pauseAdset(id)     { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateAdset(id)  { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteAdset(id)    { return this.request(`/${id}`, "DELETE"); }
  duplicateAdset(id) { return this.request(`/${id}/copies`, "POST", {}); }

  setAdsetBudget(id, budgetType, amountCents) {
    return this.request(`/${id}`, "POST", { [budgetType]: String(amountCents) });
  }

  setAdsetSchedule(id, { start_time, end_time }) {
    const body = {};
    if (start_time) body.start_time = start_time;
    if (end_time) body.end_time = end_time;
    return this.request(`/${id}`, "POST", body);
  }

  // ── Ads ──────────────────────────────────────────────────────────────────────

  listAds(adsetId = null) {
    const parent = adsetId ? `/${adsetId}` : `/${this.act}`;
    return this.request(
      `${parent}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,name,thumbnail_url},created_time`
    );
  }

  createAd({ name, adset_id, creative_id, status }) {
    return this.request(`/${this.act}/ads`, "POST", {
      name, adset_id, creative: { creative_id }, status,
    });
  }

  pauseAd(id)    { return this.request(`/${id}`, "POST", { status: "PAUSED" }); }
  activateAd(id) { return this.request(`/${id}`, "POST", { status: "ACTIVE" }); }
  deleteAd(id)   { return this.request(`/${id}`, "DELETE"); }
  duplicateAd(id) { return this.request(`/${id}/copies`, "POST", {}); }

  // ── Creatives ─────────────────────────────────────────────────────────────────

  getAdCreatives() {
    return this.request(
      `/${this.act}/adcreatives?fields=id,name,object_story_spec,thumbnail_url,status,created_time`
    );
  }

  uploadImageFromUrl(imageUrl) {
    return this.request(`/${this.act}/adimages`, "POST", { url: imageUrl });
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

  // ── Insights ──────────────────────────────────────────────────────────────────

  _insightsPath(entity, opts = {}) {
    const {
      fields = "spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,actions,action_values,cost_per_action_type",
      date_preset,
      time_range,
      breakdowns,
      time_increment,
    } = opts;

    let path = `/${entity}/insights?fields=${fields}`;
    if (date_preset) path += `&date_preset=${date_preset}`;
    if (time_range) path += `&time_range=${encodeURIComponent(JSON.stringify(time_range))}`;
    if (breakdowns) path += `&breakdowns=${breakdowns}`;
    if (time_increment) path += `&time_increment=${time_increment}`;
    return path;
  }

  getInsights(opts)               { return this.request(this._insightsPath(this.act, opts)); }
  getInsightsByCampaign(id, opts) { return this.request(this._insightsPath(id, opts)); }
  getInsightsByAdset(id, opts)    { return this.request(this._insightsPath(id, opts)); }
  getInsightsByAd(id, opts)       { return this.request(this._insightsPath(id, opts)); }

  getInsightsByDay(id, opts) {
    return this.request(this._insightsPath(id, { ...opts, time_increment: 1 }));
  }

  getInsightsByAgeGender(id, opts) {
    return this.request(this._insightsPath(id, {
      fields: "spend,impressions,clicks,reach,cpc,cpm,ctr",
      breakdowns: "age,gender",
      ...opts,
    }));
  }

  getInsightsByPlacement(id, opts) {
    return this.request(this._insightsPath(id, {
      fields: "spend,impressions,clicks,reach,cpc,cpm,ctr",
      breakdowns: "publisher_platform,platform_position",
      ...opts,
    }));
  }

  async comparePeriods(id, period1, period2) {
    const fields = "spend,impressions,clicks,reach,cpc,cpm,ctr";
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
    return this.request(this._insightsPath(this.act, {
      fields: "spend,impressions,clicks,reach,frequency,cpc,cpm,ctr",
      ...opts,
    }));
  }

  getBillingInfo() {
    return this.request(
      `/${this.act}?fields=name,account_status,currency,timezone_name,amount_spent,balance,funding_source_details`
    );
  }

  // ── Audiences ─────────────────────────────────────────────────────────────────

  getAudienceSize(targeting) {
    const spec = typeof targeting === "string" ? targeting : JSON.stringify(targeting);
    return this.request(
      `/${this.act}/reachestimate?targeting_spec=${encodeURIComponent(spec)}&optimization_goal=LINK_CLICKS`
    );
  }

  listCustomAudiences() {
    return this.request(
      `/${this.act}/customaudiences?fields=id,name,description,subtype,approximate_count,delivery_status,created_time`
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

  createLookalikeAudience({ name, origin_audience_id, country, ratio }) {
    return this.request(`/${this.act}/customaudiences`, "POST", {
      name,
      subtype: "LOOKALIKE",
      origin_audience_id,
      lookalike_spec: { ratio, country },
    });
  }
}
