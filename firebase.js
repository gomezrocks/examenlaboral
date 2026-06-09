import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function parseServiceAccount(envName) {
  const raw = process.env[envName];
  if (!raw) return null;
  return JSON.parse(raw);
}

function firebaseApp(name, envName, fallbackEnvName = "FIREBASE_SERVICE_ACCOUNT") {
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;

  const serviceAccount = parseServiceAccount(envName) || parseServiceAccount(fallbackEnvName);
  if (!serviceAccount) {
    throw new Error(`Falta configurar ${envName}`);
  }

  return initializeApp({
    credential: cert(serviceAccount)
  }, name);
}

export function dbForProduct(productId = "finesLaborales") {
  if (productId === "paes") {
    return getFirestore(firebaseApp("paes", "FIREBASE_SERVICE_ACCOUNT_PAES"));
  }

  return getFirestore(firebaseApp("finesLaborales", "FIREBASE_SERVICE_ACCOUNT_FINES"));
}
