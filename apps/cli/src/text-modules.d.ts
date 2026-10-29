// A guide page imported as text (`with { type: "text" }`): bun inlines it, compiled binary included.
declare module "*.mdx" {
  const text: string;
  export default text;
}
// A skill imported as text, the same way.
declare module "*.md" {
  const text: string;
  export default text;
}
