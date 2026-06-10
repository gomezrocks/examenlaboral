import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectIds = {};

function parseServiceAccount(envNames) {
  const names = Array.isArray(envNames) ? envNames : [envNames];
  for (const envName of names) {
    const raw = process.env[envName];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) {
      throw new Error(`${envName} debe ser el JSON completo de la clave privada. Parece que pegaste codigo JavaScript SDK Admin en vez del archivo .json.`);
    }
    const parsed = JSON.parse(trimmed);
    return {
      envName,
      serviceAccount: {
        ...parsed,
        private_key: parsed.private_key?.replace(/\\n/g, "\n")
      }
    };
  }
  return null;
}

function firebaseApp(name, envName, fallbackEnvName = null) {
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;

  const primaryNames = Array.isArray(envName) ? envName : [envName];
  const fallbackNames = fallbackEnvName ? (Array.isArray(fallbackEnvName) ? fallbackEnvName : [fallbackEnvName]) : [];
  const parsed = parseServiceAccount(primaryNames) || parseServiceAccount(fallbackNames);
  if (!parsed) {
    throw new Error(`Falta configurar una de estas variables: ${[...primaryNames, ...fallbackNames].join(", ")}`);
  }
  const { envName: sourceEnvName, serviceAccount } = parsed;

  console.log(`Firebase ${name}:`, serviceAccount.project_id, `(${sourceEnvName})`);
  projectIds[name] = serviceAccount.project_id;

  return initializeApp({
    credential: cert(serviceAccount)
  }, name);
}

export function dbForProduct(productId = "finesLaborales") {
  if (productId === "paes") {
    return getFirestore(firebaseApp("paes", ["FIREBASE_SERVICE_ACCOUNT_PAES", "PAES_FIREBASE_SERVICE_ACCOUNT"]));
  }

  return getFirestore(firebaseApp("finesLaborales", ["FIREBASE_SERVICE_ACCOUNT_FINES", "FINES_FIREBASE_SERVICE_ACCOUNT"], "FIREBASE_SERVICE_ACCOUNT"));
}

export function firebaseProjectForProduct(productId = "finesLaborales") {
  if (productId === "paes") {
    firebaseApp("paes", ["FIREBASE_SERVICE_ACCOUNT_PAES", "PAES_FIREBASE_SERVICE_ACCOUNT"]);
    return projectIds.paes;
  }

  firebaseApp("finesLaborales", ["FIREBASE_SERVICE_ACCOUNT_FINES", "FINES_FIREBASE_SERVICE_ACCOUNT"], "FIREBASE_SERVICE_ACCOUNT");
  return projectIds.finesLaborales;
}
