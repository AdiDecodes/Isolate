import { randomBytes, createHash } from "node:crypto";
import { MongoClient, type Db, type Collection } from "mongodb";
import { config, defaultUserLimits, type UsageLimits } from "./config.js";

export interface UserDoc {
  _id: import("mongodb").ObjectId;
  googleSub: string;
  email: string;
  name: string;
  picture?: string;
  createdAt: Date;
  enabled: boolean;
  limits: UsageLimits;
}

export interface TokenDoc {
  tokenHash: string;
  userId: import("mongodb").ObjectId;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface AuthCodeDoc {
  code: string;
  token: string;
  email: string;
  expiresAt: Date;
}

export interface UsageDoc {
  _id: string; // "u:<userId>" or "ip:<hash>"
  day: string; // YYYY-MM-DD (server-local)
  audioSeconds: number;
  separations: number;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  // Standalone mongod (single host, no replicaSet param) wants a direct
  // connection — the driver's discovery flow can stall without it.
  const useDirect =
    !config.mongoUri.startsWith("mongodb+srv") &&
    !/replicaSet=/i.test(config.mongoUri) &&
    !/directConnection=/i.test(config.mongoUri);
  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    ...(useDirect ? { directConnection: true } : {}),
  });
  await client.connect();
  db = client.db(config.mongoDb);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("users").createIndex({ googleSub: 1 }, { unique: true }),
    db.collection("tokens").createIndex({ tokenHash: 1 }, { unique: true }),
    db
      .collection("authCodes")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

export function collections(d: Db) {
  return {
    users: d.collection<UserDoc>("users"),
    tokens: d.collection<TokenDoc>("tokens"),
    authCodes: d.collection<AuthCodeDoc>("authCodes"),
    usage: d.collection<UsageDoc>("usage"),
  };
}

export async function upsertGoogleUser(profile: {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}): Promise<UserDoc> {
  const d = await getDb();
  const { users } = collections(d);
  const now = new Date();
  const res = await users.findOneAndUpdate(
    { googleSub: profile.sub },
    {
      $set: {
        email: profile.email,
        name: profile.name,
        picture: profile.picture || "",
      },
      $setOnInsert: {
        googleSub: profile.sub,
        createdAt: now,
        enabled: true,
        limits: { ...defaultUserLimits },
      },
    },
    { returnDocument: "after", upsert: true }
  );
  if (!res) throw new Error("failed to upsert user");
  return res;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
