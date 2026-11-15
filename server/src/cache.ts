import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.env.STEMS_DIR || path.join(process.cwd(), "stems");
const maxBytes = Number(process.env.CACHE_MAX_MB || 2048) * 1024 * 1024;

const vocalsPath = (videoId: string) => path.join(root, videoId, "vocals.m4a");
const bgmPath = (videoId: string) => path.join(root, videoId, "bgm.m4a");

export function hasCached(videoId: string): boolean {
  try {
    return fs.existsSync(vocalsPath(videoId)) && fs.existsSync(bgmPath(videoId));
  } catch {
    return false;
  }
}

export function vocalsFile(videoId: string): string {
  return vocalsPath(videoId);
}

export function bgmFile(videoId: string): string {
  return bgmPath(videoId);
}

export function touch(videoId: string): void {
  try {
    const now = new Date();
    fs.utimesSync(vocalsPath(videoId), now, now);
    fs.utimesSync(bgmPath(videoId), now, now);
  } catch {}
}

export async function store(videoId: string, vocalsPcm: Buffer, bgmPcm: Buffer): Promise<void> {
  const dir = path.join(root, videoId);
  fs.mkdirSync(dir, { recursive: true });
  const vTmp = vocalsPath(videoId) + ".tmp";
  const bTmp = bgmPath(videoId) + ".tmp";
  await encodeAac(vocalsPcm, vTmp);
  await encodeAac(bgmPcm, bTmp);
  fs.renameSync(vTmp, vocalsPath(videoId));
  fs.renameSync(bTmp, bgmPath(videoId));
  evict(videoId);
}

function encodeAac(pcm: Buffer, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
      "-c:a", "aac", "-b:a", "160k",
      "-f", "ipod", outPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", (e) => reject(new Error(`ffmpeg encode failed: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      try { fs.unlinkSync(outPath); } catch {}
      reject(new Error(`ffmpeg encode failed: ${err.trim().split("\n").pop() || code}`));
    });
    proc.stdin.end(pcm);
  });
}

export function decodePcmStream(filePath: string) {
  return spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", filePath,
    "-f", "f32le", "-ac", "2", "-ar", "44100", "-",
  ], { stdio: ["ignore", "pipe", "ignore"] });
}

function dirSize(): number {
  let total = 0;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const id of ids) {
    for (const f of ["vocals.m4a", "bgm.m4a"]) {
      try { total += fs.statSync(path.join(root, id, f)).size; } catch {}
    }
  }
  return total;
}

function evict(currentId: string): void {
  let total = dirSize();
  if (total <= maxBytes) return;
  let entries: { id: string; mtime: number }[] = [];
  try {
    entries = fs
      .readdirSync(root)
      .map((id) => {
        try {
          return { id, mtime: fs.statSync(vocalsPath(id)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { id: string; mtime: number } => x !== null);
  } catch {
    return;
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    if (entry.id === currentId) continue;
    try {
      fs.rmSync(path.join(root, entry.id), { recursive: true, force: true });
      total -= 12 * 1024 * 1024;
    } catch {}
  }
}
