import express from "express";
import cors from "cors";
import crypto from "crypto";
import { db } from "./firebase.js";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 ENV
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL; // ej: https://tu-app.onrender.com
const PRODUCT_ID = "finesLaborales";
const PRODUCT_NAME = "Fines Laborales";

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

async function activateProduct(userId, data) {
  await db.collection("users").doc(userId).set({
    products: {
      [PRODUCT_ID]: {
        premium: true,
        ...data,
        updatedAt: new Date()
      }
    }
  }, { merge: true });
}

async function deactivateProduct(userId, data = {}) {
  await db.collection("users").doc(userId).set({
    products: {
      [PRODUCT_ID]: {
        premium: false,
        ...data,
        updatedAt: new Date()
      }
    }
  }, { merge: true });
}

// =============================
// 🚀 CREAR SUSCRIPCIÓN
// =============================
// =============================
// 🚀 CREAR SUSCRIPCIÓN
// =============================
app.post("/crear-suscripcion", async (req, res) => {

  try {

    const { email, user_id } = req.body;

    console.log("=================================");
    console.log("🚀 CREANDO SUSCRIPCIÓN");
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
    console.log("BASE URL:", BASE_URL);
    console.log(
      "TOKEN:",
      MP_ACCESS_TOKEN
        ? MP_ACCESS_TOKEN.substring(0, 15) + "..."
        : "NO TOKEN"
    );
    console.log("=================================");

    if (!email || !user_id) {

      console.log("❌ Faltan datos");

      return res.status(400).json({
        error: "Faltan datos"
      });
    }

    const payload = {

      reason: `Suscripción Pro ${PRODUCT_NAME} - ApruebaTodo`,

      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: 9990,
        currency_id: "CLP"
      },

      payer_email: email,

      // usuario vuelve aquí
      back_url: `${BASE_URL}/gracias.html`,

      // MercadoPago avisará al servidor
      notification_url:
        `${BASE_URL}/webhook`,

      external_reference:
        user_id

    };

    console.log(
      "📦 PAYLOAD:",
      JSON.stringify(payload, null, 2)
    );

    const response = await fetch(
      "https://api.mercadopago.com/preapproval",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify(payload)
      }
    );

    console.log("🔥 MP STATUS:", response.status);

    const data = await response.json();

    console.log(
      "🔥 MP RESPONSE:",
      JSON.stringify(data, null, 2)
    );

    if (!data.init_point) {

      console.log("❌ No viene init_point");

      return res.status(500).json({
        error: data
      });
    }

    console.log("✅ SUSCRIPCIÓN CREADA");

    res.json({
      init_point: data.init_point
    });

  } catch (err) {

    console.error("❌ ERROR CREAR SUSCRIPCIÓN:");
    console.error(err);

    res.status(500).json({
      error: "Error creando suscripción"
    });
  }
});

// =============================
// 💳 CREAR PAGO ÚNICO CHECKOUT PRO
// =============================
app.post("/crear-pago", async (req, res) => {
  try {
    const { email, user_id, plan } = req.body;
    const selectedPlan = ONE_TIME_PLANS[plan];

    console.log("=================================");
    console.log("💳 CREANDO PAGO ÚNICO CHECKOUT PRO");
    console.log("EMAIL:", email);
    console.log("USER ID:", user_id);
    console.log("PLAN:", plan);
    console.log("BASE URL:", BASE_URL);
    console.log("=================================");

    if (!email || !user_id || !selectedPlan) {
      return res.status(400).json({
        error: "Faltan datos o plan inválido",
        planes_disponibles: Object.keys(ONE_TIME_PLANS)
      });
    }

    const payload = {
      items: [
        {
          id: `${PRODUCT_ID}-${plan}`,
          title: `${PRODUCT_NAME} Pro - ${selectedPlan.label}`,
          description: `Acceso Pro ${PRODUCT_NAME} por ${selectedPlan.label}`,
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
      external_reference: user_id,
      metadata: {
        product_id: PRODUCT_ID,
        product_name: PRODUCT_NAME,
        plan
      }
    };

    const response = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    console.log("🔥 MP PREFERENCE STATUS:", response.status);
    console.log("🔥 MP PREFERENCE RESPONSE:", JSON.stringify(data, null, 2));

    if (!data.init_point) {
      return res.status(500).json({ error: data });
    }

    res.json({
      init_point: data.init_point,
      preference_id: data.id
    });

  } catch (err) {
    console.error("❌ ERROR CREAR PAGO ÚNICO:");
    console.error(err);
    res.status(500).json({ error: "Error creando pago único" });
  }
});
// =============================
// 🔔 WEBHOOK MERCADOPAGO
// =============================
app.post("/webhook", async (req, res) => {
  try {

    console.log(
      "🔥 WEBHOOK:",
      JSON.stringify(req.body, null, 2)
    );

    const id = req.body.data?.id || req.query["data.id"] || req.query.id;
    const topic = req.body.type || req.query.type || req.body.topic || req.query.topic || "preapproval";

    if (!id) {
      console.log("❌ Sin ID");
      return res.sendStatus(200);
    }

    console.log("ID:", id);
    console.log("TOPIC:", topic);

    const isPayment = String(topic).includes("payment");
    const resourceUrl = isPayment
      ? `https://api.mercadopago.com/v1/payments/${id}`
      : `https://api.mercadopago.com/preapproval/${id}`;

    const response = await fetch(
      resourceUrl,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        }
      }
    );

    const resource = await response.json();

    console.log(
      "RESOURCE STATUS:",
      resource.status
    );

    const userId = resource.external_reference;

    if (!userId) return res.sendStatus(200);

    if (isPayment) {
      if (resource.status !== "approved") {
        console.log("⏳ PAGO NO APROBADO:", resource.status);
        return res.sendStatus(200);
      }

      const selectedPlan = planFromPayment(resource);

      if (!selectedPlan) {
        console.log("❌ No se pudo inferir plan por monto:", resource.transaction_amount);
        return res.sendStatus(200);
      }

      await activateProduct(userId, {
        plan: selectedPlan.id,
        planLabel: selectedPlan.label,
        paymentId: id,
        paymentStatus: resource.status,
        premiumSince: new Date(),
        premiumUntil: addMonths(new Date(), selectedPlan.months),
        autoRenew: false
      });

      console.log("🔥 PREMIUM PAGO ÚNICO ACTIVADO:", userId, selectedPlan.id);
      return res.sendStatus(200);
    }

    // =============================
    // 🟢 ACTIVA
    // =============================
    if (resource.status === "authorized" || resource.status === "active"){

      await activateProduct(userId, {
        plan: "suscripcion_mensual",
        planLabel: "$9.990 / mes",
        subscriptionId: id,
        subscriptionStatus: resource.status,
        premiumSince: new Date(),
        premiumUntil: null,
        autoRenew: true
      });

      console.log("🔥 PREMIUM ACTIVADO:", userId);
    }

    // =============================
    // 🔴 CANCELADA / PAUSADA
    // =============================
    if (["paused", "cancelled"].includes(resource.status)) {

      await deactivateProduct(userId, {
        subscriptionId: id,
        subscriptionStatus: resource.status
      });

      console.log("❌ PREMIUM DESACTIVADO:", userId);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// =============================
// ❤️ HEALTH CHECK
// =============================
app.get("/", (req, res) => {
  res.send("Servidor OK 🚀");
});

// =============================
// ⭐ CONSULTAR PREMIUM
// =============================
app.get("/premium/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    if (!user_id) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    const userDoc = await db.collection("users").doc(user_id).get();
    const product = userDoc.exists
      ? userDoc.data()?.products?.[PRODUCT_ID]
      : null;

    res.json({
      product: PRODUCT_ID,
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
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

//CANCELAR SUSCRIPCIÓN
app.post("/cancelar-suscripcion", async (req, res) => {
  try {

    const { user_id } = req.body;

    const userDoc = await db.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuario no existe" });
    }

    const subId = userDoc.data()?.products?.[PRODUCT_ID]?.subscriptionId;

    if (!subId) {
      return res.status(400).json({ error: "No tiene suscripción" });
    }

    await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        status: "cancelled"
      })
    });

    await db.collection("users").doc(user_id).set({
      products: {
        [PRODUCT_ID]: {
          premium: false,
          subscriptionStatus: "cancelled",
          updatedAt: new Date()
        }
      }
    }, { merge: true });

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error cancelando" });
  }
});
