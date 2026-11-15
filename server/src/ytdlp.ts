import { spawn } from "node:child_process";

const YT_DLP_ARGS = [
  "-f", "bestaudio[ext=m4a]/bestaudio",
  "--no-warnings",
  "--no-playlist",
];

function cookieArgs(): string[] {
  const cookies = process.env.YT_DLP_COOKIES || "";
  return cookies ? ["--cookies", cookies] : [];
}

export interface ResolvedAudio {
  url: string;
  duration: number;
}

export function resolveAudio(videoId: string): Promise<ResolvedAudio> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      ...YT_DLP_ARGS,
      ...cookieArgs(),
      "--print", "%(url)s",
      "--print", "%(duration)s",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp timed out"));
    }, 90000);
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp not available: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = err.trim().split("\n").pop() || `yt-dlp exit ${code}`;
        reject(new Error(tail));
        return;
      }
      const lines = out.trim().split("\n").filter((l) => l.trim());
      if (!lines.length || !lines[0].startsWith("http")) {
        reject(new Error("yt-dlp returned no direct URL"));
        return;
      }
      const duration = Number(lines[1]) || 0;
      resolve({ url: lines[0], duration });
    });
  });
}

export function spawnFfmpegPcm(url: string, from = 0, to = 0) {
  const args: string[] = [
    "-hide_banner", "-loglevel", "error",
    "-user_agent", "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
  ];
  if (from > 0) args.push("-ss", String(from));
  if (to > from) args.push("-t", String(to - from));
  args.push("-i", url, "-ac", "2", "-ar", "44100", "-f", "s16le", "-");
  return spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
}

export function spawnFfmpegMp3(url: string) {
  return spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-user_agent", "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
    "-i", url,
    "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "-",
  ], { stdio: ["ignore", "pipe", "inherit"] });
}

export function isValidVideoId(videoId: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}
