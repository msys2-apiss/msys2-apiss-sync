import { parseArgs } from "./args.js";
import { printResults, runChecker } from "./runner.js";

const args = parseArgs(process.argv.slice(2));
const code = printResults(runChecker(args));
process.exit(code);
