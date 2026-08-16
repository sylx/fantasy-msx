// Browser entry point for the example.

import { run } from "../src/index.js";
import { game } from "./game.js";

run(game, { canvas: document.querySelector("canvas") as HTMLCanvasElement });
