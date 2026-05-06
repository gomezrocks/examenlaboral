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
app.post("/crear-suscripcion", async (req, res) => {
  try {
    const { email, user_id } = req.body;

    if (!email || !user_id) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const response = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        reason: "Suscripción PRO WebHoy",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 990,
          currency_id: "CLP"
        },
        payer_email: email,
        back_url: `${BASE_URL}/gracias.html`,
        external_reference: user_id // 🔥 CLAVE
      })
    });

    const data = await response.json();

    console.log("MP RESPONSE:", data);

    if (!data.init_point) {
      return res.status(500).json({ error: data });
    }

    res.json({ init_point: data.init_point });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando suscripción" });
  }
});

// =============================
// 🔔 WEBHOOK MERCADOPAGO
// =============================
app.post("/webhook", async (req, res) => {
  try {

    const type = req.body.type;
    const id = req.body.data?.id;

    if (type !== "preapproval" || !id) {
      return res.sendStatus(200);
    }

    // 🔥 CONSULTAR SUSCRIPCIÓN
    const response = await fetch(
      `https://api.mercadopago.com/preapproval/${id}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        }
      }
    );

    const sub = await response.json();

    console.log("SUB:", sub.status);

    const userId = sub.external_reference;

    if (!userId) return res.sendStatus(200);

    // =============================
    // 🟢 ACTIVA
    // =============================
    if (sub.status === "authorized") {

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