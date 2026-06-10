import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectIds = {};

function parseServiceAccount(envName) {
  const raw = process.env[envName];
  if (!raw) return null;
  return JSON.parse(raw);
}

function firebaseApp(name, envName, fallbackEnvName = null) {
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;

  const serviceAccount = parseServiceAccount(envName) || (fallbackEnvName ? parseServiceAccount(fallbackEnvName) : null);
  if (!serviceAccount) {
    throw new Error(`Falta configurar ${envName}`);
  }

  console.log(`Firebase ${name}:`, serviceAccount.project_id);
  projectIds[name] = serviceAccount.project_id;

  return initializeApp({
    credential: cert(serviceAccount)
  }, name);
}

export function dbForProduct(productId = "finesLaborales") {
  if (productId === "paes") {
    return getFirestore(firebaseApp("paes", "FIREBASE_SERVICE_ACCOUNT_PAES"));
  }

  return getFirestore(firebaseApp("finesLaborales", "FIREBASE_SERVICE_ACCOUNT_FINES", "FIREBASE_SERVICE_ACCOUNT"));
}

export function firebaseProjectForProduct(productId = "finesLaborales") {
  if (productId === "paes") {
    firebaseApp("paes", "FIREBASE_SERVICE_ACCOUNT_PAES");
    return projectIds.paes;
  }

  firebaseApp("finesLaborales", "FIREBASE_SERVICE_ACCOUNT_FINES", "FIREBASE_SERVICE_ACCOUNT");
  return projectIds.finesLaborales;
}
