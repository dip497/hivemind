/** A file read in as text at build (`import text from "./file?raw"`). */
declare module "*?raw" {
  const text: string;
  export default text;
}
