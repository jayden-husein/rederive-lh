// Prints the history + structure summary the map worker will see, for eyeballing.
// Usage: npm run summary -- "<repo folder>"   (UNC paths into WSL work too)
import { summarizeRepo } from "../src/history.ts";

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run summary -- "<repo folder>"');
  process.exit(2);
}
console.log(await summarizeRepo(target));
