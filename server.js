import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// 🔥 Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const MP_WEBHOOK_SECRET = "c809285050410d37188b5cc005a726deada3715cce53638b1db2d6c01bba42ee";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 🔑 TU TOKEN REAL
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// =============================
// 🟢 CREAR SUSCRIPCIÓN
// =============================
app.post("/crear-suscripcion", async (req, res) => {

  try {

    const { user_id, email } = req.body;

    if(!user_id){
      return res.status(400).json({ error: "Falta user_id" });
    }

    const response = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        reason: "Suscripción PRO WebHoy",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 5000,
          currency_id: "CLP"
        },
        back_url: "https://TU-DOMINIO/activar.html",
        payer_email: email || "test@test.com",
        metadata: {
          user_id: user_id   // 🔥 CLAVE
        }
      })
    });

    const data = await response.json();

    if(!data.init_point){
      console.log(data);
      return res.status(500).json({ error: "Error creando pago" });
    }

    res.json({ url: data.init_point });

  } catch(err){
    console.error(err);
    res.status(500).json({ error: "Error servidor" });
  }

});


// =============================
// 🔔 WEBHOOK
// =============================
app.post("/webhook", async (req, res) => {

  try {

     // 🔐 VALIDACIÓN
    if(!verificarFirma(req)){
      console.log("❌ Firma inválida");
      return res.sendStatus(401);
    }

    const paymentId = req.body.data?.id;

    if(!paymentId){
      return res.sendStatus(200);
    }

    const mpRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await mpRes.json();

    console.log("Estado:", payment.status);

    if(payment.status === "approved"){

      const userId = payment.metadata?.user_id;

      if(!userId){
        console.log("Sin user_id");
        return res.sendStatus(200);
      }

      await db.collection("users").doc(userId).update({
        premium: true,
        premiumSince: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log("Usuario PREMIUM:", userId);
    }

    res.sendStatus(200);

  } catch(err){
    console.error(err);
    res.sendStatus(500);
  }

});


app.listen(3000, () => {
  console.log("🔥 Server listo en http://localhost:3000");
});


function verificarFirma(req) {

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];

  if(!signature || !requestId){
    return false;
  }

  const dataID = req.body?.data?.id;

  const manifest = `id:${dataID};request-id:${requestId};`;

  const hmac = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  return signature.includes(hmac);
}


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});