// A guide imported as text (`with { type: "text" }`): bun inlines it, compiled binary included.
declare module "*.md" {
  const text: string;
  export default text;
}
