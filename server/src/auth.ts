import type { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "./config.js";
import { getDb, collections, sha256, newToken, upsertGoogleUser, type UserDoc } from "./db.js";

// Resolved request identity: a signed-in user or a hashed-IP anonymous trial.
export interface Identity {
  key: string; // usage ledger key: "u:<id>" or "ip:<hash>"
  user: UserDoc | null;
  anonId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      identity?: Identity;
    }
  }
}

export async function userByToken(token: string): Promise<UserDoc | null> {
  const d = await getDb();
  const { tokens, users } = collections(d);
  const tokenHash = sha256(token);
  const doc = await tokens.findOneAndUpdate(
    { tokenHash },
    { $set: { lastUsedAt: new Date() } }
  );
  if (!doc) return null;
  // Disabled users still resolve so they get an explicit 403 rather than
  // silently falling back to the anonymous trial.
  return (await users.findOne({ _id: doc.userId })) || null;
}

// Optional auth: attaches identity (user if valid Bearer token, else anon IP).
export const attachIdentity: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const user = await userByToken(token);
      if (user) {
        res.locals.identity = {
          key: "u:" + user._id.toHexString(),
          user,
          anonId: null,
        };
        next();
        return;
      }
    }
    const ip = req.ip || "unknown";
    const anonId = sha256("ip:" + ip).slice(0, 32);
    res.locals.identity = { key: "ip:" + anonId, user: null, anonId };
    next();
  } catch (e) {
    next(e);
  }
};

// Requires a valid Bearer token belonging to an enabled user.
export const requireUser: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const identity = res.locals.identity as Identity | undefined;
  if (!identity || !identity.user) {
    res.status(401).json({ error: "Sign in to continue", code: "auth_required" });
    return;
  }
  next();
};

function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.publicUrl + "/auth/google/callback",
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Isolate</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f0f0f;color:#f1f1f1;font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif}
  .card{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:14px;padding:28px 30px;
    max-width:380px;text-align:center}
  h1{font-size:17px;margin:0 0 10px}
  p{color:#9a9a9a;margin:0 0 16px}
  a.btn{display:inline-block;background:#ff3d3d;color:#fff;text-decoration:none;
    padding:10px 18px;border-radius:9px;font-weight:600}
  .ok{color:#00d4a0;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function isValidCode(code: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
}

// Step 1: extension opens /auth?code=<uuid> — shows the Google sign-in button.
export function authPage(req: Request, res: Response): void {
  const code = String(req.query.code || "");
  if (!isValidCode(code)) {
    res.status(400).send(page("Invalid", "<h1>Invalid link</h1><p>Start sign-in from the extension again.</p>"));
    return;
  }
  res.send(
    page(
      "Sign in",
      `<h1>Sign in to Isolate</h1>
       <p>Continue to Google to link this browser extension to your account.</p>
       <a class="btn" href="/auth/google?code=${encodeURIComponent(code)}">Sign in with Google</a>`
    )
  );
}

// Step 2: redirect to Google consent with the extension's code as state.
export function googleStart(req: Request, res: Response): void {
  const code = String(req.query.code || "");
  if (!isValidCode(code) || !config.googleClientId) {
    res.status(400).send(page("Error", "<h1>Sign-in unavailable</h1><p>Server OAuth is not configured.</p>"));
    return;
  }
  res.redirect(googleAuthUrl(code));
}

// Step 3: exchange the OAuth code, upsert the user, park the token for polling.
export async function googleCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.state || "");
  const oauthCode = String(req.query.code || "");
  const oauthError = String(req.query.error || "");
  if (oauthError || !isValidCode(code) || !oauthCode) {
    res.status(400).send(page("Error", "<h1>Sign-in failed</h1><p>Try again from the extension.</p>"));
    return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: oauthCode,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.publicUrl + "/auth/google/callback",
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error("token exchange failed");
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token) throw new Error("no id_token");
    const payload = JSON.parse(
      Buffer.from(tokenJson.id_token.split(".")[1], "base64url").toString("utf8")
    ) as { sub?: string; email?: string; name?: string; picture?: string };
    if (!payload.sub || !payload.email) throw new Error("incomplete profile");
    const profile = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
    };

    const user = await upsertAndIssueToken(profile);

    const d = await getDb();
    await collections(d).authCodes.insertOne({
      code,
      token: user.token,
      email: profile.email,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    res.send(
      page(
        "Signed in",
        `<h1 class="ok">Signed in as ${escapeHtml(profile.email)}</h1>
         <p>You can close this tab and return to the Isolate extension.</p>`
      )
    );
  } catch (e) {
    res.status(500).send(page("Error", "<h1>Sign-in failed</h1><p>Try again from the extension.</p>"));
  }
}

async function upsertAndIssueToken(profile: {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}): Promise<{ token: string }> {
  const user = await upsertGoogleUser(profile);
  const d = await getDb();
  const token = newToken();
  await collections(d).tokens.insertOne({
    tokenHash: sha256(token),
    userId: user._id,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });
  return { token };
}

// Step 4: extension polls until the token appears; one-time read.
export async function authPoll(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code || "");
  if (!isValidCode(code)) {
    res.status(400).json({ error: "invalid code" });
    return;
  }
  const d = await getDb();
  const { authCodes } = collections(d);
  const doc = await authCodes.findOneAndDelete({ code });
  if (!doc) {
    res.json({ status: "pending" });
    return;
  }
  res.json({ status: "ok", token: doc.token, email: doc.email });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    const d = await getDb();
    await collections(d).tokens.deleteOne({ tokenHash: sha256(token) });
  }
  res.json({ ok: true });
}

// Account + live usage snapshot for the popup.
export async function me(req: Request, res: Response): Promise<void> {
  const identity = res.locals.identity as Identity;
  if (!identity.user) {
    res.status(401).json({ error: "Sign in to continue", code: "auth_required" });
    return;
  }
  const { usageFor } = await import("./usage.js");
  const usage = await usageFor(identity.key);
  const limits = identity.user.limits;
  res.json({
    email: identity.user.email,
    name: identity.user.name,
    picture: identity.user.picture || null,
    enabled: identity.user.enabled !== false,
    limits,
    usage: {
      day: usage?.day || null,
      audioSeconds: usage?.audioSeconds || 0,
      separations: usage?.separations || 0,
    },
    resetAt: nextMidnightIso(),
  });
}

function nextMidnightIso(): string {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c
  );
}
