#!/usr/bin/env node

import { spawn } from "node:child_process";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PLAYER_CLIENT_PATTERN = /^[a-z0-9_]+(?:,[a-z0-9_]+)*$/;
const MAX_PLAYER_CLIENT_LENGTH = 128;

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--source-id" || !SOURCE_ID_PATTERN.test(args[1] ?? "")) {
  process.stderr.write("invalid source id\n");
  process.exitCode = 2;
} else {
  const sourceId = args[1];
  const binary = process.env.YT_DLP_BIN;
  if (typeof binary !== "string" || binary.trim().length === 0 || binary.length > 2_048 || /[\u0000\r\n]/.test(binary)) {
    process.stderr.write("yt-dlp binary is not configured\n");
    process.exitCode = 2;
  } else {
    const playerClient = process.env.YT_DLP_PLAYER_CLIENT;
    if (playerClient !== undefined && playerClient !== "" && (playerClient.length > MAX_PLAYER_CLIENT_LENGTH || !PLAYER_CLIENT_PATTERN.test(playerClient))) {
      process.stderr.write("invalid YT_DLP_PLAYER_CLIENT\n");
      process.exitCode = 2;
    } else {
      const childArgs = [
        "--ignore-config",
        "--no-playlist",
        "-f",
        "bestaudio[protocol*=m3u8]/bestaudio/best",
        "-o",
        "-",
      ];
      if (playerClient !== undefined && playerClient !== "") {
        childArgs.push("--extractor-args", `youtube:player_client=${playerClient}`);
      }
      childArgs.push(`https://www.youtube.com/watch?v=${sourceId}`);

      const child = spawn(binary, childArgs, {
        shell: false,
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.once("error", () => {
        process.stderr.write("yt-dlp failed to start\n");
        process.exitCode = 1;
      });
      child.stdout.pipe(process.stdout);
      child.once("close", (code) => {
        if (code !== 0 && process.exitCode === undefined) process.exitCode = 1;
      });
    }
  }
}
