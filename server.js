import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOG_AUTH_URL =
  "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token";

const BOG_CREATE_ORDER_URL =
  "https://api.bog.ge/payments/v1/ecommerce/orders";

function requiredEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return process.env[name];
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeGeorgianPhone(phone = "") {
  const cleaned = String(phone).replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("995")) return `+${cleaned}`;
  if (cleaned.startsWith("5") && cleaned.length === 9) return `+995${cleaned}`;

  return cleaned;
}


function sha256(value = "") {
  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

function normalizeMetaEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function normalizeMetaPhone(phone = "") {
  return normalizeGeorgianPhone(phone).replace(/\D/g, "");
}

const MYPIANO_ALLOWED_ORIGINS = new Set([
  "https://mypiano.ge",
  "https://www.mypiano.ge",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && MYPIANO_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    if (origin && !MYPIANO_ALLOWED_ORIGINS.has(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  next();
});

function getRequestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
}

function isMyPianoRequest(req) {
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  if (MYPIANO_ALLOWED_ORIGINS.has(origin)) return true;
  return (
    referer === "https://mypiano.ge/" ||
    referer.startsWith("https://mypiano.ge/") ||
    referer === "https://www.mypiano.ge/" ||
    referer.startsWith("https://www.mypiano.ge/")
  );
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const metaPurchaseRate = new Map();
function allowMetaPurchaseRequest(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 20;
  const previous = metaPurchaseRate.get(ip) || [];
  const fresh = previous.filter((time) => now - time < windowMs);
  if (fresh.length >= maxRequests) {
    metaPurchaseRate.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  metaPurchaseRate.set(ip, fresh);
  return true;
}

async function sendMetaPurchase({
  shopifyOrderId = "",
  eventId = "",
  value,
  currency = "GEL",
  email = "",
  phone = "",
  paymentMethod = "",
  contentName = "",
  contentIds = [],
  contents = [],
  eventSourceUrl = "https://mypiano.ge",
  fbp = "",
  fbc = "",
  clientIpAddress = "",
  clientUserAgent = "",
}) {
  const pixelId = requiredEnv("META_PIXEL_ID");
  const accessToken = requiredEnv("META_ACCESS_TOKEN");
  const graphVersion = process.env.META_GRAPH_VERSION || "v26.0";

  const normalizedEmail = normalizeMetaEmail(email);
  const normalizedPhone = normalizeMetaPhone(phone);
  const userData = {};

  if (normalizedEmail) userData.em = [sha256(normalizedEmail)];
  if (normalizedPhone) userData.ph = [sha256(normalizedPhone)];
  if (fbp) userData.fbp = String(fbp).slice(0, 255);
  if (fbc) userData.fbc = String(fbc).slice(0, 255);
  if (clientIpAddress) userData.client_ip_address = String(clientIpAddress).slice(0, 100);
  if (clientUserAgent) userData.client_user_agent = String(clientUserAgent).slice(0, 1000);

  const cleanValue = Number(value);
  if (!Number.isFinite(cleanValue) || cleanValue <= 0) {
    throw new Error(`Invalid Meta Purchase value: ${value}`);
  }

  const finalEventId = eventId ||
    (shopifyOrderId ? `purchase_${shopifyOrderId}` : `mypiano_purchase_${crypto.randomUUID()}`);

  const customData = {
    currency,
    value: cleanValue,
    payment_method: paymentMethod,
  };
  if (shopifyOrderId) customData.order_id = String(shopifyOrderId);
  if (contentName) customData.content_name = String(contentName).slice(0, 500);
  if (Array.isArray(contentIds) && contentIds.length) {
    customData.content_ids = contentIds.slice(0, 20).map((id) => String(id).slice(0, 128));
    customData.content_type = "product";
  }
  if (Array.isArray(contents) && contents.length) {
    customData.contents = contents.slice(0, 20).map((item) => ({
      id: String(item?.id || "").slice(0, 128),
      quantity: Math.max(1, Number(item?.quantity || 1)),
      item_price: Math.max(0, Number(item?.item_price || 0)),
    }));
  }

  const payload = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      event_id: finalEventId,
      action_source: "website",
      event_source_url: eventSourceUrl,
      user_data: userData,
      custom_data: customData,
    }],
  };

  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const responseText = await response.text();
  if (!response.ok) throw new Error(`Meta CAPI failed: ${responseText}`);

  console.log(`META PURCHASE SENT | event_id=${finalEventId} | ${cleanValue} ${currency} | ${paymentMethod}`);
  console.log("META CAPI RESPONSE:", responseText);

  try { return JSON.parse(responseText); }
  catch { return { raw: responseText }; }
}

function formatGel(amount) {
  const n = Number(amount || 0);
  return `${n.toFixed(2).replace(".00", "")} ₾`;
}

async function getBogToken() {
  const clientId = requiredEnv("BOG_CLIENT_ID");
  const clientSecret = requiredEnv("BOG_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(BOG_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`BOG auth failed: ${text}`);

  return JSON.parse(text);
}

async function getShopifyToken() {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const clientId = requiredEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requiredEnv("SHOPIFY_CLIENT_SECRET");

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`Shopify token failed: ${text}`);

  return JSON.parse(text).access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const token = await getShopifyToken();

  const response = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok || json.errors) {
    throw new Error(`Shopify GraphQL failed: ${JSON.stringify(json)}`);
  }

  return json.data;
}

async function getShopifyOrder(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query GetOrder($id: ID!) {
      node(id: $id) {
        ... on Order {
          id
          name
          displayFinancialStatus
          email
          phone
          shippingAddress {
            phone
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: gid });

  if (!data.node) throw new Error("Shopify order not found");

  return data.node;
}

async function markShopifyOrderAsPaid(shopifyOrderGid) {
  const mutation = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        userErrors {
          field
          message
        }
        order {
          id
          name
          displayFinancialStatus
        }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, {
    input: { id: shopifyOrderGid },
  });

  const errors = data.orderMarkAsPaid?.userErrors || [];

  if (errors.length) {
    throw new Error(`Shopify mark paid failed: ${JSON.stringify(errors)}`);
  }

  return data.orderMarkAsPaid.order;
}

async function createPendingShopifyOrder({
  variantId,
  quantity,
  firstName,
  lastName,
  phone,
  email,
  city,
  address1,
}) {
  const shop = requiredEnv("SHOPIFY_SHOP");
  const token = await getShopifyToken();
  const cleanQuantity = Math.max(1, Number(quantity || 1));
  const normalizedPhone = normalizeGeorgianPhone(phone);

  const payload = {
    order: {
      line_items: [
        {
          variant_id: Number(variantId),
          quantity: cleanQuantity,
        },
      ],
      financial_status: "pending",
      email: email || undefined,
      phone: normalizedPhone || undefined,
      tags: "BOG Direct Checkout, MyPiano",
      note: "Created from MyPiano custom BOG direct checkout",
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        phone: normalizedPhone,
        address1,
        city,
        country: "Georgia",
        country_code: "GE",
      },
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        phone: normalizedPhone,
        address1,
        city,
        country: "Georgia",
        country_code: "GE",
      },
      shipping_lines: [
        {
          title: "Delivery",
          price: "0.00",
          code: "delivery",
        },
      ],
      send_receipt: false,
      send_fulfillment_receipt: false,
    },
  };

  const response = await fetch(`https://${shop}/admin/api/2026-04/orders.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`Shopify order create failed: ${text}`);

  return JSON.parse(text).order;
}

async function createBogOrderForShopifyOrder(orderId, order) {
  const tokenData = await getBogToken();
  const token = tokenData.access_token;
  const appUrl = requiredEnv("APP_URL");

  const outstanding = order.totalOutstandingSet?.shopMoney;
  const currentTotal = order.currentTotalPriceSet?.shopMoney;

  const amount =
    outstanding?.amount && Number(outstanding.amount) > 0
      ? outstanding.amount
      : currentTotal.amount;

  const currency = outstanding?.currencyCode || currentTotal.currencyCode || "GEL";

  if (currency !== "GEL") {
    throw new Error(`Unsupported currency: ${currency}. BOG needs GEL.`);
  }

  const payload = {
    callback_url: `${appUrl}/api/bog/callback`,
    external_order_id: `MP-${orderId}`.slice(0, 25),
    purchase_units: {
      currency: "GEL",
      total_amount: Number(amount),
      basket: [
        {
          product_id: `shopify-${orderId}`,
          description: `MyPiano order ${order.name}`,
          quantity: 1,
          unit_price: Number(amount),
        },
      ],
    },
    redirect_urls: {
      success: `${appUrl}/payment-success?order=${encodeURIComponent(order.name)}`,
      fail: `${appUrl}/payment-failed?order=${encodeURIComponent(order.name)}`,
    },
    ttl: 30,
  };

  const response = await fetch(BOG_CREATE_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "ka",
      Theme: "light",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`BOG create order failed: ${text}`);

  return JSON.parse(text);
}

async function createTestBogOrder({ amount }) {
  const tokenData = await getBogToken();
  const token = tokenData.access_token;
  const appUrl = requiredEnv("APP_URL");

  const payload = {
    callback_url: `${appUrl}/api/bog/callback`,
    external_order_id: `MP-test-${Date.now()}`.slice(0, 25),
    purchase_units: {
      currency: "GEL",
      total_amount: Number(amount),
      basket: [
        {
          product_id: "test-product",
          description: "MyPiano BOG test payment",
          quantity: 1,
          unit_price: Number(amount),
        },
      ],
    },
    redirect_urls: {
      success: `${appUrl}/payment-success`,
      fail: `${appUrl}/payment-failed`,
    },
    ttl: 30,
  };

  const response = await fetch(BOG_CREATE_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "ka",
      Theme: "light",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`BOG create order failed: ${text}`);

  return JSON.parse(text);
}

app.get("/", (req, res) => {
  res.send(`
    <h1>MyPiano BOG Payment Server</h1>
    <p>Server is running.</p>
    <p><a href="/test-bog-auth">Test BOG Auth</a></p>
    <p><a href="/test-shopify-auth">Test Shopify Auth</a></p>
    <p><a href="/test-payment">Create 1 GEL Test Payment</a></p>
    <p><a href="/test-meta-config">Test Meta Config</a></p>
    <p><a href="/test-meta-purchase">Send Meta Test Purchase</a></p>
    <p>Direct checkout endpoint: <code>/checkout?variant_id=SHOPIFY_VARIANT_ID&quantity=1</code></p>
  `);
});

app.get("/test-bog-auth", async (req, res) => {
  try {
    const tokenData = await getBogToken();

    res.json({
      ok: true,
      message: "BOG auth OK",
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
      access_token_preview: tokenData.access_token
        ? `${tokenData.access_token.slice(0, 15)}...`
        : null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/test-shopify-auth", async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
        }
      }
    `);

    res.json({
      ok: true,
      message: "Shopify auth OK",
      shop: data.shop,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/test-meta-config", (req, res) => {
  res.json({
    ok: true,
    pixel_id: process.env.META_PIXEL_ID || null,
    access_token_configured: Boolean(process.env.META_ACCESS_TOKEN),
    graph_version: process.env.META_GRAPH_VERSION || "v26.0",
    test_event_code_configured: Boolean(process.env.META_TEST_EVENT_CODE),
  });
});

app.get("/test-meta-purchase", async (req, res) => {
  try {
    const result = await sendMetaPurchase({
      eventId: `mypiano_test_${Date.now()}`,
      value: 1,
      currency: "GEL",
      paymentMethod: "test",
      contentName: "MyPiano Meta CAPI Test",
      contentIds: ["mypiano-test"],
      contents: [{ id: "mypiano-test", quantity: 1, item_price: 1 }],
      eventSourceUrl: "https://mypiano.ge",
      clientIpAddress: getRequestIp(req),
      clientUserAgent: req.headers["user-agent"] || "",
    });
    return res.json({ ok: true, meta: result });
  } catch (error) {
    console.error("Meta test purchase error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/meta/purchase", async (req, res) => {
  try {
    console.log("META PURCHASE REQUEST:", JSON.stringify({
      origin: req.headers.origin || "",
      referer: req.headers.referer || "",
      contentType: req.headers["content-type"] || "",
      body: req.body || {},
    }));

    if (!isMyPianoRequest(req)) {
      console.log("META PURCHASE REJECTED: source is not MyPiano");
      return res.status(403).json({ ok: false, error: "Source not allowed" });
    }

    const ip = getRequestIp(req);
    if (!allowMetaPurchaseRequest(ip || "unknown")) {
      return res.status(429).json({ ok: false, error: "Too many requests" });
    }

    const {
      event_id,
      value,
      currency = "GEL",
      phone = "",
      payment_method = "",
      content_name = "",
      content_ids = [],
      contents = [],
      event_source_url = "https://mypiano.ge",
      fbp = "",
      fbc = "",
    } = req.body || {};

    const cleanValue = Number(value);
    const parsedContentIds = parseJsonArray(content_ids);
    const parsedContents = parseJsonArray(contents);

    if (!event_id || !String(event_id).startsWith("mypiano_purchase_")) {
      return res.status(400).json({ ok: false, error: "Invalid event_id" });
    }
    if (!Number.isFinite(cleanValue) || cleanValue <= 0 || cleanValue > 1000000) {
      return res.status(400).json({ ok: false, error: "Invalid value" });
    }

    const allowedMethods = new Set(["ნაღდი ანგარიშსწორება", "cash"]);
    if (!allowedMethods.has(payment_method)) {
      return res.status(400).json({ ok: false, error: "Invalid payment method" });
    }

    let sourceUrl = String(event_source_url || "https://mypiano.ge");
    if (
      !sourceUrl.startsWith("https://mypiano.ge/") &&
      sourceUrl !== "https://mypiano.ge" &&
      !sourceUrl.startsWith("https://www.mypiano.ge/")
    ) {
      sourceUrl = "https://mypiano.ge";
    }

    const result = await sendMetaPurchase({
      eventId: String(event_id).slice(0, 200),
      value: cleanValue,
      currency: "GEL",
      phone,
      paymentMethod: payment_method,
      contentName: content_name,
      contentIds: parsedContentIds,
      contents: parsedContents,
      eventSourceUrl: sourceUrl,
      fbp,
      fbc,
      clientIpAddress: ip,
      clientUserAgent: req.headers["user-agent"] || "",
    });

    return res.json({ ok: true, meta: result });
  } catch (error) {
    console.error("Meta purchase endpoint error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/test-payment", async (req, res) => {
  try {
    const bogOrder = await createTestBogOrder({ amount: 1 });
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/checkout", async (req, res) => {
  try {
    const variantId = req.query.variant_id;
    const quantity = Math.max(1, Number(req.query.quantity || 1));

    if (!variantId) {
      return res.status(400).send("Missing variant_id");
    }

    const productInfo = {
      productTitle: req.query.product_title || "არჩეული პროდუქტი",
      variantTitle: req.query.variant_title || "",
      price: Number(req.query.price || 0),
      imageUrl: req.query.image_url || "",
    };

    const total = productInfo.price * quantity;

    res.send(`
      <!doctype html>
      <html lang="ka">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>შეკვეთის გაფორმება</title>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
              background: radial-gradient(circle at top left, rgba(34, 197, 94, .13), transparent 34%),
                          linear-gradient(135deg, #f7f7f7 0%, #ffffff 100%);
              color: #111;
              min-height: 100vh;
              padding: 32px 16px;
            }
            .page { max-width: 1120px; margin: 0 auto; }
            .topbar {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 16px;
              margin-bottom: 24px;
            }
            .brand {
              display: flex;
              align-items: center;
              gap: 12px;
              font-weight: 900;
              font-size: 20px;
            }
            .brand-mark {
              width: 42px;
              height: 42px;
              border-radius: 14px;
              background: #111;
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 900;
            }
            .secure-badge {
              background: #fff;
              border: 1px solid #e8e8e8;
              border-radius: 999px;
              padding: 10px 14px;
              font-size: 14px;
              color: #444;
              box-shadow: 0 8px 22px rgba(0,0,0,.05);
            }
            .layout {
              display: grid;
              grid-template-columns: .95fr 1.05fr;
              gap: 24px;
              align-items: start;
            }
            .card {
              background: rgba(255,255,255,.94);
              border: 1px solid #ececec;
              border-radius: 26px;
              box-shadow: 0 18px 50px rgba(0,0,0,.08);
              overflow: hidden;
            }
            .product-card { padding: 24px; }
            .product-image-wrap {
              background: #f3f3f3;
              border-radius: 22px;
              overflow: hidden;
              min-height: 340px;
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 22px;
            }
            .product-image {
              width: 100%;
              height: 340px;
              object-fit: contain;
              display: block;
            }
            .no-image { color: #777; font-size: 15px; }
            .product-title {
              font-size: 28px;
              line-height: 1.15;
              margin: 0 0 8px;
              letter-spacing: -.5px;
            }
            .variant { color: #666; margin-bottom: 18px; font-size: 15px; }
            .summary-row {
              display: flex;
              justify-content: space-between;
              gap: 16px;
              border-top: 1px solid #eee;
              padding: 14px 0;
              font-size: 16px;
            }
            .summary-row.total {
              font-size: 22px;
              font-weight: 900;
              padding-bottom: 0;
            }
            .checkout-card { padding: 30px; }
            .bog-box {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 16px;
              background: #111;
              color: #fff;
              border-radius: 20px;
              padding: 18px 20px;
              margin-bottom: 24px;
            }
            .bog-logo {
              display: flex;
              align-items: center;
              gap: 12px;
              font-weight: 900;
            }
            .bog-circle {
              width: 46px;
              height: 46px;
              border-radius: 16px;
              background: #fff;
              color: #111;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 900;
            }
            .bog-sub { font-size: 13px; color: rgba(255,255,255,.72); margin-top: 2px; }
            h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -.7px; }
            .lead { color: #666; margin: 0 0 22px; line-height: 1.5; }
            .grid-2 {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 14px;
            }
            label {
              display: block;
              margin: 0 0 7px;
              font-weight: 800;
              font-size: 14px;
            }
            .field { margin-bottom: 16px; }
            input {
              width: 100%;
              border: 1px solid #dedede;
              border-radius: 14px;
              padding: 15px;
              font-size: 16px;
              outline: none;
              background: #fff;
            }
            input:focus {
              border-color: #111;
              box-shadow: 0 0 0 4px rgba(17,17,17,.08);
            }
            .pay-button {
              width: 100%;
              min-height: 58px;
              border: 0;
              border-radius: 16px;
              background: #111;
              color: #fff;
              font-size: 17px;
              font-weight: 900;
              cursor: pointer;
              margin-top: 8px;
              box-shadow: 0 14px 30px rgba(0,0,0,.18);
            }
            .pay-button:hover { opacity: .92; }
            .fine-print {
              margin-top: 14px;
              color: #777;
              font-size: 13px;
              line-height: 1.45;
              text-align: center;
            }
            @media (max-width: 860px) {
              body { padding: 18px 12px; }
              .layout { grid-template-columns: 1fr; }
              .topbar { align-items: flex-start; flex-direction: column; }
              .product-image-wrap { min-height: 260px; }
              .product-image { height: 260px; }
              .checkout-card, .product-card { padding: 20px; }
              .grid-2 { grid-template-columns: 1fr; gap: 0; }
              h1 { font-size: 26px; }
              .product-title { font-size: 24px; }
            }
          </style>
        </head>
        <body>
          <main class="page">
            <div class="topbar">
              <div class="brand"><div class="brand-mark">MP</div><div>MyPiano.ge</div></div>
              <div class="secure-badge">🔒 უსაფრთხო გადახდა საქართველოს ბანკით</div>
            </div>
            <div class="layout">
              <section class="card product-card">
                <div class="product-image-wrap">
                  ${
                    productInfo.imageUrl
                      ? `<img class="product-image" src="${escapeHtml(productInfo.imageUrl)}" alt="${escapeHtml(productInfo.productTitle)}" />`
                      : `<div class="no-image">პროდუქტის ფოტო არ მოიძებნა</div>`
                  }
                </div>
                <h2 class="product-title">${escapeHtml(productInfo.productTitle)}</h2>
                ${
                  productInfo.variantTitle
                    ? `<div class="variant">${escapeHtml(productInfo.variantTitle)}</div>`
                    : `<div class="variant">არჩეული პროდუქტი</div>`
                }
                <div class="summary-row"><span>ფასი</span><strong>${formatGel(productInfo.price)}</strong></div>
                <div class="summary-row"><span>რაოდენობა</span><strong>${quantity}</strong></div>
                <div class="summary-row total"><span>ჯამი</span><span>${formatGel(total)}</span></div>
              </section>
              <section class="card checkout-card">
                <div class="bog-box">
                  <div class="bog-logo">
                    <div class="bog-circle">BOG</div>
                    <div><div>საქართველოს ბანკი</div><div class="bog-sub">გადახდის უსაფრთხო გვერდი</div></div>
                  </div>
                  <div>→</div>
                </div>
                <h1>შეკვეთის გაფორმება</h1>
                <p class="lead">შეავსეთ მონაცემები. შემდეგ გადახვალთ საქართველოს ბანკის დაცულ გვერდზე და გადაიხდით ბარათით.</p>
                <form method="POST" action="/checkout">
                  <input type="hidden" name="variant_id" value="${escapeHtml(variantId)}" />
                  <input type="hidden" name="quantity" value="${escapeHtml(quantity)}" />
                  <div class="grid-2">
                    <div class="field"><label>სახელი</label><input name="first_name" autocomplete="given-name" required /></div>
                    <div class="field"><label>გვარი</label><input name="last_name" autocomplete="family-name" required /></div>
                  </div>
                  <div class="field"><label>ტელეფონი</label><input name="phone" autocomplete="tel" required placeholder="მაგ: 599123456" /></div>
                  <div class="field"><label>ელფოსტა</label><input name="email" type="email" autocomplete="email" placeholder="example@mail.com" /></div>
                  <div class="grid-2">
                    <div class="field"><label>ქალაქი</label><input name="city" autocomplete="address-level2" required /></div>
                    <div class="field"><label>მისამართი</label><input name="address1" autocomplete="street-address" required /></div>
                  </div>
                  <button class="pay-button" type="submit">
                    გადახდა საქართველოს ბანკით${total > 0 ? ` — ${formatGel(total)}` : ""}
                  </button>
                  <div class="fine-print">გადახდის ღილაკზე დაჭერის შემდეგ შეიქმნება შეკვეთა და ავტომატურად გადახვალთ საქართველოს ბანკის გვერდზე.</div>
                </form>
              </section>
            </div>
          </main>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Checkout page error:", error);
    return res.status(500).send(`<h1>Checkout page error</h1><p>${escapeHtml(error.message)}</p>`);
  }
});

app.post("/checkout", async (req, res) => {
  try {
    const {
      variant_id,
      quantity,
      first_name,
      last_name,
      phone,
      email,
      city,
      address1,
    } = req.body;

    if (!variant_id || !first_name || !last_name || !phone || !city || !address1) {
      return res.status(400).send("Missing required checkout fields");
    }

    const createdOrder = await createPendingShopifyOrder({
      variantId: variant_id,
      quantity,
      firstName: first_name,
      lastName: last_name,
      phone,
      email,
      city,
      address1,
    });

    const numericOrderId = createdOrder.id;
    const order = await getShopifyOrder(numericOrderId);
    const bogOrder = await createBogOrderForShopifyOrder(numericOrderId, order);
    const redirectUrl = bogOrder._links?.redirect?.href;

    if (!redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "BOG did not return redirect URL",
        bogOrder,
      });
    }

    return res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Custom checkout error:", error);
    return res.status(500).send(`<h1>შეკვეთა ვერ შეიქმნა</h1><p>${escapeHtml(error.message)}</p>`);
  }
});

app.post("/api/bog/callback", async (req, res) => {
  try {
    console.log("BOG CALLBACK:", JSON.stringify(req.body, null, 2));

    const body = req.body.body || req.body;
    const status = body.order_status?.key || body.status;
    const externalOrderId = body.external_order_id;

    if (status !== "completed") {
      return res.sendStatus(200);
    }

    const match = String(externalOrderId || "").match(/^MP-(\d+)$/);
    if (!match) {
      console.log("BOG callback ignored: invalid/non-production external_order_id");
      return res.sendStatus(200);
    }

    const numericOrderId = match[1];
    const shopifyOrderGid = `gid://shopify/Order/${numericOrderId}`;
    let order = await getShopifyOrder(numericOrderId);

    if (order.displayFinancialStatus !== "PAID") {
      const paidOrder = await markShopifyOrderAsPaid(shopifyOrderGid);
      console.log("Shopify order marked as paid:", paidOrder);
      order = await getShopifyOrder(numericOrderId);
    } else {
      console.log("Shopify order already paid:", order.name);
    }

    const total = order.currentTotalPriceSet?.shopMoney;
    const amount = Number(total?.amount || 0);
    const currency = total?.currencyCode || "GEL";
    const phone = order.phone || order.shippingAddress?.phone || "";

    await sendMetaPurchase({
      shopifyOrderId: numericOrderId,
      eventId: `mypiano_purchase_bog_${numericOrderId}`,
      value: amount,
      currency,
      email: order.email || "",
      phone,
      paymentMethod: "ბარათი / განვადება",
      contentName: order.name || `MyPiano order ${numericOrderId}`,
      eventSourceUrl: "https://mypiano.ge",
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("BOG callback error:", error);
    return res.sendStatus(500);
  }
});

app.get("/payment-success", (req, res) => {
  const order = req.query.order || "";

  res.send(`
    <h1>გადახდა წარმატებულია ✅</h1>
    <p>${order ? `შეკვეთა: <strong>${escapeHtml(order)}</strong>` : ""}</p>
    <p>გადახდის დადასტურების შემდეგ Shopify order ავტომატურად განახლდება.</p>
    <p><a href="https://mypiano.ge">mypiano.ge-ზე დაბრუნება</a></p>
  `);
});

app.get("/payment-failed", (req, res) => {
  const order = req.query.order || "";

  res.send(`
    <h1>გადახდა ვერ შესრულდა</h1>
    <p>${order ? `შეკვეთა: <strong>${escapeHtml(order)}</strong>` : ""}</p>
    <p>სცადეთ თავიდან ან დაგვიკავშირდით.</p>
    <p><a href="https://mypiano.ge">mypiano.ge-ზე დაბრუნება</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
