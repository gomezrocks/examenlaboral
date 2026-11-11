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
  // Fuente única de acreditación para webhook y regreso del comprador.
  async function creditAuthorizedPayment(invoice, expectedUid = null) {
    if (!invoice?.id || !invoice?.preapproval_id ||
        invoice.payment?.status !== 'approved' || invoice.payment?.status_detail !== 'accredited' ||
        Number(invoice.transaction_amount) !== MONTHLY_AMOUNT || invoice.currency_id !== 'CLP') return false;
    const sub = await mp(`/preapproval/${encodeURIComponent(invoice.preapproval_id)}`);
    // Una factura aprobada antes de cancelar también debe acreditarse aunque
    // la notificación llegue después de que la suscripción pase a "cancelled".
    if (sub.id !== invoice.preapproval_id || !['authorized', 'cancelled', 'canceled'].includes(sub.status) ||
        !sub.external_reference) return false;
    const subscriptionRef = db.collection('examenes_libres_subscriptions').doc(String(sub.external_reference));
    const saved = await subscriptionRef.get();
    if (!saved.exists || saved.data().subscriptionId !== sub.id ||
        (expectedUid && saved.data().uid !== expectedUid)) return false;
    const record = saved.data();
    if (record.product !== 'examenesLibres1Basico') return false;
    const paidRef = db.collection('examenes_libres_paid_invoices').doc(String(invoice.id));
    await db.runTransaction(async tx => {
      const prior = await tx.get(paidRef);
      if (prior.exists) return;
      const userRef = db.collection('users').doc(record.uid);
      const user = await tx.get(userRef);
      const product = user.data()?.products?.[record.product];
      // Un acceso de pago único no puede convertirse en acceso temporal.
      if (product?.premium === true && product?.premiumUntil === null) {
        tx.create(paidRef, { uid: record.uid, product: record.product,
          subscriptionId: sub.id, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        return;
      }
      const existing = product?.premiumUntil;
      const existingMs = existing?.toMillis?.() || (existing ? new Date(existing).getTime() : 0);
      const until = new Date(Math.max(Date.now(), existingMs || 0));
      until.setUTCMonth(until.getUTCMonth() + 1);
      tx.set(userRef, { products: { [record.product]: {
        premium: true, premiumUntil: admin.firestore.Timestamp.fromDate(until),
        premiumSince: admin.firestore.FieldValue.serverTimestamp(), subscriptionId: sub.id
      } } }, { merge: true });
      tx.create(paidRef, { uid: record.uid, product: record.product,
        subscriptionId: sub.id, paidAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return true;
  }

  // El navegador solo aporta el ID: el servidor verifica usuario, suscripción y factura en MP.
  app.post('/confirmar-suscripcion-examenes-libres', async (req, res) => {
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.sendStatus(401);
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const id = String(req.body?.preapproval_id || '');
      if (!/^[a-zA-Z0-9-]{12,100}$/.test(id)) return res.status(400).json({ error: 'Suscripción inválida' });
      const sub = await mp(`/preapproval/${encodeURIComponent(id)}`);
      if (sub.id !== id || !sub.external_reference) {
        console.warn('MP_EXAMENES_ASOCIACION', { reason: 'mp_reference_missing' });
        return res.status(404).json({ error: 'No se encontró la referencia del pago' });
      }
      const saved = await db.collection('examenes_libres_subscriptions').doc(String(sub.external_reference)).get();
      if (!saved.exists) {
        console.warn('MP_EXAMENES_ASOCIACION', { reason: 'reference_not_in_firestore' });
        return res.status(404).json({ error: 'No encontramos la suscripción en Firebase' });
      }
      // La cuenta MP del pagador puede ser distinta del correo usado para entrar
      // a ApruebaTodo, especialmente con usuarios de prueba. El vínculo seguro
      // es la referencia aleatoria creada por Render y su UID verificado.
      if (saved.data().uid !== user.uid || saved.data().subscriptionId !== id ||
          saved.data().product !== 'examenesLibres1Basico') {
        console.warn('MP_EXAMENES_ASOCIACION', {
          reason: saved.data().uid !== user.uid ? 'firebase_uid_mismatch' :
            saved.data().subscriptionId !== id ? 'subscription_id_mismatch' : 'product_mismatch'
        });
        return res.status(403).json({ error: 'La suscripción no corresponde a esta cuenta' });
      }
      // Una firma de suscripción no equivale a un cobro: exigimos factura acreditada.
      const invoices = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(id)}`);
      let credited = false;
      for (const invoice of (invoices.results || [])) {
        if (await creditAuthorizedPayment(invoice, user.uid)) credited = true;
      }
      const userDoc = await db.collection('users').doc(user.uid).get();
      const active = userDoc.data()?.products?.examenesLibres1Basico;
      const until = active?.premiumUntil?.toMillis?.() ?? 0;
      const premium = active?.premium === true && (active?.premiumUntil === null || until > Date.now());
      console.info('MP_EXAMENES_RECONCILIACION', { credited, premium, invoiceCount: (invoices.results || []).length });
      return res.json({ premium, status: premium ? 'active' : 'pending' });
    } catch (err) {
      console.error('Confirmar suscripción Exámenes Libres', err);
      return res.status(502).json({ error: 'No se pudo verificar el pago todavía' });
    }
  });
  app.post('/crear-suscripcion-examenes-libres', async (req, res) => {
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.sendStatus(401);
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const product = getProduct(req.body?.product);
      if (!product || !user.uid) return res.status(400).json({ error: 'Datos inválidos' });
      // El comprador de Mercado Pago puede ser distinto del alumno autenticado.
      // El UID verificado del alumno y la referencia aleatoria siguen siendo
      // la única asociación que puede habilitar Premium en Firebase.
      const payerEmail = String(req.body?.payer_email || '').trim().toLowerCase();
      if (payerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
        return res.status(400).json({ error: 'Ingresa un correo válido de quien realizará el pago' });
      }
      const ref = randomUUID();
      await db.collection('examenes_libres_subscriptions').doc(ref).create({
        uid: user.uid, product: product.id, payerEmail, status: 'created',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const sub = await mp('/preapproval', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: product.reason + ' — Mensual',
          external_reference: ref, payer_email: payerEmail,
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
      secret: process.env.MP_EXAMENES_WEBHOOK_SECRET })) {
      console.warn('MP_EXAMENES_WEBHOOK', { reason: 'invalid_signature', type: req.body?.type });
      return res.sendStatus(401);
    }
    if (req.body?.type !== 'subscription_authorized_payment') return res.sendStatus(200);
    try {
      const invoice = await mp(`/authorized_payments/${encodeURIComponent(id)}`);
      const credited = await creditAuthorizedPayment(invoice);
      console.info('MP_EXAMENES_WEBHOOK', { type: req.body.type, credited });
      return res.sendStatus(200);
    } catch (err) {
      console.error('Webhook factura recurrente', err);
      return res.sendStatus(500);
    }
  };
  app.post('/webhook-examenes-libres-subscriptions', subscriptionWebhook);
  return subscriptionWebhook;
}
