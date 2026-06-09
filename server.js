import express from "express";
import cors from "cors";
import { db } from "./firebase.js";

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
    token:
      process.env.MP_ACCESS_TOKEN_FINES ||
      process.env.MP_ACCESS_TOKEN_FINESLABORALES ||
      process.env.MP_ACCESS_TOKEN
  },
  paes: {
    id: "paes",
    name: "PAES",
    collection: "paesUsers",
    token: process.env.MP_ACCESS_TOKEN_PAES || process.env.MP_ACCESS_TOKEN
  }
};

const ONE_TIME_PLANS = {
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

function productConfig(productId = DEFAULT_PRODUCT_ID) {
  return PRODUCTS[productId] || PRODUCTS[DEFAULT_PRODUCT_ID];
}

function productFromRequest(body = {}) {
  return productConfig(body.product || body.product_id || body.productId);
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

function tokenCandidates() {
  const seen = new Set();
  return Object.values(PRODUCTS).filter((config) => {
    if (!config.token || seen.has(config.token)) return false;
    seen.add(config.token);
    return true;
  });
}

async function fetchMercadoPagoResource(topic, id) {
  const isPayment = String(topic).includes("payment");
  const resourceUrl = isPayment
    ? `https://api.mercadopago.com/v1/payments/${id}`
    : `https://api.mercadopago.com/preapproval/${id}`;

  for (const config of tokenCandidates()) {
    const response = await fetch(resourceUrl, {
      headers: {
        Authorization: `Bearer ${config.token}`
      }
    });

    if (response.ok) {
      return {
        config,
        resource: await response.json(),
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

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function planFromPayment(payment) {
  const amount = Math.round(Number(payment.transaction_amount || 0));
  const metadataPlan = payment.metadata?.plan;
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

  await db.collection(config.collection).doc(userId).set(update, { merge: true });
}

async function deactivateProduct(config, userId, data = {}) {
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

  await db.collection(config.collection).doc(userId).set(update, { merge: true });
}

// =============================
// CREAR SUSCRIPCION
// =============================
app.post("/crear-suscripcion", async (req, res) => {
  try {
    const { email, user_id } = req.body;
    const config = productFromRequest(req.body);

    console.log("=================================");
    console.log("CREANDO SUSCRIPCION");
    console.log("PRODUCTO:", config.id);
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
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
      back_url: `${BASE_URL}/gracias.html`,
      notification_url: `${BASE_URL}/webhook`,
      external_reference: externalReference(config.id, user_id),
      metadata: {
        product_id: config.id,
        product_name: config.name
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
      init_point: data.init_point
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
    const config = productFromRequest(req.body);
    const selectedPlan = ONE_TIME_PLANS[plan];

    console.log("=================================");
    console.log("CREANDO PAGO UNICO CHECKOUT PRO");
    console.log("PRODUCTO:", config.id);
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
    console.log("PLAN:", plan);
    console.log("BASE URL:", BASE_URL);
    console.log("=================================");

    if (!email || !user_id || !selectedPlan) {
      return res.status(400).json({
        error: "Faltan datos o plan invalido",
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
        success: `${BASE_URL}/gracias.html`,
        failure: `${BASE_URL}/pago-error.html`,
        pending: `${BASE_URL}/pago-pendiente.html`
      },
      auto_return: "approved",
      notification_url: `${BASE_URL}/webhook`,
      external_reference: externalReference(config.id, user_id),
      metadata: {
        product_id: config.id,
        product_name: config.name,
        plan
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
      preference_id: data.id
    });
  } catch (err) {
    console.error("ERROR CREAR PAGO UNICO:");
    console.error(err);
    res.status(500).json({ error: "Error creando pago unico" });
  }
});

// =============================
// WEBHOOK MERCADOPAGO
// =============================
app.post("/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK:", JSON.stringify(req.body, null, 2));

    const id = req.body.data?.id || req.query["data.id"] || req.query.id;
    const topic = req.body.type || req.query.type || req.body.topic || req.query.topic || "preapproval";

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

    const metadataProductId = resource.metadata?.product_id;
    const parsedReference = parseExternalReference(resource.external_reference, tokenConfig.id);
    const config = productConfig(metadataProductId || parsedReference.productId || tokenConfig.id);
    const userId = parsedReference.userId;

    if (!userId) return res.sendStatus(200);

    if (isPayment) {
      if (resource.status !== "approved") {
        console.log("PAGO NO APROBADO:", resource.status);
        return res.sendStatus(200);
      }

      const selectedPlan = planFromPayment(resource);

      if (!selectedPlan) {
        console.log("No se pudo inferir plan por monto:", resource.transaction_amount);
        return res.sendStatus(200);
      }

      await activateProduct(config, userId, {
        plan: selectedPlan.id,
        planLabel: selectedPlan.label,
        paymentId: id,
        paymentStatus: resource.status,
        premiumSince: new Date(),
        premiumUntil: addMonths(new Date(), selectedPlan.months),
        autoRenew: false
      });

      console.log("PREMIUM PAGO UNICO ACTIVADO:", config.id, userId, selectedPlan.id);
      return res.sendStatus(200);
    }

    if (resource.status === "authorized" || resource.status === "active") {
      await activateProduct(config, userId, {
        plan: "suscripcion_mensual",
        planLabel: "$9.990 / mes",
        subscriptionId: id,
        subscriptionStatus: resource.status,
        premiumSince: new Date(),
        premiumUntil: null,
        autoRenew: true
      });

      console.log("PREMIUM ACTIVADO:", config.id, userId);
    }

    if (["paused", "cancelled"].includes(resource.status)) {
      await deactivateProduct(config, userId, {
        subscriptionId: id,
        subscriptionStatus: resource.status
      });

      console.log("PREMIUM DESACTIVADO:", config.id, userId);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// =============================
// HEALTH CHECK
// =============================
app.get("/", (req, res) => {
  res.send("Servidor OK");
});

async function premiumResponse(req, res, productId, userId) {
  try {
    const config = productConfig(productId);

    if (!userId) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    const userDoc = await db.collection(config.collection).doc(userId).get();
    const product = userDoc.exists
      ? userDoc.data()?.products?.[config.id]
      : null;

    res.json({
      product: config.id,
      premium: Boolean(product?.premium),
      plan: product?.plan || "free",
      planLabel: product?.planLabel || null,
      autoRenew: Boolean(product?.autoRenew),
      paymentStatus: product?.paymentStatus || null,
      subscriptionStatus: product?.subscriptionStatus || null,
      premiumSince: product?.premiumSince || null,
      premiumUntil: product?.premiumUntil || null
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
    const config = productFromRequest(req.body);

    if (!user_id) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    if (!config.token) {
      return res.status(500).json({
        error: `Falta token de Mercado Pago para ${config.id}`
      });
    }

    const userDoc = await db.collection(config.collection).doc(user_id).get();

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
