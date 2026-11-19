import { DEFAULT_OPERATOR_SOCKET } from "./config.js";
import { runOperatorCommand } from "./operator-cli.js";

const code = await runOperatorCommand(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  socketPath: process.env.OPERATOR_SOCKET ?? DEFAULT_OPERATOR_SOCKET,
});
process.exit(code);
