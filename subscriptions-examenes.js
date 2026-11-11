import { randomUUID } from 'node:crypto';
import { getProduct } from './productos-examenes.js';
import { validWebhookSignature } from './orders-examenes.js';

const API = 'https://api.mercadopago.com';
const MONTHLY_AMOUNT = 4990;
async function mp(path, options = {}) {
  if (!process.env.MP_EXAMENES_ACCESS_TOKEN) throw new Error('Falta token de Mercado Pago');
  const r = await fetch(API + path, { ...options, headers: {
    Authorization: `Bearer ${process.env.MP_EXAMENES_ACCESS_TOKEN}`, ...(options.headers || {})
  } });
  const data = await r.json();
  if (!r.ok) {
    // Registrar solo datos diagnósticos; nunca tokens ni el cuerpo completo.
    const detail = {
      status: r.status,
      error: String(data?.error ?? '').slice(0, 160),
      message: String(data?.message ?? '').slice(0, 300),
      cause: Array.isArray(data?.cause)
        ? data.cause.slice(0, 4).map(c => ({ code: c.code, description: String(c.description ?? '').slice(0, 200) }))
        : undefined
    };
    console.error('MP_EXAMENES_SUSCRIPCION_RECHAZADA', detail);
    throw new Error(`Mercado Pago HTTP ${r.status}`);
  }
  return data;
}

export function registerExamenesLibresSubscriptions(app, admin) {
  const db = admin.firestore();
  app.post('/crear-suscripcion-examenes-libres', async (req, res) => {
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.sendStatus(401);
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const product = getProduct(req.body?.product);
      if (!product || !user.email) return res.status(400).json({ error: 'Datos inválidos' });
      const ref = randomUUID();
      await db.collection('examenes_libres_subscriptions').doc(ref).create({
        uid: user.uid, product: product.id, status: 'created',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const sub = await mp('/preapproval', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: product.reason + ' — Mensual',
          external_reference: ref, payer_email: user.email,
          back_url: product.backUrl,
          auto_recurring: { frequency: 1, frequency_type: 'months',
            transaction_amount: MONTHLY_AMOUNT, currency_id: 'CLP' } }) });
      if (!sub.id || !sub.init_point) throw new Error('Suscripción inválida');
      await db.collection('examenes_libres_subscriptions').doc(ref).set({
        subscriptionId: sub.id, status: sub.status || 'pending'
      }, { merge: true });
      return res.json({ product: product.id, init_point: sub.init_point });
    } catch (err) {
      console.error('Crear suscripción', err);
      return res.status(502).json({ error: 'No se pudo crear la suscripción' });
    }
  });

  // Se activa ÚNICAMENTE por factura recurrente cobrada, no por la autorización.
  const subscriptionWebhook = async (req, res) => {
    const id = req.query['data.id'] || req.body?.data?.id;
    if (!validWebhookSignature({ signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'], dataId: id,
      secret: process.env.MP_EXAMENES_WEBHOOK_SECRET })) return res.sendStatus(401);
    if (req.body?.type !== 'subscription_authorized_payment') return res.sendStatus(200);
    try {
      const invoice = await mp(`/authorized_payments/${encodeURIComponent(id)}`);
      if (invoice.payment?.status !== 'approved' || invoice.payment?.status_detail !== 'accredited') return res.sendStatus(200);
      if (Number(invoice.transaction_amount) !== MONTHLY_AMOUNT || invoice.currency_id !== 'CLP') return res.sendStatus(409);
      const sub = await mp(`/preapproval/${encodeURIComponent(invoice.preapproval_id)}`);
      const ref = db.collection('examenes_libres_subscriptions').doc(String(sub.external_reference));
      const saved = await ref.get();
      if (!saved.exists || saved.data().subscriptionId !== sub.id ||
          sub.status !== 'authorized') return res.sendStatus(200);
      const record = saved.data();
      const paidRef = db.collection('examenes_libres_paid_invoices').doc(String(id));
      await db.runTransaction(async tx => {
        const prior = await tx.get(paidRef);
        if (prior.exists) return;
        const userRef = db.collection('users').doc(record.uid);
        const user = await tx.get(userRef);
        const existing = user.data()?.products?.[record.product]?.premiumUntil;
        const existingMs = existing?.toMillis?.() || (existing ? new Date(existing).getTime() : 0);
        const base = Math.max(Date.now(), existingMs || 0);
        const until = new Date(base);
        until.setUTCMonth(until.getUTCMonth() + 1);
        tx.set(userRef, { products: { [record.product]: {
          premium: true, premiumUntil: admin.firestore.Timestamp.fromDate(until),
          premiumSince: admin.firestore.FieldValue.serverTimestamp(), subscriptionId: sub.id
        } } }, { merge: true });
        tx.create(paidRef, { uid: record.uid, product: record.product,
          subscriptionId: sub.id, paidAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.sendStatus(200);
    } catch (err) {
      console.error('Webhook factura recurrente', err);
      return res.sendStatus(500);
    }
  };
  app.post('/webhook-examenes-libres-subscriptions', subscriptionWebhook);
  return subscriptionWebhook;
}
