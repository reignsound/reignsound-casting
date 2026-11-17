// Vercel serverless endpoint: combined public livestream status for IIIAMDESS.
// Required Vercel environment variables:
// KICK_CLIENT_ID, KICK_CLIENT_SECRET, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET

let kickTokenCache = null;
let twitchTokenCache = null;
let statusCache = null;

async function getToken(url, clientId, clientSecret, cache) {
  if (cache && cache.expiresAt > Date.now() + 60000) return cache.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error("Platform authentication failed");
  const data = await response.json();
  if (!data.access_token) throw new Error("Platform token missing");
  const next = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return next;
}

async function fetchKickLive() {
  const { KICK_CLIENT_ID: id, KICK_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error("Kick credentials not configured");
  if (!kickTokenCache || kickTokenCache.expiresAt <= Date.now() + 60000) {
    kickTokenCache = await getToken("https://id.kick.com/oauth/token", id, secret, kickTokenCache);
  }
  const headers = { Authorization: "Bearer " + kickTokenCache.token };
  const channelUrl = new URL("https://api.kick.com/public/v1/channels");
  channelUrl.searchParams.set("slug", "iiammdess");
  const channelResponse = await fetch(channelUrl, { headers });
  if (!channelResponse.ok) throw new Error("Kick channel lookup failed");
  const channelData = await channelResponse.json();
  const userId = channelData.data && channelData.data[0] && channelData.data[0].broadcaster_user_id;
  if (!userId) return false;
  const liveUrl = new URL("https://api.kick.com/public/v1/users/livestreams");
  liveUrl.searchParams.set("user_id", String(userId));
  const liveResponse = await fetch(liveUrl, { headers });
  if (!liveResponse.ok) throw new Error("Kick livestream lookup failed");
  const liveData = await liveResponse.json();
  return Array.isArray(liveData.data) && liveData.data.length > 0;
}

async function fetchTwitchLive() {
  const { TWITCH_CLIENT_ID: id, TWITCH_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error("Twitch credentials not configured");
  if (!twitchTokenCache || twitchTokenCache.expiresAt <= Date.now() + 60000) {
    twitchTokenCache = await getToken("https://id.twitch.tv/oauth2/token", id, secret, twitchTokenCache);
  }
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_login", "iiiiamdess");
  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + twitchTokenCache.token,
      "Client-Id": id
    }
  });
  if (!response.ok) throw new Error("Twitch livestream lookup failed");
  const data = await response.json();
  return Array.isArray(data.data) && data.data.some(stream => stream.type === "live");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (statusCache && statusCache.expiresAt > Date.now()) {
    return res.status(200).json(statusCache.value);
  }

  const [kick, twitch] = await Promise.allSettled([fetchKickLive(), fetchTwitchLive()]);
  const kickOk = kick.status === "fulfilled";
  const twitchOk = twitch.status === "fulfilled";
  const kickLive = kickOk && kick.value;
  const twitchLive = twitchOk && twitch.value;
  const kickConfigured = Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);
  const twitchConfigured = Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

  // The checker remains operational when at least one configured platform responds.
  // An unconfigured or failing platform does not invalidate a successful platform check.
  const available = kickOk || twitchOk;

  const value = {
    available,
    live: kickLive || twitchLive,
    kick: {
      configured: kickConfigured,
      available: kickOk,
      live: kickOk ? kickLive : null
    },
    twitch: {
      configured: twitchConfigured,
      available: twitchOk,
      live: twitchOk ? twitchLive : null
    },
    checkedAt: new Date().toISOString()
  };
  statusCache = { value, expiresAt: Date.now() + 30000 };
  return res.status(200).json(value);
};
