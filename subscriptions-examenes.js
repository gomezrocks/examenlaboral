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
    const error = new Error(`Mercado Pago HTTP ${r.status}`);
    error.httpStatus = r.status;
    throw error;
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
    // Solo reflejar estado autorizado si MP sigue autorizado; nunca reactivar
    // en la administración una suscripción que ya fue cancelada.
    if (sub.status === 'authorized') {
      await subscriptionRef.set({ status: 'authorized', lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
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
  // Evitar suscripciones duplicadas incluso si el comprador abre el checkout
  // en otra pestaña o usa otro correo de Mercado Pago. La comprobación real
  // se hace con el token del VENDEDOR, no con el email del comprador.
  async function existingSubscriptions(uid, productId) {
    const list = await db.collection('examenes_libres_subscriptions')
      .where('uid', '==', uid).limit(100).get();
    if (list.size >= 100) throw new Error('Demasiados registros para verificar con seguridad');
    let checkout = null;
    for (const doc of list.docs) {
      const record = doc.data();
      if (record.product !== productId || !record.subscriptionId) continue;
      // Si falla la consulta no crear otra suscripción a ciegas.
      let mpSub;
      try { mpSub = await mp(`/preapproval/${encodeURIComponent(record.subscriptionId)}`); }
      catch (error) {
        // Las suscripciones creadas con token de prueba no existen para el
        // token productivo. No sirven para bloquear una compra de producción.
        if (error.httpStatus === 404) continue;
        throw error;
      }
      if (mpSub.id !== record.subscriptionId || mpSub.external_reference !== doc.id) {
        throw new Error('La referencia de la suscripción no coincide con Mercado Pago');
      }
      if (record.status !== mpSub.status) {
        await doc.ref.set({ status: mpSub.status, lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      if (mpSub.status === 'authorized') return { active: true, checkout: null };
      if (mpSub.status === 'pending' && record.initPoint && !checkout) {
        checkout = { init_point: record.initPoint, payerEmail: record.payerEmail };
      }
    }
    return { active: false, checkout };
  }

  app.post('/crear-suscripcion-examenes-libres', async (req, res) => {
    let checkoutLockRef;
    let lockOwner;
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.sendStatus(401);
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const product = getProduct(req.body?.product);
      if (!product || !user.uid) return res.status(400).json({ error: 'Datos inválidos' });
      const payerEmail = String(req.body?.payer_email || '').trim().toLowerCase();
      if (payerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
        return res.status(400).json({ error: 'Ingresa un correo válido de quien realizará el pago' });
      }

      // Bloqueo temporal por UID: dos pestañas no pueden iniciar dos compras.
      // Expira solo para permitir recuperación si el servidor se interrumpe.
      checkoutLockRef = db.collection('examenes_libres_checkout_locks').doc(user.uid);
      lockOwner = randomUUID();
      const acquired = await db.runTransaction(async tx => {
        const snap = await tx.get(checkoutLockRef);
        if (snap.exists && Number(snap.data().expiresAtMs || 0) > Date.now()) return false;
        tx.set(checkoutLockRef, { owner: lockOwner, expiresAtMs: Date.now() + 120000 });
        return true;
      });
      if (!acquired) return res.status(409).json({ code: 'CHECKOUT_IN_PROGRESS', error: 'Ya estás iniciando una compra. Espera y vuelve a revisar antes de intentar otra vez.' });

      const existing = await existingSubscriptions(user.uid, product.id);
      if (existing.active) {
        return res.status(409).json({ code: 'SUBSCRIPTION_ALREADY_ACTIVE', error: 'Ya tienes una suscripción mensual activa. No necesitas pagar otra vez. Revisa tu acceso Premium.' });
      }
      // No reutilizar checkout con otro correo; el pagador debe coincidir.
      if (existing.checkout && existing.checkout.payerEmail === payerEmail) {
        return res.json({ product: product.id, init_point: existing.checkout.init_point, reused: true });
      }

      const userDoc = await db.collection('users').doc(user.uid).get();
      const membership = userDoc.data()?.products?.[product.id];
      const until = membership?.premiumUntil;
      const untilMs = until?.toMillis?.() || (until ? new Date(until).getTime() : 0);
      if (membership?.premium === true && (until === null || untilMs > Date.now())) {
        return res.status(409).json({ code: 'PREMIUM_ALREADY_ACTIVE', error: 'Tu cuenta ya tiene Premium vigente. No se creará otra suscripción.' });
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
        subscriptionId: sub.id, initPoint: sub.init_point, status: sub.status || 'pending'
      }, { merge: true });
      return res.json({ product: product.id, init_point: sub.init_point });
    } catch (err) {
      console.error('Crear suscripción', err);
      return res.status(502).json({ error: 'No fue posible verificar o iniciar la suscripción. No intentes pagar de nuevo hasta revisar tu estado Premium.' });
    } finally {
      if (checkoutLockRef && lockOwner) {
        try {
          await db.runTransaction(async tx => {
            const snap = await tx.get(checkoutLockRef);
            if (snap.exists && snap.data().owner === lockOwner) tx.delete(checkoutLockRef);
          });
        } catch (error) { console.warn('Liberar bloqueo de checkout', error.message); }
      }
    }
  });

  // Nunca se acredita Premium por un cambio de estado de suscripción.
  // Tanto un aviso de factura como uno de preapproval deben llevarnos a
  // consultar la fuente de verdad en Mercado Pago.
  async function reconcileByPreapprovalId(preapprovalId) {
    const subscriptionId = String(preapprovalId || '');
    if (!/^[a-zA-Z0-9-]{12,100}$/.test(subscriptionId)) return { checked: 0, credited: 0 };
    const subscription = await mp(`/preapproval/${encodeURIComponent(subscriptionId)}`);
    const ref = String(subscription?.external_reference || '');
    if (!ref || !subscription?.id || String(subscription.id) !== subscriptionId) {
      return { checked: 0, credited: 0 };
    }
    const saved = await db.collection('examenes_libres_subscriptions').doc(ref).get();
    if (!saved.exists || saved.data()?.subscriptionId !== subscriptionId ||
        saved.data()?.product !== 'examenesLibres1Basico') {
      return { checked: 0, credited: 0 };
    }
    // La colección contiene el UID real del estudiante. El correo del pagador
    // no puede alterar a quién se entrega el Premium.
    const invoices = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(subscriptionId)}`);
    const results = Array.isArray(invoices.results) ? invoices.results : [];
    // Nunca afirmar que revisamos todas las facturas si Mercado Pago pagina.
    // El procesamiento normal de cada factura sigue en el evento individual.
    let credited = 0;
    for (const invoice of results) {
      if (await creditAuthorizedPayment(invoice, saved.data().uid)) credited++;
    }
    console.info('MP_EXAMENES_WEBHOOK_CONCILIACION', {
      source: 'preapproval', checked: results.length, processed: credited,
      hasMore: Number(invoices.paging?.total || 0) > results.length
    });
    return { checked: results.length, credited };
  }

  const subscriptionWebhook = async (req, res) => {
    const type = String(req.body?.type || '');
    const id = req.query['data.id'] || req.body?.data?.id;
    if (!validWebhookSignature({ signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'], dataId: id,
      secret: process.env.MP_EXAMENES_WEBHOOK_SECRET })) {
      console.warn('MP_EXAMENES_WEBHOOK', { reason: 'invalid_signature', type });
      return res.sendStatus(401);
    }
    try {
      if (type === 'subscription_authorized_payment') {
        // El ID recibido identifica una FACTURA, no una suscripción.
        const invoice = await mp(`/authorized_payments/${encodeURIComponent(String(id))}`);
        const credited = await creditAuthorizedPayment(invoice);
        console.info('MP_EXAMENES_WEBHOOK_FACTURA', { checked: true, processed: credited });
        return res.sendStatus(200);
      }
      if (type === 'subscription_preapproval') {
        // El ID recibido identifica la SUSCRIPCIÓN. Su estado autorizado
        // NO equivale a una mensualidad pagada.
        await reconcileByPreapprovalId(id);
        return res.sendStatus(200);
      }
      return res.sendStatus(200);
    } catch (err) {
      console.error('MP_EXAMENES_WEBHOOK_ERROR', {
        type, httpStatus: err?.httpStatus || null,
        message: String(err?.message || 'Error de conciliación').slice(0, 180)
      });
      return res.sendStatus(500);
    }
  };
  app.post('/webhook-examenes-libres-subscriptions', subscriptionWebhook);
  return subscriptionWebhook;
}
