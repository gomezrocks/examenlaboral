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
// 🚀 CREAR PREFERENCIA DE PAGO
// =============================
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { email, nombre } = req.body;

    if (!email || !nombre) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const referenceId = crypto.randomUUID();

    // Guardar intento en Firestore
    await db.collection("pagos").doc(referenceId).set({
      email,
      nombre,
      estado: "pendiente",
      createdAt: new Date()
    });

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        items: [
          {
            title: "Acceso Examen Laboral",
            quantity: 1,
            unit_price: 5000
          }
        ],
        back_urls: {
          success: `${BASE_URL}/gracias.html`,
          failure: `${BASE_URL}/error.html`,
          pending: `${BASE_URL}/pendiente.html`
        },
        auto_return: "approved",
        external_reference: referenceId,
        notification_url: `${BASE_URL}/webhook`
      })
    });

    const data = await response.json();

    res.json({ init_point: data.init_point });

  } catch (error) {
    console.error("Error crear-preferencia:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// =============================
// 🔔 WEBHOOK MERCADOPAGO
// =============================
app.post("/webhook", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;

    if (!paymentId) return res.sendStatus(200);

    // Consultar pago real
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const payment = await response.json();

    const referenceId = payment.external_reference;

    if (!referenceId) return res.sendStatus(200);

    if (payment.status === "approved") {
      await db.collection("pagos").doc(referenceId).update({
        estado: "pagado",
        paidAt: new Date()
      });

      console.log("✅ Pago aprobado:", referenceId);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("Error webhook:", error);
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