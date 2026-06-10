import express from "express";
import cors from "cors";
import { dbForProduct, firebaseProjectForProduct } from "./firebase.js";

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = process.env.BASE_URL; // ej: https://examenlaboral.onrender.com
const DEFAULT_PRODUCT_ID = "finesLaborales";

const PRODUCTS = {
  finesLaborales: {
    id: "finesLaborales",
    name: "Fines Laborales",
    collection: "users",
    returnUrl:
      process.env.FINES_APP_URL ||
      process.env.FINES_LABORALES_APP_URL ||
      process.env.APP_URL_FINES ||
      BASE_URL,
    token:
      process.env.MP_ACCESS_TOKEN_FINES ||
      process.env.MP_ACCESS_TOKEN_FINESLABORALES ||
      process.env.MP_ACCESS_TOKEN
  },
  paes: {
    id: "paes",
    name: "PAES",
    collection: "paesUsers",
    returnUrl:
      process.env.PAES_APP_URL ||
      process.env.APP_URL_PAES ||
      "https://paes.apruebatodo.cl",
    token: process.env.MP_ACCESS_TOKEN_PAES || process.env.MP_ACCESS_TOKEN
  }
};

const ONE_TIME_PLANS = {
  prueba_dia: {
    label: "1 dia",
    amount: 990,
    days: 1
  },
  un_mes: {
    label: "1 mes",
    amount: 12990,
    months: 1
  },
  tres_meses: {
    label: "3 meses",
    amount: 24990,
    months: 3
  },
  anual: {
    label: "Anual",
    amount: 59990,
    months: 12
  }
};

const PLAN_ALIASES = {
  "prueba-dia": "prueba_dia",
  un_dia: "prueba_dia",
  dia: "prueba_dia",
  "1_dia": "prueba_dia",
  "1-dia": "prueba_dia",
  "un-mes": "un_mes",
  "tres-meses": "tres_meses"
};

function normalizePlanId(plan) {
  const rawPlan = String(plan || "").trim();
  return PLAN_ALIASES[rawPlan] || rawPlan;
}

function productConfig(productId = DEFAULT_PRODUCT_ID) {
  return PRODUCTS[productId] || PRODUCTS[DEFAULT_PRODUCT_ID];
}

function dbForConfig(config) {
  return dbForProduct(config.id);
}

function firebaseProjectForConfig(config) {
  return firebaseProjectForProduct(config.id);
}

function inferProductFromRequest(req) {
  const body = req.body || {};
  const query = req.query || {};
  const explicitProduct = body.product || body.product_id || body.productId || query.product || query.product_id || query.producto;
  if (explicitProduct) return explicitProduct;

  const origin = String(req.get("origin") || "");
  const referer = String(req.get("referer") || req.get("referrer") || "");
  const source = `${origin} ${referer}`.toLowerCase();

  if (source.includes("paes.apruebatodo.cl")) return "paes";
  if (source.includes("apruebatodo.cl") && source.includes("paes")) return "paes";
  if (source.includes("examenlaboral") || source.includes("fineslaborales")) return "finesLaborales";

  return DEFAULT_PRODUCT_ID;
}

function productFromRequest(req) {
  return productConfig(inferProductFromRequest(req));
}

function externalReference(productId, userId) {
  return `${productId}:${userId}`;
}

function parseExternalReference(value, fallbackProductId = DEFAULT_PRODUCT_ID) {
  const reference = String(value || "");
  if (reference.includes(":")) {
    const [productId, ...rest] = reference.split(":");
    return {
      productId: PRODUCTS[productId] ? productId : fallbackProductId,
      userId: rest.join(":")
    };
  }

  return {
    productId: fallbackProductId,
    userId: reference
  };
}

function paymentEmail(resource) {
  return resource?.payer?.email ||
    resource?.collector?.email ||
    resource?.additional_info?.payer?.email ||
    resource?.metadata?.email ||
    "";
}

async function findUserByEmail(email, preferredConfig) {
  if (!email) return null;
  const configs = [
    preferredConfig,
    ...Object.values(PRODUCTS).filter((config) => config.id !== preferredConfig?.id)
  ].filter(Boolean);

  for (const config of configs) {
    const snapshot = await dbForConfig(config).collection(config.collection)
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return {
        config,
        userId: snapshot.docs[0].id
      };
    }
  }

  return null;
}

async function correctProductByExistingUser(config, userId) {
  if (!userId) return config;

  const currentDoc = await dbForConfig(config).collection(config.collection).doc(userId).get();
  if (currentDoc.exists) return config;

  for (const candidate of Object.values(PRODUCTS)) {
    if (candidate.id === config.id) continue;
    const candidateDoc = await dbForConfig(candidate).collection(candidate.collection).doc(userId).get();
    if (candidateDoc.exists) return candidate;
  }

  return config;
}

async function resolvePaidUser(resource, tokenConfig) {
  const metadataProductId = resource?.metadata?.product_id;
  const metadataUserId = resource?.metadata?.user_id || resource?.metadata?.uid;
  const parsedReference = parseExternalReference(resource?.external_reference, tokenConfig.id);
  let config = productConfig(metadataProductId || parsedReference.productId || tokenConfig.id);
  const userId = metadataUserId || parsedReference.userId;

  if (userId) {
    config = await correctProductByExistingUser(config, userId);
    return { config, userId };
  }

  const userByEmail = await findUserByEmail(paymentEmail(resource), config);
  if (userByEmail) return userByEmail;

  return { config, userId: "" };
}

function tokenCandidates() {
  const seen = new Set();
  return Object.values(PRODUCTS).filter((config) => {
    if (!config.token || seen.has(config.token)) return false;
    seen.add(config.token);
    return true;
  });
}

function appReturnUrl(config, status = "success") {
  const base = String(BASE_URL || config.returnUrl || "").replace(/\/$/, "");
  const query = new URLSearchParams({
    pago: status,
    producto: config.id
  });
  return `${base}/retorno-pago?${query.toString()}`;
}

function finalAppReturnUrl(config, status = "ok", extra = {}) {
  const base = String(config.returnUrl || BASE_URL || "").replace(/\/$/, "");
  const query = new URLSearchParams({
    pago: status,
    producto: config.id,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  });
  return `${base}/?${query.toString()}`;
}

async function fetchMercadoPagoResource(topic, id) {
  const rawTopic = String(topic || "").toLowerCase();
  const isPayment = rawTopic.includes("payment");
  const isMerchantOrder = rawTopic.includes("merchant_order");
  const resourceUrl = isPayment
    ? `https://api.mercadopago.com/v1/payments/${id}`
    : isMerchantOrder
      ? `https://api.mercadopago.com/merchant_orders/${id}`
      : `https://api.mercadopago.com/preapproval/${id}`;

  for (const config of tokenCandidates()) {
    const response = await fetch(resourceUrl, {
      headers: {
        Authorization: `Bearer ${config.token}`
      }
    });

    if (response.ok) {
      const resource = await response.json();
      if (isMerchantOrder) {
        const approvedPayment = Array.isArray(resource.payments)
          ? resource.payments.find((payment) => payment.status === "approved") || resource.payments[0]
          : null;

        if (!approvedPayment?.id) {
          return {
            config,
            resource,
            isPayment: false
          };
        }

        const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${approvedPayment.id}`, {
          headers: {
            Authorization: `Bearer ${config.token}`
          }
        });

        if (!paymentResponse.ok) continue;

        return {
          config,
          resource: await paymentResponse.json(),
          isPayment: true
        };
      }

      return {
        config,
        resource,
        isPayment
      };
    }
  }

  return {
    config: productConfig(),
    resource: null,
    isPayment
  };
}

async function findApprovedPaymentByExternalReference(config, reference) {
  if (!config.token || !reference) return null;

  const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc`;
  const response = await fetch(searchUrl, {
    headers: {
      Authorization: `Bearer ${config.token}`
    }
  });

  if (!response.ok) return null;

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const paymentSummary = results.find((payment) => payment.status === "approved") || results[0];

  if (!paymentSummary?.id) return null;

  const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentSummary.id}`, {
    headers: {
      Authorization: `Bearer ${config.token}`
    }
  });

  if (!paymentResponse.ok) return null;

  return paymentResponse.json();
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function addPlanDuration(date, plan) {
  const copy = new Date(date);
  if (plan.days) {
    copy.setDate(copy.getDate() + plan.days);
    return copy;
  }
  return addMonths(copy, plan.months || 0);
}

function planFromPayment(payment) {
  const amount = Math.round(Number(payment.transaction_amount || 0));
  const metadataPlan = normalizePlanId(payment.metadata?.plan);
  if (metadataPlan && ONE_TIME_PLANS[metadataPlan]) {
    return {
      id: metadataPlan,
      ...ONE_TIME_PLANS[metadataPlan]
    };
  }

  const entry = Object.entries(ONE_TIME_PLANS)
    .find(([, plan]) => plan.amount === amount);

  if (!entry) return null;

  return {
    id: entry[0],
    ...entry[1]
  };
}

function paesMembership(data, premium) {
  if (!premium) {
    return {
      plan: "free",
      provider: "mercadopago",
      paymentStatus: data.paymentStatus || data.subscriptionStatus || "cancelled",
      validUntil: data.premiumUntil || null,
      updatedAt: new Date()
    };
  }

  return {
    plan: "pro",
    provider: "mercadopago",
    providerPlan: data.plan,
    planLabel: data.planLabel,
    autoRenew: Boolean(data.autoRenew),
    paymentStatus: data.paymentStatus || data.subscriptionStatus || "approved",
    validUntil: data.premiumUntil || null,
    activatedAt: new Date(),
    updatedAt: new Date()
  };
}

async function activateProduct(config, userId, data) {
  const firebaseProject = firebaseProjectForConfig(config);
  const update = {
    products: {
      [config.id]: {
        premium: true,
        ...data,
        updatedAt: new Date()
      }
    }
  };

  if (config.id === "paes") {
    update.membership = paesMembership(data, true);
  }

  await dbForConfig(config).collection(config.collection).doc(userId).set(update, { merge: true });
  console.log("FIREBASE PREMIUM ACTIVADO:", {
    product: config.id,
    collection: config.collection,
    userId,
    firebaseProject,
    plan: data.plan || null
  });
}

async function deactivateProduct(config, userId, data = {}) {
  const firebaseProject = firebaseProjectForConfig(config);
  const update = {
    products: {
      [config.id]: {
        premium: false,
        ...data,
        updatedAt: new Date()
      }
    }
  };

  if (config.id === "paes") {
    update.membership = paesMembership(data, false);
  }

  await dbForConfig(config).collection(config.collection).doc(userId).set(update, { merge: true });
  console.log("FIREBASE PREMIUM DESACTIVADO:", {
    product: config.id,
    collection: config.collection,
    userId,
    firebaseProject,
    plan: data.plan || null
  });
}

// =============================
// CREAR SUSCRIPCION
// =============================
app.post("/crear-suscripcion", async (req, res) => {
  try {
    const { email, user_id } = req.body;
    const config = productFromRequest(req);

    console.log("=================================");
    console.log("CREANDO SUSCRIPCION");
    console.log("PRODUCTO:", config.id);
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
    console.log("ORIGIN:", req.get("origin") || "");
    console.log("REFERER:", req.get("referer") || req.get("referrer") || "");
    console.log("BASE URL:", BASE_URL);
    console.log("TOKEN:", config.token ? `${config.token.substring(0, 15)}...` : "NO TOKEN");
    console.log("=================================");

    if (!email || !user_id) {
      return res.status(400).json({
        error: "Faltan datos"
      });
    }

    if (!config.token) {
      return res.status(500).json({
        error: `Falta token de Mercado Pago para ${config.id}`
      });
    }

    const payload = {
      reason: `Suscripcion Pro ${config.name} - ApruebaTodo`,
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: 9990,
        currency_id: "CLP"
      },
      payer_email: email,
      back_url: appReturnUrl(config, "ok"),
      notification_url: `${BASE_URL}/webhook`,
      external_reference: externalReference(config.id, user_id),
      metadata: {
        product_id: config.id,
        product_name: config.name,
        user_id,
        email
      }
    };

    const response = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    console.log("MP STATUS:", response.status);
    console.log("MP RESPONSE:", JSON.stringify(data, null, 2));

    if (!data.init_point) {
      return res.status(500).json({ error: data });
    }

    res.json({
      init_point: data.init_point,
      product: config.id
    });
  } catch (err) {
    console.error("ERROR CREAR SUSCRIPCION:");
    console.error(err);
    res.status(500).json({
      error: "Error creando suscripcion"
    });
  }
});

// =============================
// CREAR PAGO UNICO CHECKOUT PRO
// =============================
app.post("/crear-pago", async (req, res) => {
  try {
    const { email, user_id, plan } = req.body;
    const config = productFromRequest(req);
    const normalizedPlan = normalizePlanId(plan);
    const selectedPlan = ONE_TIME_PLANS[normalizedPlan];

    console.log("=================================");
    console.log("CREANDO PAGO UNICO CHECKOUT PRO");
    console.log("PRODUCTO:", config.id);
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
    console.log("PLAN:", plan);
    console.log("PLAN NORMALIZADO:", normalizedPlan);
    console.log("ORIGIN:", req.get("origin") || "");
    console.log("REFERER:", req.get("referer") || req.get("referrer") || "");
    console.log("BASE URL:", BASE_URL);
    console.log("=================================");

    if (!email || !user_id || !selectedPlan) {
      return res.status(400).json({
        error: "Faltan datos o plan invalido",
        recibido: {
          email: Boolean(email),
          user_id: Boolean(user_id),
          plan
        },
        plan_normalizado: normalizedPlan,
        planes_disponibles: Object.keys(ONE_TIME_PLANS)
      });
    }

    if (!config.token) {
      return res.status(500).json({
        error: `Falta token de Mercado Pago para ${config.id}`
      });
    }

    const payload = {
      items: [
        {
          id: `${config.id}-${plan}`,
          title: `${config.name} Pro - ${selectedPlan.label}`,
          description: `Acceso Pro ${config.name} por ${selectedPlan.label}`,
          quantity: 1,
          currency_id: "CLP",
          unit_price: selectedPlan.amount
        }
      ],
      payer: {
        email
      },
      back_urls: {
        success: appReturnUrl(config, "ok"),
        failure: appReturnUrl(config, "error"),
        pending: appReturnUrl(config, "pendiente")
      },
      auto_return: "approved",
      notification_url: `${BASE_URL}/webhook`,
      external_reference: externalReference(config.id, user_id),
      metadata: {
        product_id: config.id,
        product_name: config.name,
        user_id,
        email,
        plan: normalizedPlan
      }
    };

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    console.log("MP PREFERENCE STATUS:", response.status);
    console.log("MP PREFERENCE RESPONSE:", JSON.stringify(data, null, 2));

    if (!data.init_point) {
      return res.status(500).json({ error: data });
    }

    res.json({
      init_point: data.init_point,
      preference_id: data.id,
      product: config.id,
      plan: normalizedPlan
    });
  } catch (err) {
    console.error("ERROR CREAR PAGO UNICO:");
    console.error(err);
    res.status(500).json({ error: "Error creando pago unico" });
  }
});

async function activateApprovedPayment(resource, tokenConfig, paymentId) {
  if (resource.status !== "approved") {
    return {
      ok: false,
      code: "payment_not_approved",
      status: resource.status
    };
  }

  const selectedPlan = planFromPayment(resource);

  if (!selectedPlan) {
    return {
      ok: false,
      code: "plan_not_found",
      amount: resource.transaction_amount,
      metadata: resource.metadata || null
    };
  }

  const { config, userId } = await resolvePaidUser(resource, tokenConfig);

  if (!userId) {
    return {
      ok: false,
      code: "user_not_found",
      external_reference: resource.external_reference || null,
      metadata: resource.metadata || null,
      email: paymentEmail(resource) || null
    };
  }

  const paidAt = new Date(resource.date_approved || resource.date_created || Date.now());
  const premiumUntil = addPlanDuration(paidAt, selectedPlan);

  if (premiumUntil <= new Date()) {
    await deactivateProduct(config, userId, {
      plan: selectedPlan.id,
      planLabel: selectedPlan.label,
      paymentId,
      paymentStatus: "expired",
      premiumSince: paidAt,
      premiumUntil,
      autoRenew: false
    });

    return {
      ok: false,
      code: "payment_access_expired",
      product: config.id,
      user_id: userId,
      plan: selectedPlan.id,
      premiumUntil
    };
  }

  await activateProduct(config, userId, {
    plan: selectedPlan.id,
    planLabel: selectedPlan.label,
    paymentId,
    paymentStatus: resource.status,
    premiumSince: paidAt,
    premiumUntil,
    autoRenew: false
  });

  return {
    ok: true,
    product: config.id,
    user_id: userId,
    plan: selectedPlan.id,
    premiumUntil
  };
}

async function activateApprovedSubscription(resource, tokenConfig, subscriptionId) {
  const { config, userId } = await resolvePaidUser(resource, tokenConfig);

  if (!userId) {
    return {
      ok: false,
      code: "user_not_found",
      external_reference: resource.external_reference || null,
      metadata: resource.metadata || null,
      email: paymentEmail(resource) || null
    };
  }

  if (resource.status === "authorized" || resource.status === "active") {
    await activateProduct(config, userId, {
      plan: "suscripcion_mensual",
      planLabel: "$9.990 / mes",
      subscriptionId,
      subscriptionStatus: resource.status,
      premiumSince: new Date(),
      premiumUntil: null,
      autoRenew: true
    });

    return {
      ok: true,
      product: config.id,
      user_id: userId,
      plan: "suscripcion_mensual"
    };
  }

  if (["paused", "cancelled"].includes(resource.status)) {
    await deactivateProduct(config, userId, {
      subscriptionId,
      subscriptionStatus: resource.status
    });

    return {
      ok: true,
      deactivated: true,
      product: config.id,
      user_id: userId,
      status: resource.status
    };
  }

  return {
    ok: false,
    code: "subscription_not_active",
    status: resource.status
  };
}

// =============================
// WEBHOOK MERCADOPAGO
// =============================
async function handleMercadoPagoWebhook(req, res) {
  try {
    const body = req.body || {};
    console.log("WEBHOOK:", JSON.stringify(body, null, 2));
    console.log("WEBHOOK QUERY:", JSON.stringify(req.query, null, 2));

    const id = body.data?.id || req.query["data.id"] || req.query.id;
    const topic = body.type || req.query.type || body.topic || req.query.topic || "preapproval";

    if (!id) {
      console.log("Sin ID");
      return res.sendStatus(200);
    }

    const { config: tokenConfig, resource, isPayment } = await fetchMercadoPagoResource(topic, id);

    if (!resource) {
      console.log("No se pudo consultar recurso en Mercado Pago:", id);
      return res.sendStatus(200);
    }

    console.log("ID:", id);
    console.log("TOPIC:", topic);
    console.log("RESOURCE STATUS:", resource.status);

    if (isPayment) {
      const result = await activateApprovedPayment(resource, tokenConfig, id);
      console.log("RESULTADO ACTIVACION PAGO:", result);
      return res.sendStatus(200);
    }

    const result = await activateApprovedSubscription(resource, tokenConfig, id);
    console.log("RESULTADO ACTIVACION SUSCRIPCION:", result);

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
}

app.post("/webhook", handleMercadoPagoWebhook);
app.get("/webhook", handleMercadoPagoWebhook);

async function confirmPaymentPayload(req, payload) {
  const paymentId = payload.payment_id || payload.collection_id;
  const merchantOrderId = payload.merchant_order_id;
  const preferenceId = payload.preference_id;
  const preapprovalId = payload.preapproval_id || payload.subscription_id;
  const config = productFromRequest(req);
  const parsedReference = parseExternalReference(payload.external_reference, config.id);
  const userId = payload.user_id || parsedReference.userId;

  console.log("CONFIRMAR PAGO:", {
    product: config.id,
    paymentId,
    merchantOrderId,
    preferenceId,
    preapprovalId,
    user_id: userId || "",
    status: payload.status || payload.collection_status || ""
  });

  if (paymentId) {
    const { config: tokenConfig, resource } = await fetchMercadoPagoResource("payment", paymentId);

    if (!resource) {
      return { ok: false, statusCode: 404, error: "Pago no encontrado en Mercado Pago" };
    }

    return {
      statusCode: 200,
      ...(await activateApprovedPayment(resource, tokenConfig, paymentId))
    };
  }

  if (merchantOrderId) {
    const { config: tokenConfig, resource, isPayment } = await fetchMercadoPagoResource("merchant_order", merchantOrderId);

    if (!resource) {
      return { ok: false, statusCode: 404, error: "Orden no encontrada en Mercado Pago" };
    }

    if (!isPayment) {
      return {
        ok: false,
        statusCode: 400,
        error: "La orden no tiene pago aprobado todavia",
        status: resource.status || null
      };
    }

    return {
      statusCode: 200,
      ...(await activateApprovedPayment(resource, tokenConfig, String(resource.id)))
    };
  }

  if (preapprovalId) {
    const { config: tokenConfig, resource } = await fetchMercadoPagoResource("preapproval", preapprovalId);

    if (!resource) {
      return { ok: false, statusCode: 404, error: "Suscripcion no encontrada en Mercado Pago" };
    }

    return {
      statusCode: 200,
      ...(await activateApprovedSubscription(resource, tokenConfig, preapprovalId))
    };
  }

  if (preferenceId || userId || payload.external_reference) {
    const reference = payload.external_reference || externalReference(config.id, userId);
    const resource = await findApprovedPaymentByExternalReference(config, reference);

    if (!resource) {
      return {
        ok: false,
        statusCode: 404,
        error: "No se encontro pago aprobado para este usuario",
        preference_id: preferenceId || null,
        external_reference: reference
      };
    }

    return {
      statusCode: 200,
      ...(await activateApprovedPayment(resource, config, String(resource.id)))
    };
  }

  return {
    ok: false,
    statusCode: 400,
    error: "Falta payment_id, collection_id, merchant_order_id, preapproval_id, preference_id o user_id"
  };
}

app.get("/retorno-pago", async (req, res) => {
  const config = productFromRequest(req);
  try {
    const result = await confirmPaymentPayload(req, req.query || {});
    console.log("RETORNO PAGO:", result);
    const status = result.ok ? "ok" : "pendiente";
    return res.redirect(finalAppReturnUrl(config, status, {
      premium: result.ok ? "1" : "0",
      motivo: result.code || result.error || "",
      plan: result.plan || ""
    }));
  } catch (err) {
    console.error("ERROR RETORNO PAGO:", err);
    return res.redirect(finalAppReturnUrl(config, "error", {
      premium: "0",
      motivo: "error_confirmando_pago"
    }));
  }
});

// =============================
// CONFIRMAR PAGO AL VOLVER A LA APP
// =============================
app.post("/confirmar-pago", async (req, res) => {
  try {
    const paymentId = req.body.payment_id || req.body.collection_id;
    const merchantOrderId = req.body.merchant_order_id;
    const preferenceId = req.body.preference_id;
    const preapprovalId = req.body.preapproval_id || req.body.subscription_id;
    const config = productFromRequest(req);
    const userId = req.body.user_id;

    console.log("CONFIRMAR PAGO:", {
      product: config.id,
      paymentId,
      merchantOrderId,
      preferenceId,
      preapprovalId,
      user_id: userId || "",
      status: req.body.status || ""
    });

    if (paymentId) {
      const { config: tokenConfig, resource } = await fetchMercadoPagoResource("payment", paymentId);

      if (!resource) {
        return res.status(404).json({ ok: false, error: "Pago no encontrado en Mercado Pago" });
      }

      const result = await activateApprovedPayment(resource, tokenConfig, paymentId);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (merchantOrderId) {
      const { config: tokenConfig, resource, isPayment } = await fetchMercadoPagoResource("merchant_order", merchantOrderId);

      if (!resource) {
        return res.status(404).json({ ok: false, error: "Orden no encontrada en Mercado Pago" });
      }

      if (!isPayment) {
        return res.status(400).json({
          ok: false,
          error: "La orden no tiene pago aprobado todavia",
          status: resource.status || null
        });
      }

      const result = await activateApprovedPayment(resource, tokenConfig, String(resource.id));
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (preapprovalId) {
      const { config: tokenConfig, resource } = await fetchMercadoPagoResource("preapproval", preapprovalId);

      if (!resource) {
        return res.status(404).json({ ok: false, error: "Suscripcion no encontrada en Mercado Pago" });
      }

      const result = await activateApprovedSubscription(resource, tokenConfig, preapprovalId);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (preferenceId || userId) {
      const reference = externalReference(config.id, userId);
      const resource = await findApprovedPaymentByExternalReference(config, reference);

      if (!resource) {
        return res.status(404).json({
          ok: false,
          error: "No se encontro pago aprobado para este usuario",
          preference_id: preferenceId || null,
          external_reference: reference
        });
      }

      const result = await activateApprovedPayment(resource, config, String(resource.id));
      return res.status(result.ok ? 200 : 400).json(result);
    }

    return res.status(400).json({
      ok: false,
      error: "Falta payment_id, collection_id, merchant_order_id, preapproval_id, preference_id o user_id"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error confirmando pago" });
  }
});

// =============================
// REPROCESAR PAGO APROBADO
// =============================
app.get("/reprocesar-pago/:payment_id", async (req, res) => {
  try {
    const { payment_id } = req.params;
    const { config: tokenConfig, resource } = await fetchMercadoPagoResource("payment", payment_id);

    if (!resource) {
      return res.status(404).json({ error: "Pago no encontrado en Mercado Pago" });
    }

    const result = await activateApprovedPayment(resource, tokenConfig, payment_id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error reprocesando pago" });
  }
});

// =============================
// HEALTH CHECK
// =============================
app.get("/", (req, res) => {
  res.send("Servidor OK");
});

app.get("/config-productos", (req, res) => {
  const data = Object.values(PRODUCTS).map((config) => {
    try {
      return {
        product: config.id,
        collection: config.collection,
        firebaseProject: firebaseProjectForConfig(config),
        hasMercadoPagoToken: Boolean(config.token),
        returnUrl: config.returnUrl
      };
    } catch (error) {
      return {
        product: config.id,
        collection: config.collection,
        firebaseProject: null,
        firebaseError: error.message,
        hasMercadoPagoToken: Boolean(config.token),
        returnUrl: config.returnUrl
      };
    }
  });

  res.json({ products: data });
});

async function premiumResponse(req, res, productId, userId) {
  try {
    const config = productConfig(productId);
    const firebaseProject = firebaseProjectForConfig(config);

    if (!userId) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    const userDoc = await dbForConfig(config).collection(config.collection).doc(userId).get();
    const product = userDoc.exists
      ? userDoc.data()?.products?.[config.id]
      : null;
    const premiumUntilDate = product?.premiumUntil?.toDate
      ? product.premiumUntil.toDate()
      : product?.premiumUntil
        ? new Date(product.premiumUntil)
        : null;
    const isExpired = premiumUntilDate && premiumUntilDate <= new Date();
    const premium = Boolean(product?.premium) && !isExpired;

    res.json({
      product: config.id,
      firebaseProject,
      premium,
      plan: product?.plan || "free",
      planLabel: product?.planLabel || null,
      autoRenew: Boolean(product?.autoRenew),
      paymentStatus: product?.paymentStatus || null,
      subscriptionStatus: product?.subscriptionStatus || null,
      premiumSince: product?.premiumSince || null,
      premiumUntil: premiumUntilDate ? premiumUntilDate.toISOString() : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error consultando premium" });
  }
}

// =============================
// CONSULTAR PREMIUM
// =============================
app.get("/premium/:product_id/:user_id", async (req, res) => {
  const { product_id, user_id } = req.params;
  await premiumResponse(req, res, product_id, user_id);
});

app.get("/premium/:user_id", async (req, res) => {
  const { user_id } = req.params;
  await premiumResponse(req, res, DEFAULT_PRODUCT_ID, user_id);
});

// =============================
// CANCELAR SUSCRIPCION
// =============================
app.post("/cancelar-suscripcion", async (req, res) => {
  try {
    const { user_id } = req.body;
    const config = productFromRequest(req);

    if (!user_id) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    if (!config.token) {
      return res.status(500).json({
        error: `Falta token de Mercado Pago para ${config.id}`
      });
    }

    const userDoc = await dbForConfig(config).collection(config.collection).doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuario no existe" });
    }

    const subId = userDoc.data()?.products?.[config.id]?.subscriptionId;

    if (!subId) {
      return res.status(400).json({ error: "No tiene suscripcion" });
    }

    await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        status: "cancelled"
      })
    });

    await deactivateProduct(config, user_id, {
      subscriptionStatus: "cancelled"
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error cancelando" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
