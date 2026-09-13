#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { contentHash } from "@firsthand/core";
import { parseExport } from "./index.js";

/**
 * firsthand-import <chatgpt|claude> <conversations.json>
 * Prints one JSON line per conversation: id, title, message count, content hash — a dry run of what
 * `firsthand-mcp deposit --from-export` would mint. No keys involved.
 */
function main(argv: string[]): number {
  const [source, file] = argv;
  if ((source !== "chatgpt" && source !== "claude") || !file) {
    console.error("usage: firsthand-import <chatgpt|claude> <conversations.json>");
    return 2;
  }
  let count = 0;
  for (const item of parseExport(source, readFileSync(file, "utf8"))) {
    count++;
    console.log(
      JSON.stringify({
        id: item.conversation.id,
        title: item.conversation.title,
        messages: item.conversation.messages.length,
        h: contentHash(item.datum),
        attestationClass: item.attestation.class,
      }),
    );
  }
  console.error(`${count} conversation(s)`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
