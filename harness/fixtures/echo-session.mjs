import { createInterface } from "node:readline";

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

process.stdout.write("CIH_READY\n");

rl.on("line", (line) => {
  const pingMatch = line.match(/^PING\s+(\S+)$/);
  if (pingMatch) {
    process.stdout.write(`CIH_ECHO ${pingMatch[1]}\n`);
    return;
  }

  const exitMatch = line.match(/^EXIT\s+(-?\d+)$/);
  if (exitMatch) {
    const code = parseInt(exitMatch[1], 10);
    process.stdout.write(`CIH_EXIT ${code}\n`, () => {
      rl.close();
      process.exit(code);
    });
    return;
  }

  process.stdout.write(`CIH_UNKNOWN ${line}\n`);
});
