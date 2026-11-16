// Terminal narration: section titles, plain-language explanations, checks and links. Colors only on a TTY.
import { createInterface } from "node:readline/promises";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const red = wrap("31");
export const yellow = wrap("33");
export const cyan = wrap("36");

const out = (s = "") => console.log(s);

/** Wraps text to the terminal width with an indent. */
function para(text: string, indent: string): string {
  const width = Math.min(process.stdout.columns || 100, 100) - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

/** A numbered or titled section. */
export function section(title: string) {
  out();
  out(bold(cyan(title)));
}

/** A big act header for the demo. */
export function act(title: string, subtitle?: string) {
  const bar = "=".repeat(Math.min(process.stdout.columns || 80, 80));
  out();
  out(cyan(bar));
  out(bold(`  ${title}`));
  if (subtitle) out(dim(para(subtitle, "  ")));
  out(cyan(bar));
}

/** A plain-language sentence for a non-technical viewer. */
export function say(text: string) {
  out(para(text, "   "));
}

export function step(text: string) {
  out(dim(`     ${text}`));
}

export function ok(text: string) {
  out(`  ${green("ok")}   ${text}`);
}

export function warn(text: string) {
  out(`  ${yellow("!!")}   ${text}`);
}

export function link(label: string, url: string) {
  out(`   ${label.padEnd(10)} ${cyan(url)}`);
}

export function kv(key: string, value: string) {
  out(`   ${dim(key.padEnd(14))} ${value}`);
}

export const blank = () => out();

/** Waits for Enter when interactive; no-op with --no-pause or without a TTY. */
export async function pause(enabled: boolean, prompt = "Press Enter to continue") {
  if (!enabled || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(dim(`\n   [${prompt}] `));
  rl.close();
}

export const usd = (base: bigint | number) => `$${(Number(base) / 1_000_000).toFixed(2)}`;
export const short = (address: string) => `${address.slice(0, 4)}...${address.slice(-4)}`;
