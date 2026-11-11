// Administración privada de ApruebaTodo. Solo UID explícitamente autorizado.
import { dbForProduct, authForProduct, firebaseProjectForProduct } from './firebase.js';

const API = 'https://api.mercadopago.com';
const PRODUCTS = [
  { id: 'examenesLibres1Basico', label: 'Exámenes Libres 1° Básico', source: 'examenesLibres1Basico', collection: 'users' },
  { id: 'finesLaborales', label: 'Fines Laborales Media', source: 'finesLaborales', collection: 'users' },
  { id: 'paes', label: 'Simulador PAES', source: 'paes', collection: 'paesUsers' }
];

const iso = value => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const bearerToken = request => /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];

// Lectura paginada: los 200 primeros usuarios daban cifras falsas y dejaban
// fuera precisamente las cuentas de prueba recién creadas.
async function readCollection(db, name, max = 10000) {
  const docs = [];
  let cursor = null;
  while (docs.length < max) {
    const pageSize = Math.min(500, max - docs.length);
    let query = db.collection(name).orderBy('__name__').limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    docs.push(...snapshot.docs);
    if (snapshot.empty || snapshot.size < pageSize) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  return { docs, truncated: docs.length === max };
}

async function attachAuthEmails(rows, product) {
  const auth = authForProduct(product.source);
  const missing = rows.filter(row => !row.email);
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100);
    try {
      const found = await auth.getUsers(batch.map(row => ({ uid: row.uid })));
      const emails = new Map(found.users.map(user => [user.uid, user.email || null]));
      for (const row of batch) row.email = emails.get(row.uid) || null;
    } catch (error) {
      console.warn('Admin ApruebaTodo: no se pudieron completar algunos correos', product.id, error.message);
    }
  }
}

async function requireAdmin(req, res, next) {
  try {
    const allowed = (process.env.APRUEBATODO_ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.length) return res.status(503).json({ error: 'Falta configurar APRUEBATODO_ADMIN_UIDS en Render' });
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Inicia sesión' });
    const user = await authForProduct('examenesLibres1Basico').verifyIdToken(token, true);
    if (!allowed.includes(user.uid)) return res.status(403).json({ error: 'Acceso restringido al administrador' });
    req.adminUid = user.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o vencida' });
  }
}

function normalizeUser(doc, product) {
  const data = doc.data() || {};
  const detail = data.products?.[product.id] || {};
  const until = iso(detail.premiumUntil || data.premiumUntil);
  const premium = detail.premium ?? data.premium ?? false;
  return {
    uid: doc.id,
    email: data.email || data.correo || null,
    product: product.id,
    productLabel: product.label,
    premium: Boolean(premium) && (!until || Date.parse(until) > Date.now()),
    premiumUntil: until,
    premiumSince: iso(detail.premiumSince || data.premiumSince),
    subscriptionId: detail.subscriptionId || data.subscriptionId || null,
    plan: detail.planLabel || detail.plan || data.planLabel || data.plan || null
  };
}

export function registerApruebaTodoAdmin(app) {
  app.get('/admin-apruebatodo/summary', requireAdmin, async (_req, res) => {
    const products = [];
    for (const product of PRODUCTS) {
      try {
        if (product.id === 'finesLaborales' &&
            firebaseProjectForProduct(product.source) === firebaseProjectForProduct('examenesLibres1Basico')) {
          products.push({ id: product.id, label: product.label,
            error: 'Fines Laborales está usando el Firebase de Exámenes Libres. Configura FIREBASE_SERVICE_ACCOUNT_FINES para mostrar cifras reales.' });
          continue;
        }
        const db = dbForProduct(product.source);
        const users = await readCollection(db, product.collection);
        const normalized = users.docs.map(doc => normalizeUser(doc, product));
        await attachAuthEmails(normalized, product);
        const row = {
          id: product.id, label: product.label, users: normalized,
          sampled: normalized.length, truncated: users.truncated,
          premiumInSample: normalized.filter(u => u.premium).length
        };
        if (product.id === 'examenesLibres1Basico') {
          const [subscriptions, orders, invoices] = await Promise.all([
            readCollection(db, 'examenes_libres_subscriptions'),
            readCollection(db, 'examenes_libres_orders'),
            readCollection(db, 'examenes_libres_paid_invoices')
          ]);
          const byUid = new Map(normalized.map(u => [u.uid, u]));
          const invoiceCounts = new Map();
          for (const doc of invoices.docs) {
            const subId = doc.data().subscriptionId;
            invoiceCounts.set(subId, (invoiceCounts.get(subId) || 0) + 1);
          }
          row.subscriptions = subscriptions.docs.map(doc => {
            const s = doc.data();
            return {
              reference: doc.id, uid: s.uid, email: byUid.get(s.uid)?.email || null,
              status: s.status || 'unknown', subscriptionId: s.subscriptionId || null,
              paidInvoicesInSample: invoiceCounts.get(s.subscriptionId) || 0,
              paymentState: invoiceCounts.get(s.subscriptionId) ? 'Con pago acreditado' : 'Sin factura acreditada',
              createdAt: iso(s.createdAt),
              premiumUntil: byUid.get(s.uid)?.premiumUntil || null
            };
          });
          row.orders = orders.docs.map(doc => {
            const o = doc.data();
            return { reference: doc.id, email: byUid.get(o.uid)?.email || null,
              status: o.status || 'unknown', amount: o.amount || null, createdAt: iso(o.createdAt) };
          });
          row.subscriptionsTruncated = subscriptions.truncated;
          row.ordersTruncated = orders.truncated;
          row.invoicesTruncated = invoices.truncated;
        }
        products.push(row);
      } catch (error) {
        console.error('Admin ApruebaTodo resumen', product.id, error.message);
        products.push({ id: product.id, label: product.label,
          error: 'No se pudo consultar este proyecto Firebase. Revisa sus credenciales en Render.' });
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ generatedAt: new Date().toISOString(), products });
  });

  app.post('/admin-apruebatodo/cancel-subscription', requireAdmin, async (req, res) => {
    try {
      const reference = String(req.body?.reference || '');
      if (!/^[\da-f-]{36}$/i.test(reference)) return res.status(400).json({ error: 'Referencia inválida' });
      const db = dbForProduct('examenesLibres1Basico');
      const ref = db.collection('examenes_libres_subscriptions').doc(reference);
      const snapshot = await ref.get();
      if (!snapshot.exists || !snapshot.data().subscriptionId) return res.sendStatus(404);
      const record = snapshot.data();
      if (record.product !== 'examenesLibres1Basico') return res.sendStatus(409);
      const token = process.env.MP_EXAMENES_ACCESS_TOKEN;
      if (!token) return res.status(503).json({ error: 'Falta token de Mercado Pago' });
      const id = encodeURIComponent(record.subscriptionId);
      // Revisar la suscripción directamente en MP antes de cancelarla.
      const check = await fetch(`${API}/preapproval/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!check.ok) throw new Error(`Consulta MP ${check.status}`);
      const sub = await check.json();
      if (sub.id !== record.subscriptionId || sub.external_reference !== reference) return res.sendStatus(409);
      if (sub.status !== 'canceled') {
        const cancel = await fetch(`${API}/preapproval/${id}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'canceled' })
        });
        if (!cancel.ok) throw new Error(`Cancelación MP ${cancel.status}`);
      }
      // NO borrar premium ni premiumUntil: el alumno conserva lo ya pagado.
      await ref.set({ status: 'canceled', canceledAt: new Date(), canceledBy: req.adminUid }, { merge: true });
      await db.collection('examenes_libres_admin_audit').add({ action: 'cancel_subscription',
        reference, subscriptionId: record.subscriptionId, adminUid: req.adminUid, at: new Date() });
      return res.json({ ok: true, status: 'canceled', paidAccessPreserved: true });
    } catch (error) {
      console.error('Admin ApruebaTodo cancelar', error.message);
      return res.status(502).json({ error: 'Mercado Pago no confirmó la cancelación. Revisa los logs.' });
    }
  });
}
