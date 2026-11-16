import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  hfToken: process.env.HF_TOKEN || "",
  spaceRoot:
    process.env.SPACE_ROOT || "https://adityasingh18-demucs-api.hf.space",
  spaceModel: process.env.SPACE_MODEL || "htdemucs",
  vocalsOutputIndex: Number(process.env.VOCALS_OUTPUT_INDEX ?? 2),
  sampleRate: 44100,
  segmentSeconds: 10,
  overlapSeconds: 3,
  fadeSeconds: 1,
  maxBacklog: 48,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB || "isolate",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  publicUrl: process.env.PUBLIC_URL || "https://isolate443.duckdns.org",
  // Abuse layer: per-IP burst caps.
  rateLimitSeparate: { windowMs: 15 * 60_000, max: 30 },
  rateLimitStems: { windowMs: 15 * 60_000, max: 240 },
  rateLimitAuthPoll: { windowMs: 2 * 60_000, max: 150 },
};

export interface UsageLimits {
  dailyAudioMinutes: number;
  dailySeparations: number;
  maxVideoMinutes: number;
  concurrency: number;
}

// Defaults for signed-in users; each user doc carries its own copy that can
// be overridden per individual (db.users.updateOne({email}, {$set: {limits: ...}})).
export const defaultUserLimits: UsageLimits = {
  dailyAudioMinutes: 30,
  dailySeparations: 10,
  maxVideoMinutes: 10,
  concurrency: 1,
};

// Anonymous (no login) trial, keyed by hashed IP.
export const anonymousLimits: UsageLimits = {
  dailyAudioMinutes: 10,
  dailySeparations: 2,
  maxVideoMinutes: 10,
  concurrency: 1,
};

export const segmentFrames = config.segmentSeconds * config.sampleRate;
export const overlapFrames = config.overlapSeconds * config.sampleRate;
export const fadeFrames = config.fadeSeconds * config.sampleRate;
export const bytesPerFrame = 4;
export const segmentBytes = segmentFrames * bytesPerFrame;
export const overlapBytes = overlapFrames * bytesPerFrame;
