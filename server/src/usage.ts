import type { Response } from "express";
import {
  anonymousLimits,
  type UsageLimits,
} from "./config.js";
import { getDb, collections, type UsageDoc } from "./db.js";
import type { Identity } from "./auth.js";

export function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nextMidnightIso(): string {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

export async function usageFor(identityKey: string): Promise<UsageDoc | null> {
  const d = await getDb();
  const doc = await collections(d).usage.findOne({ _id: identityKey });
  if (!doc || doc.day !== todayKey()) return null;
  return doc;
}

function limitsFor(identity: Identity): UsageLimits {
  return identity.user ? identity.user.limits : anonymousLimits;
}

function deny(
  res: Response,
  error: string,
  code: string
): boolean {
  res.status(429).json({ error, code, resetAt: nextMidnightIso() });
  return false;
}

// Throws-free preflight for /separate: reserves one separation + its audio
// span in the daily ledger. Returns false and writes the error response if
// the identity is over quota, disabled, or already running a job.
export async function reserveSeparation(
  identity: Identity,
  res: Response
): Promise<boolean> {
  if (identity.user && identity.user.enabled === false) {
    res.status(403).json({
      error: "This account has been disabled",
      code: "disabled",
    });
    return false;
  }

  const limits = limitsFor(identity);

  if (!concurrency.tryAcquire(identity.key, limits.concurrency)) {
    return deny(
      res,
      "A separation is already running — wait for it to finish",
      "busy"
    );
  }

  // Every deny path below must give the concurrency slot back.
  const denyAndRelease = (error: string, code: string) => {
    concurrency.release(identity.key);
    return deny(res, error, code);
  };

  try {
    const d = await getDb();
    const { usage } = collections(d);
    const day = todayKey();

    // Create today's ledger entry, or reset the counters if it's stale.
    // Same-identity requests are serialized by the concurrency gate, so a
    // read-then-write here cannot race.
    const existing = await usage.findOne({ _id: identity.key });
    if (!existing || existing.day !== day) {
      await usage.updateOne(
        { _id: identity.key },
        { $set: { day, audioSeconds: 0, separations: 0 } },
        { upsert: true }
      );
    }

    const current = await usage.findOne({ _id: identity.key, day });
    const usedSeparations = current?.separations || 0;

    if (usedSeparations + 1 > limits.dailySeparations) {
      return denyAndRelease(
        `Daily limit reached (${limits.dailySeparations} separations/day) — resets at midnight`,
        "daily_limit"
      );
    }

    const result = await usage.updateOne(
      {
        _id: identity.key,
        day,
        separations: { $lt: limits.dailySeparations },
        audioSeconds: { $lte: limits.dailyAudioMinutes * 60 },
      },
      { $inc: { separations: 1 } }
    );
    if (result.modifiedCount === 0) {
      return denyAndRelease(
        `Daily limit reached (${limits.dailyAudioMinutes} audio-min/day) — resets at midnight`,
        "daily_limit"
      );
    }
    return true;
  } catch (e) {
    concurrency.release(identity.key);
    throw e;
  }
}

// Reserve the audio-minutes for a resolved video (call after we know the
// duration). Releases the concurrency slot on failure.
export async function reserveAudioSeconds(
  identity: Identity,
  durationSeconds: number,
  res: Response
): Promise<boolean> {
  const limits = limitsFor(identity);
  const release = () => concurrency.release(identity.key);

  if (durationSeconds > limits.maxVideoMinutes * 60) {
    release();
    res.status(403).json({
      error: `Video is longer than the ${limits.maxVideoMinutes}-minute limit`,
      code: "video_too_long",
    });
    return false;
  }

  const d = await getDb();
  const { usage } = collections(d);
  const day = todayKey();
  const cap = limits.dailyAudioMinutes * 60;
  const result = await usage.updateOne(
    {
      _id: identity.key,
      day,
      audioSeconds: { $lte: cap - Math.ceil(durationSeconds) },
    },
    { $inc: { audioSeconds: Math.ceil(durationSeconds) } }
  );
  if (result.modifiedCount === 0) {
    release();
    // Refund the separation slot consumed by reserveSeparation.
    await usage.updateOne(
      { _id: identity.key, day },
      { $inc: { separations: -1 } }
    );
    return deny(
      res,
      `Daily limit reached (${limits.dailyAudioMinutes} audio-min/day) — resets at midnight`,
      "daily_limit"
    );
  }
  return true;
}

export function releaseSeparation(identity: Identity): void {
  concurrency.release(identity.key);
}

// In-memory concurrency limiter (single server process). A crashed job's slot
// is recovered because every reserve path releases in its error/close path.
export const concurrency = {
  active: new Map<string, number>(),

  tryAcquire(key: string, max: number): boolean {
    const n = this.active.get(key) || 0;
    if (n >= max) return false;
    this.active.set(key, n + 1);
    return true;
  },

  release(key: string): void {
    const n = (this.active.get(key) || 0) - 1;
    if (n <= 0) this.active.delete(key);
    else this.active.set(key, n);
  },
};
