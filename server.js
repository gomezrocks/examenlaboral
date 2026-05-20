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

      reason: "Suscripción PRO WebHoy",

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
// 🔔 WEBHOOK MERCADOPAGO
// =============================
app.post("/webhook", async (req, res) => {
  try {

    console.log(
      "🔥 WEBHOOK:",
      JSON.stringify(req.body, null, 2)
    );

    const id =
      req.body.data?.id;

    if (!id) {
      console.log("❌ Sin ID");
      return res.sendStatus(200);
    }

    console.log("ID:", id);
    // 🔥 CONSULTAR SUSCRIPCIÓN
    const response = await fetch(
      `https://api.mercadopago.com/preapproval/${id}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        }
      }
    );

    const sub =
      await response.json();

    console.log(
      "SUB STATUS:",
      sub.status
    );
    const userId = sub.external_reference;

    if (!userId) return res.sendStatus(200);

    // =============================
    // 🟢 ACTIVA
    // =============================
    if (sub.status === "authorized" || sub.status === "active"){

      await db.collection("users").doc(userId).set({
        premium: true,
        subscriptionId: id,
        premiumSince: new Date()
      }, { merge: true });

      console.log("🔥 PREMIUM ACTIVADO:", userId);
    }

    // =============================
    // 🔴 CANCELADA / PAUSADA
    // =============================
    if (["paused", "cancelled"].includes(sub.status)) {

      await db.collection("users").doc(userId).update({
        premium: false
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

    const subId = userDoc.data().subscriptionId;

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

    await db.collection("users").doc(user_id).update({
      premium: false
    });

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error cancelando" });
  }
});