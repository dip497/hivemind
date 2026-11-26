/** The sidecar's process: questions on stdin, answers on stdout. */
import { serveSidecar } from "./sidecar.js";

serveSidecar(process.stdin, process.stdout);
