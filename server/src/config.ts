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
};

export const segmentFrames = config.segmentSeconds * config.sampleRate;
export const overlapFrames = config.overlapSeconds * config.sampleRate;
export const fadeFrames = config.fadeSeconds * config.sampleRate;
export const bytesPerFrame = 4;
export const segmentBytes = segmentFrames * bytesPerFrame;
export const overlapBytes = overlapFrames * bytesPerFrame;
